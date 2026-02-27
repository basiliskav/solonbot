import fs from "fs";
import type { Config } from "./config.js";

export interface Allowlist {
  signal: string[];
  telegram: number[];
}

const ALLOWLIST_PATH = process.env.ALLOWLIST_PATH ?? "allowlist.json";

let currentAllowlist: Allowlist = { signal: [], telegram: [] };

function validateAllowlist(value: unknown): Allowlist {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("allowlist.json must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.signal) || !obj.signal.every((item) => typeof item === "string")) {
    throw new Error("allowlist.json: 'signal' must be an array of strings");
  }
  if (!Array.isArray(obj.telegram) || !obj.telegram.every((item) => typeof item === "number")) {
    throw new Error("allowlist.json: 'telegram' must be an array of numbers");
  }
  return { signal: obj.signal as string[], telegram: obj.telegram as number[] };
}

export function loadAllowlist(config: Config): Allowlist {
  if (fs.existsSync(ALLOWLIST_PATH)) {
    const content = fs.readFileSync(ALLOWLIST_PATH, "utf-8");
    currentAllowlist = validateAllowlist(JSON.parse(content) as unknown);
    console.log(`[stavrobot] Loaded allowlist from ${ALLOWLIST_PATH}`);
  } else {
    // Migrate from config.toml if values are present there.
    const migratedSignal = config.signal?.allowedNumbers ?? [];
    const migratedTelegram = config.telegram?.allowedChatIds ?? [];

    if (migratedSignal.length > 0 || migratedTelegram.length > 0) {
      console.warn(
        "[stavrobot] Migrated allowlist from config.toml to allowlist.json. " +
          "You can remove signal.allowedNumbers and telegram.allowedChatIds from config.toml.",
      );
    }

    currentAllowlist = { signal: migratedSignal, telegram: migratedTelegram };
    saveAllowlist(currentAllowlist);
  }

  // Auto-seed owner identities so the owner is always in the allowlist.
  let changed = false;

  if (config.owner.signal !== undefined && !currentAllowlist.signal.includes(config.owner.signal)) {
    currentAllowlist.signal.push(config.owner.signal);
    changed = true;
  }

  if (config.owner.telegram !== undefined) {
    const ownerTelegramId = Number(config.owner.telegram);
    if (!Number.isInteger(ownerTelegramId)) {
      console.warn("[stavrobot] owner.telegram is not a valid integer, skipping allowlist seed:", config.owner.telegram);
    } else if (!currentAllowlist.telegram.includes(ownerTelegramId)) {
      currentAllowlist.telegram.push(ownerTelegramId);
      changed = true;
    }
  }

  if (changed) {
    saveAllowlist(currentAllowlist);
  }

  return currentAllowlist;
}

export function saveAllowlist(allowlist: Allowlist): void {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2));
  currentAllowlist = allowlist;
}

export function getAllowlist(): Allowlist {
  return { signal: [...currentAllowlist.signal], telegram: [...currentAllowlist.telegram] };
}

export function isInAllowlist(service: string, identifier: string): boolean {
  if (service === "signal") {
    return currentAllowlist.signal.includes(identifier);
  }
  if (service === "telegram") {
    const chatId = Number(identifier);
    if (!Number.isInteger(chatId)) {
      return false;
    }
    return currentAllowlist.telegram.includes(chatId);
  }
  return false;
}

export function getOwnerIdentities(config: Config): { signal: string[]; telegram: number[] } {
  const signal = config.owner.signal !== undefined ? [config.owner.signal] : [];
  let telegram: number[] = [];
  if (config.owner.telegram !== undefined) {
    const ownerTelegramId = Number(config.owner.telegram);
    if (Number.isInteger(ownerTelegramId)) {
      telegram = [ownerTelegramId];
    }
  }
  return { signal, telegram };
}
