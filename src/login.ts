import http from "http";
import fs from "fs";
import path from "path";
import { getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { getBaseStyles } from "./theme.js";

// Module-level state for the pending prompt resolver. Safe because this is a
// single-user bot — only one login flow runs at a time.
let pendingPromptResolver: ((value: string) => void) | null = null;

// Module-level state for the active login flow. Used to cancel an in-progress
// flow when a new SSE connection arrives, so the library's callback server on
// port 53692 is closed before the new flow tries to bind the same port.
let loginAbortReject: ((error: Error) => void) | null = null;
let activeLoginPromise: Promise<void> | null = null;
let loginCancelled = false;
// Monotonically increasing counter so stale disconnect handlers from an old
// flow cannot accidentally clear state that belongs to a newer flow.
let loginFlowCounter = 0;

function buildLoginPageHtml(providerName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Log in with ${providerName}</title>
  <style>
    ${getBaseStyles()}
    body {
      max-width: 480px;
      margin: 80px auto;
      padding: 0 24px;
      line-height: 1.5;
    }
    p { color: var(--color-text-secondary); margin-bottom: 16px; }
    a { color: var(--color-accent); text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      margin: 8px 0 16px;
      font-size: 1em;
      border: 1px solid var(--color-border);
      border-radius: 6px;
      background: var(--color-surface);
      color: var(--color-text);
    }
    button {
      padding: 12px 24px;
      font-size: 1em;
      cursor: pointer;
      background: var(--color-accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-weight: 500;
    }
    button:hover { background: var(--color-accent-hover); }
    #status { margin-top: 20px; color: var(--color-text-secondary); }
    #prompt-section { display: none; }
    #auth-section { display: none; }
  </style>
</head>
<body>
  <h1>Log in with ${providerName}</h1>
  <div id="status">Connecting...</div>
  <div id="auth-section">
    <p id="auth-link-container"></p>
    <p id="auth-instructions"></p>
    <p>
      Important: after login, you might see an error page. This is expected.
      If that happens, copy the full URL from your browser address bar and paste it into the box below when prompted.
    </p>
  </div>
  <div id="prompt-section">
    <p id="prompt-message"></p>
    <input type="text" id="prompt-input" autofocus placeholder="Paste the full redirect URL (or code) here" />
    <button onclick="submitPrompt()">Submit</button>
  </div>
  <script>
    const evtSource = new EventSource("/login/events");

    evtSource.addEventListener("auth", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "";
      const section = document.getElementById("auth-section");
      section.style.display = "block";
      const container = document.getElementById("auth-link-container");
      const link = document.createElement("a");
      link.href = data.url;
      link.target = "_blank";
      link.textContent = "Open this link to log in";
      container.innerHTML = "";
      container.appendChild(link);
      const instructionsEl = document.getElementById("auth-instructions");
      instructionsEl.textContent = data.instructions || "";
    });

    evtSource.addEventListener("prompt", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "";
      const section = document.getElementById("prompt-section");
      section.style.display = "block";
      document.getElementById("prompt-message").textContent = data.message;
      const input = document.getElementById("prompt-input");
      input.value = "";
      input.focus();
    });

    evtSource.addEventListener("progress", function(event) {
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = data.message;
    });

    evtSource.addEventListener("success", function(event) {
      evtSource.close();
      document.getElementById("status").textContent = "Login successful. You can close this page.";
      document.getElementById("auth-section").style.display = "none";
      document.getElementById("prompt-section").style.display = "none";
    });

    evtSource.addEventListener("error_event", function(event) {
      evtSource.close();
      const data = JSON.parse(event.data);
      document.getElementById("status").textContent = "Login failed: " + data.message;
    });

    async function submitPrompt() {
      const value = document.getElementById("prompt-input").value;
      document.getElementById("prompt-section").style.display = "none";
      document.getElementById("status").textContent = "Submitting...";
      try {
        await fetch("/login/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      } catch (error) {
        document.getElementById("status").textContent = "Request failed: " + error.message;
      }
    }
  </script>
</body>
</html>`;
}

function sendSseEvent(response: http.ServerResponse, eventName: string, data: unknown): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function serveLoginPage(response: http.ServerResponse, config: Config): void {
  const provider = getOAuthProvider(config.provider);
  const providerName = provider !== undefined ? provider.name : config.provider;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(buildLoginPageHtml(providerName));
}

export async function handleLoginEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: Config,
): Promise<void> {
  if (config.authFile === undefined) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    sendSseEvent(response, "error_event", { message: "authFile not configured" });
    response.end();
    return;
  }

  const provider = getOAuthProvider(config.provider);
  if (provider === undefined) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const validIds = getOAuthProviders().map((p) => p.id).join(", ");
    sendSseEvent(response, "error_event", { message: `Unknown OAuth provider "${config.provider}". Valid OAuth providers: ${validIds}` });
    response.end();
    return;
  }

  // If a login flow is already running, cancel it and wait for it to finish so
  // the library's callback server on port 53692 is closed before we try to bind
  // the same port again. The cancellation works by rejecting the onManualCodeInput
  // Promise, which causes the library's catch handler to call server.cancelWait(),
  // which unblocks server.waitForCode(), which then throws and reaches the
  // finally { server.server.close() } block.
  if (activeLoginPromise !== null) {
    log.debug("[stavrobot] handleLoginEvents: cancelling previous login flow");
    if (loginAbortReject !== null) {
      loginAbortReject(new Error("Login cancelled: new login flow started"));
    } else {
      // onManualCodeInput has not been called yet; set the flag so it rejects
      // immediately when it is called.
      loginCancelled = true;
    }
    try {
      await activeLoginPromise;
    } catch {
      // Expected: the previous flow was cancelled.
    }
    // Give the OS a moment to release the port before the new flow binds it.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  let isConnected = true;
  loginFlowCounter += 1;
  const flowId = loginFlowCounter;

  request.on("close", () => {
    log.debug(`[stavrobot] handleLoginEvents: client disconnected (flow ${flowId})`);
    isConnected = false;
    pendingPromptResolver = null;
    // Only cancel the active flow if this disconnect belongs to the current flow.
    // A stale handler from an old flow must not clear state for a newer flow.
    if (flowId === loginFlowCounter && loginAbortReject !== null) {
      log.debug(`[stavrobot] handleLoginEvents: aborting login flow ${flowId} on disconnect`);
      loginAbortReject(new Error("Login cancelled: client disconnected"));
    }
  });

  log.debug(`[stavrobot] handleLoginEvents: starting login flow ${flowId} for provider "${config.provider}"`);

  // Reset cancellation state for this new flow.
  loginCancelled = false;
  loginAbortReject = null;

  // These are assigned synchronously inside the Promise constructor, so they
  // are always non-null by the time the try block runs. TypeScript cannot infer
  // this, so we use non-null assertions at the call sites.
  let resolveActiveLogin!: () => void;
  let rejectActiveLogin!: (error: unknown) => void;
  activeLoginPromise = new Promise<void>((resolve, reject) => {
    resolveActiveLogin = resolve;
    rejectActiveLogin = reject;
  });

  try {
    const credentials = await provider.login({
      onAuth: (info) => {
        log.debug("[stavrobot] handleLoginEvents: onAuth called, sending auth event");
        if (isConnected) {
          sendSseEvent(response, "auth", { url: info.url, instructions: info.instructions });
        }
      },
      onPrompt: (prompt) => {
        log.debug("[stavrobot] handleLoginEvents: onPrompt called, sending prompt event");
        return new Promise<string>((resolve) => {
          pendingPromptResolver = resolve;
          if (isConnected) {
            sendSseEvent(response, "prompt", { message: prompt.message });
          }
        });
      },
      onProgress: (message) => {
        log.debug("[stavrobot] handleLoginEvents: onProgress:", message);
        if (isConnected) {
          sendSseEvent(response, "progress", { message });
        }
      },
      // Races against the provider's local callback server. In a remote deployment
      // the browser redirect hits localhost on the container, not the user's machine,
      // so the callback server never receives the code. Providing this callback lets
      // the user paste the redirect URL or code manually, whichever arrives first wins.
      onManualCodeInput: () => {
        log.debug("[stavrobot] handleLoginEvents: onManualCodeInput called, sending prompt event");
        return new Promise<string>((resolve, reject) => {
          // If the flow was already cancelled before onManualCodeInput was called,
          // reject immediately so the library closes its callback server.
          if (loginCancelled) {
            reject(new Error("Login cancelled: new login flow started"));
            return;
          }
          loginAbortReject = reject;
          pendingPromptResolver = resolve;
          if (isConnected) {
            sendSseEvent(response, "prompt", { message: "Paste the authorization code or full redirect URL from your browser:" });
          }
        });
      },
    });

    log.debug("[stavrobot] handleLoginEvents: login succeeded, saving credentials");
    pendingPromptResolver = null;

    const authFile = config.authFile;
    let existingCredentials: Record<string, OAuthCredentials> = {};
    try {
      const existing = fs.readFileSync(authFile, "utf-8");
      existingCredentials = JSON.parse(existing) as Record<string, OAuthCredentials>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    existingCredentials[config.provider] = credentials;

    const authDir = path.dirname(authFile);
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(existingCredentials, null, 2), "utf-8");

    log.debug("[stavrobot] handleLoginEvents: credentials written to", authFile);

    if (isConnected) {
      sendSseEvent(response, "success", {});
      response.end();
    }

    resolveActiveLogin();
  } catch (error) {
    pendingPromptResolver = null;
    const message = error instanceof Error ? error.message : String(error);
    log.error("[stavrobot] handleLoginEvents: login failed:", message);
    if (isConnected) {
      sendSseEvent(response, "error_event", { message });
      response.end();
    }
    rejectActiveLogin(error);
  } finally {
    // Clean up module-level state so a future flow starts fresh.
    if (flowId === loginFlowCounter) {
      loginAbortReject = null;
      activeLoginPromise = null;
      loginCancelled = false;
    }
  }
}

export async function handleLoginRespond(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("value" in parsed) ||
    typeof (parsed as Record<string, unknown>).value !== "string"
  ) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Request body must include a value string" }));
    return;
  }

  const { value } = parsed as { value: string };

  if (pendingPromptResolver === null) {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "No pending prompt" }));
    return;
  }

  log.debug("[stavrobot] handleLoginRespond: resolving pending prompt");
  const resolver = pendingPromptResolver;
  pendingPromptResolver = null;
  resolver(value);

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
}
