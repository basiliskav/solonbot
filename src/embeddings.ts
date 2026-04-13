import pg from "pg";
import type { Config } from "./config.js";
import { getMainAgentId } from "./database.js";
import { log } from "./log.js";

const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;
const PRE_PASS_LIMIT = 100;
const TEXT_TRUNCATION_LIMIT = 4000;
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const ZERO_VECTOR = `[${Array(EMBEDDING_DIMENSIONS).fill(0).join(",")}]`;

interface ContentPart {
  type: string;
  text?: string;
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

export class EmbeddingApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingApiError";
  }
}

// Exported so Task 4 (search) can reuse it to embed query strings.
export async function fetchEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new EmbeddingApiError(response.status, `OpenAI embeddings API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json() as OpenAIEmbeddingResponse;
  // The API returns embeddings in the same order as the input, but we sort by
  // index defensively to match each embedding to its source text.
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((item) => item.embedding);
}

export function extractText(content: unknown): string {
  // User messages may store content as a plain string.
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return (content as ContentPart[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

async function tick(pool: pg.Pool, apiKey: string, mainAgentId: number, onSuccess: () => void, onError: () => void): Promise<void> {
  // Pre-pass: scan the next PRE_PASS_LIMIT un-embedded messages and zero-vector
  // any that have no text content (e.g. pure tool_use assistant messages). This
  // ensures the subsequent BATCH_SIZE fetch is filled with embeddable messages.
  const prePassResult = await pool.query<{ id: number; content: unknown }>(
    `SELECT m.id, m.content
     FROM messages m
     LEFT JOIN message_embeddings me ON me.message_id = m.id
     WHERE m.role IN ('user', 'assistant')
       AND me.message_id IS NULL
       AND m.agent_id = $2
     ORDER BY m.id ASC
     LIMIT $1`,
    [PRE_PASS_LIMIT, mainAgentId],
  );

  if (prePassResult.rows.length === 0) {
    return;
  }

  let zeroVectorCount = 0;
  for (const row of prePassResult.rows) {
    const raw = (row.content as { content?: unknown }).content ?? row.content;
    const text = extractText(raw);
    if (text.length === 0) {
      await pool.query(
        "INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [row.id, ZERO_VECTOR],
      );
      zeroVectorCount++;
    }
  }

  if (zeroVectorCount > 0) {
    log.info(`[solonbot] Embeddings worker: zero-vectored ${zeroVectorCount} message(s) with no text content`);
  }

  // Main batch: fetch up to BATCH_SIZE messages that now have text (empties
  // were just marked above and won't appear here).
  const result = await pool.query<{ id: number; content: unknown }>(
    `SELECT m.id, m.content
     FROM messages m
     LEFT JOIN message_embeddings me ON me.message_id = m.id
     WHERE m.role IN ('user', 'assistant')
       AND me.message_id IS NULL
       AND m.agent_id = $2
     ORDER BY m.id ASC
     LIMIT $1`,
    [BATCH_SIZE, mainAgentId],
  );

  if (result.rows.length === 0) {
    onSuccess();
    return;
  }

  log.info(`[solonbot] Embeddings worker: processing ${result.rows.length} message(s)`);

  const withText: Array<{ messageId: number; text: string }> = [];
  for (const row of result.rows) {
    const raw = (row.content as { content?: unknown }).content ?? row.content;
    const text = extractText(raw).slice(0, TEXT_TRUNCATION_LIMIT);
    // Defensive: the pre-pass should have cleared all empties, but skip any
    // that slip through rather than sending an empty string to OpenAI.
    if (text.length === 0) {
      continue;
    }
    withText.push({ messageId: row.id, text });
  }

  if (withText.length === 0) {
    onSuccess();
    return;
  }

  let batchEmbeddings: number[][] | null = null;
  try {
    batchEmbeddings = await fetchEmbeddings(withText.map((m) => m.text), apiKey);
  } catch (error) {
    if (error instanceof EmbeddingApiError && error.status === 400) {
      // A 400 from the batch call means at least one input is poisonous. Fall
      // back to one-by-one so we can isolate and quarantine the bad message(s)
      // with a zero vector rather than blocking forever.
      log.warn("[solonbot] Embeddings worker: batch 400 error, falling back to one-by-one:", error.message);
      for (const entry of withText) {
        let singleEmbeddings: number[][];
        try {
          singleEmbeddings = await fetchEmbeddings([entry.text], apiKey);
        } catch (singleError) {
          if (singleError instanceof EmbeddingApiError && singleError.status === 400) {
            log.warn(`[solonbot] Embeddings worker: message ${entry.messageId} rejected by API (400), inserting zero vector`);
            await pool.query(
              "INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [entry.messageId, ZERO_VECTOR],
            );
          } else {
            // Non-400 error (401, 403, 429, 5xx, network). Stop the loop and back off;
            // remaining messages will be retried on the next tick.
            log.error("[solonbot] Embeddings worker: transient error during one-by-one fallback:", singleError);
            onError();
            return;
          }
          continue;
        }
        const vectorLiteral = `[${singleEmbeddings[0].join(",")}]`;
        await pool.query(
          "INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [entry.messageId, vectorLiteral],
        );
      }
    } else {
      log.error("[solonbot] Embeddings worker: OpenAI API error:", error);
      onError();
      return;
    }
  }

  if (batchEmbeddings !== null) {
    for (let i = 0; i < withText.length; i++) {
      const messageId = withText[i].messageId;
      const embedding = batchEmbeddings[i];
      // Format the vector as a Postgres-compatible literal: '[x,y,z,...]'
      const vectorLiteral = `[${embedding.join(",")}]`;
      await pool.query(
        "INSERT INTO message_embeddings (message_id, embedding) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [messageId, vectorLiteral],
      );
    }
  }

  log.info(`[solonbot] Embeddings worker: embedded ${withText.length} message(s) via OpenAI`);
  onSuccess();
}

export function initializeEmbeddingsWorker(pool: pg.Pool, config: Config): void {
  if (config.embeddings === undefined) {
    return;
  }

  const apiKey = config.embeddings.apiKey;
  const mainAgentId = getMainAgentId();
  let currentIntervalMs = POLL_INTERVAL_MS;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  function scheduleNext(intervalMs: number): void {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
    }
    intervalHandle = setInterval(() => {
      void tick(
        pool,
        apiKey,
        mainAgentId,
        () => {
          if (currentIntervalMs !== POLL_INTERVAL_MS) {
            currentIntervalMs = POLL_INTERVAL_MS;
            scheduleNext(currentIntervalMs);
          }
        },
        () => {
          const next = Math.min(currentIntervalMs * 2, MAX_BACKOFF_MS);
          if (next !== currentIntervalMs) {
            currentIntervalMs = next;
            log.info(`[solonbot] Embeddings worker: backing off to ${currentIntervalMs / 1000}s`);
            scheduleNext(currentIntervalMs);
          }
        },
      );
    }, intervalMs);
  }

  scheduleNext(currentIntervalMs);
  log.info("[solonbot] Embeddings worker initialized.");
}
