import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";
import { toolError, toolSuccess } from "./tool-result.js";

const FILES_DIR = path.join(TEMP_ATTACHMENTS_DIR, "files");

const HELP_TEXT = `manage_files: manage files in a temporary directory (${FILES_DIR}).

Actions:
- write: write content to a file. Parameters: filename (required), content (required), encoding ("utf-8" default or "base64"). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- read: read a file's content as utf-8 text. Parameters: filename (required). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- list: list all files in the directory. Returns absolute paths, one per line.
- delete: delete a file. Parameters: filename (required). Also accepts an absolute path under ${TEMP_ATTACHMENTS_DIR} (e.g. a plugin output file path).
- help: show this help text.

Constraints:
- Flat filenames must not contain "/" or "\\" (no subdirectories). Absolute paths must be under ${TEMP_ATTACHMENTS_DIR}.
- Files are ephemeral. They live in ${FILES_DIR} and may be deleted automatically when passed as attachmentPath to send_signal_message or send_telegram_message.
- To send a file as an attachment, pass its absolute path (returned by write or list) as the attachmentPath parameter to send_signal_message or send_telegram_message.
- No size limits are enforced.`;

function validateFilename(filename: string): string | null {
  if (filename.includes("/") || filename.includes("\\")) {
    return "Error: filename must not contain path separators ('/' or '\\\\').";
  }
  return null;
}

// Returns the resolved absolute path, or an error string if the input is invalid.
// Flat filenames resolve to FILES_DIR; absolute paths must be under TEMP_ATTACHMENTS_DIR.
function resolvePath(filename: string): { filePath: string } | { error: string } {
  if (path.isAbsolute(filename)) {
    const resolved = path.resolve(filename);
    if (!resolved.startsWith(TEMP_ATTACHMENTS_DIR + path.sep) && resolved !== TEMP_ATTACHMENTS_DIR) {
      return { error: `Error: path must be under ${TEMP_ATTACHMENTS_DIR}.` };
    }
    return { filePath: resolved };
  }
  const filenameError = validateFilename(filename);
  if (filenameError !== null) {
    return { error: filenameError };
  }
  return { filePath: path.join(FILES_DIR, filename) };
}

export function createManageFilesTool(): AgentTool {
  return {
    name: "manage_files",
    label: "Manage files",
    description: "Create and manage temporary files. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("help"),
      ], { description: "Action to perform: write, read, list, delete, or help." }),
      filename: Type.Optional(Type.String({ description: "Flat filename (no path separators) resolved to the files directory, or an absolute path under TEMP_ATTACHMENTS_DIR. Required for write, read, and delete." })),
      content: Type.Optional(Type.String({ description: "File content. Required for write." })),
      encoding: Type.Optional(Type.String({ description: "Encoding for write: 'utf-8' (default) or 'base64'." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        filename?: string;
        content?: string;
        encoding?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return toolSuccess(HELP_TEXT);
      }

      if (action === "list") {
        let filenames: string[];
        try {
          filenames = await fs.readdir(FILES_DIR);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            filenames = [];
          } else {
            throw error;
          }
        }
        const absolutePaths = filenames.map((name) => path.join(FILES_DIR, name));
        const result = absolutePaths.join("\n");
        log.debug(`[stavrobot] manage_files list: ${filenames.length} file(s)`);
        return toolSuccess(result);
      }

      if (action === "write") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for write.");
        }
        if (raw.content === undefined) {
          return toolError("Error: content is required for write.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        const encoding = raw.encoding ?? "utf-8";
        if (encoding === "base64") {
          const buffer = Buffer.from(raw.content, "base64");
          await fs.writeFile(filePath, buffer);
        } else {
          await fs.writeFile(filePath, raw.content, "utf-8");
        }

        log.debug(`[stavrobot] manage_files write: ${filePath}`);
        return toolSuccess(filePath);
      }

      if (action === "read") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for read.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;

        const fileContent = await fs.readFile(filePath, "utf-8");
        log.debug(`[stavrobot] manage_files read: ${filePath} (${fileContent.length} chars)`);
        return toolSuccess(fileContent);
      }

      if (action === "delete") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          return toolError("Error: filename is required for delete.");
        }

        const resolved = resolvePath(raw.filename);
        if ("error" in resolved) {
          return toolError(resolved.error);
        }
        const filePath = resolved.filePath;
        await fs.unlink(filePath);
        const successMessage = `File deleted: ${filePath}`;
        log.debug(`[stavrobot] manage_files delete: ${filePath}`);
        return toolSuccess(successMessage);
      }

      return toolError(`Error: unknown action '${action}'. Valid actions: write, read, list, delete, help.`);
    },
  };
}
