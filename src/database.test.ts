import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Pool, QueryResult } from "pg";

// Mock config and log dependencies so the module loads without real infrastructure.
vi.mock("./config.js", () => ({
  loadPostgresConfig: vi.fn().mockReturnValue({}),
  OWNER_CHANNELS: [],
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./toon.js", () => ({
  encodeToToon: vi.fn(),
}));
vi.mock("fs");

import fs from "fs";
import { resolveInterlocutor, seedOwner, seedCronEntries } from "./database.js";
import type { OwnerConfig } from "./config.js";

// Seed the owner so getOwnerInterlocutorId() doesn't throw. The mock pool
// returns a stable owner ID of 42 for all tests in this file.
const OWNER_ID = 42;

beforeAll(async () => {
  const seedPool = {
    query: vi.fn().mockImplementation((text: string) => {
      if (typeof text === "string" && text.includes("INSERT INTO agents")) {
        return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (typeof text === "string" && text.includes("SELECT id FROM interlocutors WHERE owner")) {
        return Promise.resolve({ rows: [{ id: OWNER_ID }], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    }),
  } as unknown as Pool;
  const ownerConfig: OwnerConfig = { name: "Test Owner" };
  await seedOwner(seedPool, ownerConfig);
});

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

describe("resolveInterlocutor — email wildcard matching", () => {
  it("matches a wildcard pattern *@example.com against user@example.com", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 1,
            identity_id: 10,
            agent_id: 5,
            display_name: "Example Corp",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(1);
    expect(result?.identityId).toBe(10);
    expect(result?.agentId).toBe(5);
    expect(result?.displayName).toBe("Example Corp");
  });

  it("does not match *@example.com against user@other.com", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 1,
            identity_id: 10,
            agent_id: 5,
            display_name: "Example Corp",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    // The SQL LIKE filter already excludes this, but we simulate a row being returned
    // to verify the application-level matchesEmailEntry check also rejects it.
    const result = await resolveInterlocutor(pool, "email", "user@other.com");
    expect(result).toBeNull();
  });

  it("matches an exact email address", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 2,
            identity_id: 20,
            agent_id: 7,
            display_name: "Alice",
            identifier: "alice@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "alice@example.com");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(2);
  });

  it("returns null when no rows match the domain filter", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "nobody@nowhere.com");
    expect(result).toBeNull();
  });

  it("returns null when the matched interlocutor has no agent_id", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 3,
            identity_id: 30,
            agent_id: null,
            display_name: "Unassigned",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result).toBeNull();
  });

  it("uses the first matching row when multiple identities match", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 4,
            identity_id: 40,
            agent_id: 8,
            display_name: "First",
            identifier: "*@example.com",
          },
          {
            interlocutor_id: 5,
            identity_id: 50,
            agent_id: 9,
            display_name: "Second",
            identifier: "user@example.com",
          },
        ],
        rowCount: 2,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "user@example.com");
    expect(result?.interlocutorId).toBe(4);
  });

  it("passes the domain as the SQL parameter", async () => {
    let capturedValues: unknown[] | undefined;
    const pool = makeMockPool((_, values) => {
      capturedValues = values;
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
    await resolveInterlocutor(pool, "email", "sender@mail.example.com");
    expect(capturedValues).toEqual(["mail.example.com"]);
  });

  it("is case-insensitive when matching email patterns", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 6,
            identity_id: 60,
            agent_id: 11,
            display_name: "Case Test",
            identifier: "*@example.com",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "email", "User@EXAMPLE.COM");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(6);
  });
});

describe("resolveInterlocutor — non-email services (exact match)", () => {
  it("returns the interlocutor for an exact signal match", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 7,
            identity_id: 70,
            agent_id: 12,
            display_name: "Signal User",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+1234567890");
    expect(result).not.toBeNull();
    expect(result?.interlocutorId).toBe(7);
  });

  it("returns null when no signal identity matches", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+9999999999");
    expect(result).toBeNull();
  });

  it("returns null when the signal interlocutor has no agent_id", async () => {
    const pool = makeMockPool(() =>
      Promise.resolve({
        rows: [
          {
            interlocutor_id: 8,
            identity_id: 80,
            agent_id: null,
            display_name: "No Agent",
          },
        ],
        rowCount: 1,
      } as unknown as QueryResult),
    );
    const result = await resolveInterlocutor(pool, "signal", "+1234567890");
    expect(result).toBeNull();
  });
});

describe("seedCronEntries", () => {
  const readFileSyncMock = vi.mocked(fs.readFileSync);

  it("inserts a new cron entry when none exists", async () => {
    readFileSyncMock.mockReturnValue("do the nightly review");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      // SELECT returns no existing rows.
      if (text.includes("SELECT")) {
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO cron_entries"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery?.values[0]).toBe("0 3 * * *");
    expect(insertQuery?.values[1]).toBe("[nightly-review] do the nightly review");
  });

  it("updates an existing entry when the note has changed", async () => {
    readFileSyncMock.mockReturnValue("updated prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ id: 99, note: "[nightly-review] old prompt text" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery?.values[0]).toBe("[nightly-review] updated prompt text");
    expect(updateQuery?.values[1]).toBe(99);
  });

  it("does not update when the note is already up to date", async () => {
    readFileSyncMock.mockReturnValue("same prompt");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        // Return a matching up-to-date row for whichever marker is being queried.
        const likeParam = (values ?? [])[0] as string;
        const marker = likeParam.replace(/%$/, "");
        return Promise.resolve({
          rows: [{ id: 5, note: `${marker} same prompt` }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeUndefined();
    const insertQuery = queries.find((q) => q.text.includes("INSERT INTO cron_entries"));
    expect(insertQuery).toBeUndefined();
  });

  it("skips update when the existing note starts with the manual freeze prefix", async () => {
    readFileSyncMock.mockReturnValue("new prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        // Return a manually-frozen row for whichever marker is being queried.
        const likeParam = (values ?? [])[0] as string;
        const marker = likeParam.replace(/%$/, "");
        return Promise.resolve({
          rows: [{ id: 7, note: `${marker}[manual] custom frozen note` }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeUndefined();
  });

  it("does not skip when [manual] appears in the note body but not as the freeze prefix", async () => {
    readFileSyncMock.mockReturnValue("new prompt text");
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ id: 8, note: "[nightly-review] some [manual] note body" }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 1 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    // The note differs from the built note, so an update should be issued.
    const updateQuery = queries.find((q) => q.text.includes("UPDATE cron_entries"));
    expect(updateQuery).toBeDefined();
  });

  it("logs a warning and skips when the prompt file is missing", async () => {
    const enoentError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readFileSyncMock.mockImplementation(() => { throw enoentError; });
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = makeMockPool((text, values) => {
      queries.push({ text, values: values ?? [] });
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await seedCronEntries(pool);

    // No DB writes should have occurred.
    const writeQuery = queries.find((q) => q.text.includes("INSERT") || q.text.includes("UPDATE"));
    expect(writeQuery).toBeUndefined();
  });

  it("re-throws non-ENOENT errors from readFileSync", async () => {
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });
    readFileSyncMock.mockImplementation(() => { throw permissionError; });
    const pool = makeMockPool(() => Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult));

    await expect(seedCronEntries(pool)).rejects.toThrow("EACCES");
  });
});
