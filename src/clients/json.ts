import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupOnce, serverEntry, writeFileAtomic, type HostEnv } from "../host.js";
import type { Change, ClientAdapter, ClientStatus, ServerEntryShape, WriteOptions } from "./types.js";

export type Json = Record<string, unknown>;

interface JsonClientOptions {
  id: string;
  label: string;
  configPath: (h: HostEnv) => string;
  /** Exists when the tool is installed. */
  detectPath: (h: HostEnv) => string;
  /** Top-level key holding servers. */
  key?: "mcpServers" | "servers";
  /** VS Code wants `"type": "stdio"` on each server. */
  vscodeStyle?: boolean;
  /** Older config files of the same tool: undo removes Bağlam from them too (install leaves them). */
  legacyPaths?: (h: HostEnv) => string[];
}

const SERVER_NAME = "baglam";

const BOM = "﻿";

export type ReadResult = { ok: true; data: Json; exists: boolean; bom: boolean } | { ok: false; error: string };

export const isPlainObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function read(file: string): ReadResult {
  if (!existsSync(file)) return { ok: true, data: {}, exists: false, bom: false };
  const raw = readFileSync(file, "utf8");
  const bom = raw.startsWith(BOM);
  const text = bom ? raw.slice(1) : raw;
  if (!text.trim()) return { ok: true, data: {}, exists: true, bom };
  try {
    const data = JSON.parse(text);
    if (!isPlainObject(data)) return { ok: false, error: `${file} is not a JSON object` };
    return { ok: true, data, exists: true, bom };
  } catch (err) {
    return { ok: false, error: `${file} is not valid JSON (${(err as Error).message}); fix it or add Bağlam by hand` };
  }
}

/** The servers map, or an error when the key holds something other than an object. */
function serversOf(data: Json, key: string, file: string): { ok: true; servers: Json } | { ok: false; error: string } {
  const v = data[key];
  if (v === undefined || v === null) return { ok: true, servers: {} };
  if (!isPlainObject(v)) return { ok: false, error: `"${key}" in ${file} is not an object; fix it or add Bağlam by hand` };
  return { ok: true, servers: v };
}

export function write(file: string, data: Json, bom: boolean): void {
  backupOnce(file);
  writeFileAtomic(file, (bom ? BOM : "") + JSON.stringify(data, null, 2) + "\n", 0o600);
}

export function jsonClient(o: JsonClientOptions): ClientAdapter {
  const key = o.key ?? "mcpServers";
  const desired = (h: HostEnv): Json => (o.vscodeStyle ? { type: "stdio", ...serverEntry(h, o.id) } : serverEntry(h, o.id));

  return {
    id: o.id,
    label: o.label,

    detect: (h) => existsSync(o.detectPath(h)),

    install(h: HostEnv, opts: WriteOptions = {}): Change {
      const file = o.configPath(h);
      const cur = read(file);
      if (!cur.ok) return { client: o.id, file, action: "skipped", note: cur.error };
      const s = serversOf(cur.data, key, file);
      if (!s.ok) return { client: o.id, file, action: "skipped", note: s.error };
      const want = desired(h);
      if (JSON.stringify(s.servers[SERVER_NAME]) === JSON.stringify(want)) return { client: o.id, file, action: "unchanged" };
      if (!opts.dryRun) write(file, { ...cur.data, [key]: { ...s.servers, [SERVER_NAME]: want } }, cur.bom);
      return { client: o.id, file, action: cur.exists ? "updated" : "added" };
    },

    uninstall(h: HostEnv, opts: WriteOptions = {}): Change {
      const file = o.configPath(h);
      /** Removes our entry from `f`: true when it was there, a note when the file cannot be read. */
      const removeFrom = (f: string): boolean | string => {
        const cur = read(f);
        if (!cur.ok) return cur.error;
        const s = serversOf(cur.data, key, f);
        if (!s.ok) return s.error;
        if (!(SERVER_NAME in s.servers)) return false;
        const { [SERVER_NAME]: _removed, ...rest } = s.servers;
        if (!opts.dryRun) write(f, { ...cur.data, [key]: rest }, cur.bom);
        return true;
      };
      const main = removeFrom(file);
      if (typeof main === "string") return { client: o.id, file, action: "skipped", note: main };
      // Old files are tidied on a best-effort basis: one that cannot be read is left as it is.
      const legacy = (o.legacyPaths?.(h) ?? []).filter((f) => f !== file && existsSync(f)).map((f) => removeFrom(f) === true);
      return { client: o.id, file, action: main || legacy.some(Boolean) ? "removed" : "absent" };
    },

    status(h: HostEnv): ClientStatus {
      const installed = existsSync(o.detectPath(h));
      const file = o.configPath(h);
      const cur = read(file);
      if (!cur.ok) return { installed, registered: false, problem: cur.error };
      const s = serversOf(cur.data, key, file);
      if (!s.ok) return { installed, registered: false, problem: s.error };
      const entry = s.servers[SERVER_NAME] as ServerEntryShape | undefined;
      return { installed, registered: !!entry, entry };
    },
  };
}

export const cursor = jsonClient({
  id: "cursor",
  label: "Cursor",
  configPath: (h) => join(h.home, ".cursor", "mcp.json"),
  detectPath: (h) => join(h.home, ".cursor"),
});

/**
 * Antigravity 2 moved its settings to ~/.gemini/config (it leaves a `.migrated` marker and its own
 * mcp_config.json there) and reads MCP servers only from that file; older versions read
 * ~/.gemini/antigravity/mcp_config.json.
 */
const antigravityV2 = (h: HostEnv) =>
  existsSync(join(h.home, ".gemini", "config", "mcp_config.json")) || existsSync(join(h.home, ".gemini", "config", ".migrated"));

export const antigravity = jsonClient({
  id: "antigravity",
  label: "Antigravity",
  configPath: (h) =>
    antigravityV2(h)
      ? join(h.home, ".gemini", "config", "mcp_config.json")
      : join(h.home, ".gemini", "antigravity", "mcp_config.json"),
  detectPath: (h) => (antigravityV2(h) ? join(h.home, ".gemini", "config") : join(h.home, ".gemini", "antigravity")),
  legacyPaths: (h) => [join(h.home, ".gemini", "antigravity", "mcp_config.json")],
});

export const geminiCli = jsonClient({
  id: "gemini-cli",
  label: "Gemini CLI",
  configPath: (h) => join(h.home, ".gemini", "settings.json"),
  detectPath: (h) => join(h.home, ".gemini", "settings.json"),
});

export const windsurf = jsonClient({
  id: "windsurf",
  label: "Windsurf",
  configPath: (h) => join(h.home, ".codeium", "windsurf", "mcp_config.json"),
  detectPath: (h) => join(h.home, ".codeium", "windsurf"),
});

export const vscode = jsonClient({
  id: "vscode",
  label: "VS Code",
  configPath: (h) => join(h.appData, "Code", "User", "mcp.json"),
  detectPath: (h) => join(h.appData, "Code", "User"),
  key: "servers",
  vscodeStyle: true,
});
