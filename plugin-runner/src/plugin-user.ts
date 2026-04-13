import { execFileSync } from "child_process";

// Maximum length of a Unix username on Linux is 32 characters.
const MAX_USERNAME_LENGTH = 32;

// Derive a deterministic, valid Unix username for a plugin. The prefix "plug_"
// is 5 characters, leaving 27 for the plugin name. Plugin names are guaranteed
// to be [a-z0-9-], so only hyphens need replacing (Unix usernames disallow them).
export function derivePluginUsername(pluginName: string): string {
  const sanitized = pluginName
    .replace(/-/g, "_")
    .slice(0, MAX_USERNAME_LENGTH - "plug_".length);
  return `plug_${sanitized}`;
}

// Create the system user for a plugin if it doesn't already exist, then return
// its uid/gid. Using --system and --no-create-home keeps the user minimal.
export function ensurePluginUser(pluginName: string): { uid: number; gid: number } {
  const username = derivePluginUsername(pluginName);
  try {
    execFileSync("useradd", ["--system", "--no-create-home", username], { stdio: "pipe" });
    console.log(`[solonbot-plugin-runner] Created system user "${username}" for plugin "${pluginName}"`);
  } catch (error) {
    // useradd exits with code 9 when the user already exists; treat that as success.
    const exitCode = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (exitCode !== 9) {
      throw error;
    }
  }
  return getPluginUserIds(pluginName);
}

// Delete the system user for a plugin. Silently succeeds if the user doesn't exist.
export function removePluginUser(pluginName: string): void {
  const username = derivePluginUsername(pluginName);
  try {
    execFileSync("userdel", [username], { stdio: "pipe" });
    console.log(`[solonbot-plugin-runner] Removed system user "${username}" for plugin "${pluginName}"`);
  } catch (error) {
    // userdel exits with code 6 when the user doesn't exist; treat that as success.
    const exitCode = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (exitCode !== 6) {
      throw error;
    }
  }
}

// Look up uid/gid for an existing plugin user. Throws if the user doesn't exist.
export function getPluginUserIds(pluginName: string): { uid: number; gid: number } {
  const username = derivePluginUsername(pluginName);
  try {
    const uid = parseInt(execFileSync("id", ["-u", username], { stdio: "pipe" }).toString().trim(), 10);
    const gid = parseInt(execFileSync("id", ["-g", username], { stdio: "pipe" }).toString().trim(), 10);
    return { uid, gid };
  } catch {
    throw new Error(`Plugin user "${username}" not found — requires the Docker container environment`);
  }
}
