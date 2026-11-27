import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backupOnce, serverEntry, writeFileAtomic, type HostEnv } from "../host.js";
import type { Change, ClientAdapter, ClientStatus, WriteOptions } from "./types.js";

const START = "# baglam:start";
const END = "# baglam:end";
const ID = "codex";

const configPath = (h: HostEnv) => join(h.home, ".codex", "config.toml");

/** JSON string escaping is valid TOML basic-string escaping. */
const tomlString = (s: string) => JSON.stringify(s);

/**
 * Our block. `kept` is what Codex itself wrote inside it, such as the tool approvals saved when the
 * user picks "Always allow" ([mcp_servers.baglam.tools.<tool>] approval_mode = "approve").
 */
function block(h: HostEnv, eol: string, kept = ""): string {
  const e = serverEntry(h, ID);
  return [
    START,
    "[mcp_servers.baglam]",
    `command = ${tomlString(e.command)}`,
    `args = [${e.args.map(tomlString).join(", ")}]`,
    `env = { BAGLAM_AGENT = ${tomlString(e.env.BAGLAM_AGENT)} }`,
    ...(kept ? ["", kept] : []),
    END,
  ].join(eol) + eol;
}

const SUB_TABLE = /^[ \t]*\[\s*mcp_servers\s*\.\s*baglam\s*\./m;

/** The sub-tables of mcp_servers.baglam that Codex added inside our block (trimmed), or "". */
function keptPart(text: string, found: { start: number; end: number }): string {
  const body = text.slice(found.start, text.lastIndexOf(END, found.end));
  const m = SUB_TABLE.exec(body);
  return m ? body.slice(m.index).trim() : "";
}

/** Location of our fenced block, including its trailing newline. */
function findBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(START);
  if (start < 0) return null;
  const endMarker = text.indexOf(END, start);
  if (endMarker < 0) return null;
  let end = endMarker + END.length;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  return { start, end };
}

const BAGLAM_KEY = String.raw`(?:baglam|"baglam"|'baglam')`;

/**
 * True when the TOML (outside our block) already defines the baglam server in any layout, or defines
 * mcp_servers inline: appending our [mcp_servers.baglam] table would then make the file invalid.
 */
function definesBaglamElsewhere(text: string): boolean {
  const patterns = [
    new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${BAGLAM_KEY}\s*[\].]`, "m"), // [mcp_servers.baglam] / [mcp_servers.baglam.env]
    new RegExp(String.raw`^\s*mcp_servers\s*=`, "m"), // mcp_servers = { … }
    new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${BAGLAM_KEY}\s*[.=]`, "m"), // mcp_servers.baglam.command = …
  ];
  if (patterns.some((p) => p.test(text))) return true;
  // Dotted keys inside a [mcp_servers] table: baglam.command = …
  let inMcpServers = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header) {
      inMcpServers = header[1] === "mcp_servers";
      continue;
    }
    if (inMcpServers && new RegExp(String.raw`^\s*${BAGLAM_KEY}\s*[.=]`).test(line)) return true;
  }
  return false;
}

function load(file: string) {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  return { exists, text, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function save(file: string, text: string): void {
  backupOnce(file);
  writeFileAtomic(file, text, 0o600);
}

export const codex: ClientAdapter = {
  id: ID,
  label: "Codex CLI",

  detect: (h) => existsSync(join(h.home, ".codex")),

  install(h: HostEnv, opts: WriteOptions = {}): Change {
    const file = configPath(h);
    const { exists, text, eol } = load(file);
    const found = findBlock(text);
    const want = block(h, eol, found ? keptPart(text, found) : "");
    const outside = found ? text.slice(0, found.start) + text.slice(found.end) : text;
    let next: string;
    if (definesBaglamElsewhere(outside)) {
      return {
        client: ID,
        file,
        action: "skipped",
        note: `${file} already defines mcp_servers.baglam (or an inline mcp_servers table) outside Bağlam's block; remove it by hand and run setup again`,
      };
    } else if (found) {
      if (text.slice(found.start, found.end) === want) return { client: ID, file, action: "unchanged" };
      next = text.slice(0, found.start) + want + text.slice(found.end);
    } else {
      const sep = !text ? "" : text.endsWith(eol) ? eol : eol + eol;
      next = text + sep + want;
    }
    if (!opts.dryRun) save(file, next);
    return { client: ID, file, action: exists ? "updated" : "added" };
  },

  uninstall(h: HostEnv, opts: WriteOptions = {}): Change {
    const file = configPath(h);
    const { text, eol } = load(file);
    const found = findBlock(text);
    if (!found) return { client: ID, file, action: "absent" };
    let start = found.start;
    // Drop the blank line install added before the block, but never join two real lines.
    const before = text.slice(0, start);
    if (before.endsWith(eol + eol)) start -= eol.length;
    else if (before === eol) start = 0;
    if (!opts.dryRun) save(file, text.slice(0, start) + text.slice(found.end));
    return { client: ID, file, action: "removed" };
  },

  status(h: HostEnv): ClientStatus {
    const installed = existsSync(join(h.home, ".codex"));
    const { text } = load(configPath(h));
    const found = findBlock(text);
    if (!found) return { installed, registered: false };
    const body = text.slice(found.start, found.end);
    try {
      const command = JSON.parse(/^command = (.*)$/m.exec(body)?.[1]?.trim() ?? "null");
      const args = JSON.parse(/^args = (.*)$/m.exec(body)?.[1]?.trim() ?? "null");
      const agent = /BAGLAM_AGENT = ("(?:[^"\\]|\\.)*")/.exec(body)?.[1];
      return { installed, registered: true, entry: { command, args, env: agent ? { BAGLAM_AGENT: JSON.parse(agent) } : undefined } };
    } catch {
      return { installed, registered: true, problem: `could not read the Bağlam block in ${configPath(h)}` };
    }
  },
};
