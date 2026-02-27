import http from "http";
import { describe, it, expect, vi } from "vitest";
import { handlePageQueryRequest, handleTelegramWebhookRequest, checkBasicAuth } from "./index.js";
import type { Pool, QueryResult } from "pg";
import type { TelegramConfig } from "./config.js";

// Minimal mock of http.IncomingMessage with only the fields the handler reads.
function makeMockRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers, url: "/api/pages/mypage/queries/myquery" } as unknown as http.IncomingMessage;
}

// Minimal mock of http.ServerResponse that captures the status code and body.
interface MockResponse {
  statusCode: number | undefined;
  body: string | undefined;
  writeHead: (status: number) => void;
  end: (body: string) => void;
}

function makeMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCode: undefined,
    body: undefined,
    writeHead(status: number): void {
      this.statusCode = status;
    },
    end(body: string): void {
      this.body = body;
    },
  };
  return response;
}

// Build a mock Pool whose query() returns rows shaped the way getPageQueryByPath expects.
// The first call returns the page row; subsequent calls (for the actual SQL) are not
// expected in the auth-failure path, but we provide a fallback for the public-page path.
function makeMockPool(isPublic: boolean): Pool {
  const pageRow = { query: "SELECT 1", is_public: isPublic };
  const pool = {
    query: vi.fn().mockImplementation(() =>
      Promise.resolve({ rows: [pageRow], command: "SELECT", rowCount: 1 } as unknown as QueryResult),
    ),
  };
  return pool as unknown as Pool;
}

describe("handlePageQueryRequest auth enforcement", () => {
  const pathname = "/api/pages/mypage/queries/myquery";
  const password = "secret";
  const url = new URL("http://localhost/api/pages/mypage/queries/myquery");

  it("returns 401 for a private page when no auth header is provided", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();
    const pool = makeMockPool(false);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for a private page when wrong password is provided", async () => {
    const credentials = Buffer.from("user:wrongpassword").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    const response = makeMockResponse();
    const pool = makeMockPool(false);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    expect(response.statusCode).toBe(401);
  });

  it("does not return 401 for a public page when no auth header is provided", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();
    const pool = makeMockPool(true);

    await handlePageQueryRequest(
      request,
      response as unknown as http.ServerResponse,
      pathname,
      password,
      pool,
      url,
    );

    // Auth was not enforced — the handler proceeded past the auth check.
    // It ran the query and returned 200.
    expect(response.statusCode).not.toBe(401);
  });
});

describe("checkBasicAuth", () => {
  it("returns false when no authorization header is present", () => {
    const request = makeMockRequest();
    expect(checkBasicAuth(request, "secret")).toBe(false);
  });

  it("returns false when the password is wrong", () => {
    const credentials = Buffer.from("user:wrong").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    expect(checkBasicAuth(request, "secret")).toBe(false);
  });

  it("returns true when the correct password is provided", () => {
    const credentials = Buffer.from("user:secret").toString("base64");
    const request = makeMockRequest({ authorization: `Basic ${credentials}` });
    expect(checkBasicAuth(request, "secret")).toBe(true);
  });
});

describe("handleTelegramWebhookRequest secret verification", () => {
  const telegramConfig: TelegramConfig = {
    botToken: "test-token",
  };
  const webhookSecret = "test-secret-uuid";

  it("returns 403 when the secret header is missing", async () => {
    const request = makeMockRequest();
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).toBe(403);
  });

  it("returns 403 when the secret header is wrong", async () => {
    const request = makeMockRequest({ "x-telegram-bot-api-secret-token": "wrong-secret" });
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).toBe(403);
  });

  it("does not return 403 when the correct secret header is provided", async () => {
    const request = {
      headers: { "x-telegram-bot-api-secret-token": webhookSecret },
      url: "/telegram/webhook",
      [Symbol.asyncIterator]: async function* () { yield Buffer.from('{"message":{"chat":{"id":999},"text":"hi"}}'); },
    } as unknown as http.IncomingMessage;
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      telegramConfig,
      webhookSecret,
    );

    expect(response.statusCode).not.toBe(403);
  });

  it("returns 404 when telegramConfig is undefined", async () => {
    const request = makeMockRequest({ "x-telegram-bot-api-secret-token": webhookSecret });
    const response = makeMockResponse();

    await handleTelegramWebhookRequest(
      request,
      response as unknown as http.ServerResponse,
      undefined,
      webhookSecret,
    );

    expect(response.statusCode).toBe(404);
  });
});
