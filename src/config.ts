import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical project key: absolute, forward slashes, lower-case on Windows, no trailing slash. */
export function normalizeProject(path: string): string {
  let p = resolve(path).normalize("NFC").replace(/\\/g, "/");
  if (process.platform === "win32") p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** Nearest directory at or above `start` that contains `.git`, else `start` itself. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function resolveDbPath(): string {
  return process.env.BAGLAM_DB?.trim() || join(homedir(), ".baglam", "baglam.db");
}

export function resolveAgentOverride(): string | undefined {
  return process.env.BAGLAM_AGENT?.trim() || undefined;
}
