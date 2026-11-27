import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { HostEnv } from "../host.js";
import { HOOK_CLIENTS, type HookClient, type HookEvent } from "../hooks/normalize.js";
import { isPlainObject, read, write, type Json } from "./json.js";
import type { Change, WriteOptions } from "./types.js";

/** Writes, checks and removes Bağlam's automatic-saving hooks in one tool's hook config. */
export interface HookInstaller {
  file(h: HostEnv): string;
  install(h: HostEnv, opts?: WriteOptions): Change;
  uninstall(h: HostEnv, opts?: WriteOptions): Change;
  status(h: HostEnv): { installed: boolean; problem?: string };
}

type Shell = "posix" | "powershell";
const slash = (p: string) => p.replace(/\\/g, "/");

const samePath = (a: string, b: string) => slash(a).toLowerCase() === slash(b).toLowerCase();
const nodeOnPathCache = new WeakMap<HostEnv, boolean>();

/** PATH's first `node` is this very Node (so a bare `node` runs the same one). */
function nodeOnPath(h: HostEnv): boolean {
  const cached = nodeOnPathCache.get(h);
  if (cached !== undefined) return cached;
  const r = h.run(h.platform === "win32" ? "where" : "which", ["node"]);
  const first = r.code === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim())?.trim() : undefined;
  const yes = !!first && samePath(first, h.nodePath);
  nodeOnPathCache.set(h, yes);
  return yes;
}

/**
 * `node "<dist>/hook.js" <client> <event>`.
 * - Windows: tools run hooks through different shells (bash, cmd, PowerShell); a bare `node` first is
 *   the one form all of them run, so it is used when PATH finds this same Node.
 * - macOS and Linux: always the absolute Node path. Apps opened from the Dock or a desktop launcher
 *   (Cursor, VS Code) get the system PATH, not the shell's, so a bare `node` (Homebrew, nvm,
 *   /usr/local) is often not found there; every POSIX shell runs a quoted absolute path.
 * The absolute path is quoted, with `&` for PowerShell.
 */
export function hookCommand(h: HostEnv, client: HookClient, event: HookEvent, shell: Shell): string {
  // posix on forward slashes: the same result for "C:\…\cli.js" and "/usr/…/cli.js" on every OS.
  const quote = (path: string) => {
    // Keep the existing cross-shell form for ordinary Windows paths.
    if (!/[$`"\\]/.test(path)) return '"' + path + '"';
    return "'" + path.replaceAll("'", shell === "powershell" ? "''" : "'\\''") + "'";
  };
  const path = (p: string) => win(h) || /^[A-Za-z]:/.test(p) ? slash(p) : p;
  const args = quote(posix.join(posix.dirname(path(h.cliPath)), "hook.js")) + " " + client + " " + event;
  if (win(h) && nodeOnPath(h)) return `node ${args}`;
  const line = quote(path(h.nodePath)) + " " + args;
  return shell === "powershell" ? `& ${line}` : line;
}

const OURS = new RegExp(String.raw`(?:"([^"]*hook\.js)"|'((?:[^']|''|'\\'')*hook\.js)'|(\S*hook\.js))\s+(?:${HOOK_CLIENTS.join("|")})\s+(?:start|prompt|edit|stop)\b`);

/**
 * Our command shape, and the hook.js it runs is Bağlam's: its package (dist/../package.json) is
 * named "baglam". A hook.js that no longer exists is a moved or removed install of ours, to replace.
 */
function isOurCommand(command: string): boolean {
  const m = OURS.exec(command);
  if (!m) return false;
  const file = m[1] ?? m[2]?.replaceAll("'\\''", "'").replaceAll("''", "'") ?? m[3];
  if (!existsSync(file)) return true;
  try {
    return (JSON.parse(readFileSync(join(dirname(file), "..", "package.json"), "utf8")) as { name?: unknown }).name === "baglam";
  } catch {
    return false;
  }
}

const isOurs = (handler: unknown) =>
  isPlainObject(handler) && [handler.command, handler.commandWindows].some((c) => typeof c === "string" && isOurCommand(c));

/**
 * How a tool lays out hooks:
 * - nested: hooks.<Event> = [{ matcher?, hooks: [handler] }] (Claude Code, Codex, Gemini CLI)
 * - flat:   hooks.<event> = [handler]                         (Cursor, VS Code)
 * - named:  <name>.<Event> = [...]                           (Antigravity; we own the "baglam" name)
 */
type Layout = "nested" | "flat" | "named";

interface Spec {
  client: HookClient;
  layout: Layout;
  file: (h: HostEnv) => string;
  /** The file holds only hooks: delete it when nothing but ours was in it. */
  ownFile: boolean;
  /** Our part: event name → entries to append. Version fields etc. go in `top`. */
  entries: (h: HostEnv) => Record<string, Json[]>;
  top?: Json;
}

const NAMED_KEY = "baglam";

function strip(data: Json, layout: Layout): Json {
  if (layout === "named") {
    const { [NAMED_KEY]: _ours, ...rest } = data;
    return rest;
  }
  if (!isPlainObject(data.hooks)) return data;
  const hooks: Json = {};
  for (const [event, list] of Object.entries(data.hooks)) {
    if (!Array.isArray(list)) {
      hooks[event] = list;
      continue;
    }
    const kept =
      layout === "flat"
        ? list.filter((x) => !isOurs(x))
        : list
            .map((g) => {
              if (!isPlainObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return g;
              const left = g.hooks.filter((x) => !isOurs(x));
              return left.length ? { ...g, hooks: left } : null;
            })
            .filter((g) => g !== null);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = data;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

function merge(data: Json, spec: Spec, h: HostEnv): Json {
  const base = strip(data, spec.layout);
  const ours = spec.entries(h);
  if (spec.layout === "named") return { ...base, [NAMED_KEY]: ours };
  const hooks: Json = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, list] of Object.entries(ours)) {
    const cur = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...cur, ...list];
  }
  return { ...spec.top, ...base, hooks };
}

/** Nothing of the user's left (only fields we add ourselves, like "version"). */
const isEmpty = (data: Json, spec: Spec) => Object.keys(data).every((k) => spec.top && k in spec.top);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** JSON with sorted keys: tools rewrite their own settings files and may reorder keys. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const ourHandlerCount = (list: unknown[], layout: Layout) =>
  layout === "flat"
    ? list.filter(isOurs).length
    : list.reduce<number>((n, g) => n + (isPlainObject(g) && Array.isArray(g.hooks) ? g.hooks.filter(isOurs).length : 0), 0);

/**
 * Exactly our current entries are present, wherever they sit among the user's own hooks and
 * whatever key order the tool keeps, and no old entry of ours is left behind.
 */
function upToDate(data: Json, spec: Spec, h: HostEnv): boolean {
  const ours = spec.entries(h);
  if (spec.layout === "named") return canon(data[NAMED_KEY]) === canon(ours);
  if (spec.top && Object.entries(spec.top).some(([k, v]) => canon(data[k]) !== canon(v))) return false;
  const hooks = isPlainObject(data.hooks) ? data.hooks : {};
  let expected = 0;
  for (const [event, wanted] of Object.entries(ours)) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const present = new Set(list.map(canon));
    if (!wanted.every((w) => present.has(canon(w)))) return false;
    expected += ourHandlerCount(wanted, spec.layout);
  }
  const found = Object.values(hooks).reduce<number>((n, list) => n + (Array.isArray(list) ? ourHandlerCount(list, spec.layout) : 0), 0);
  return found === expected;
}

function installer(spec: Spec): HookInstaller {
  return {
    file: spec.file,

    install(h, opts = {}) {
      const file = spec.file(h);
      const cur = read(file);
      if (!cur.ok) return { client: spec.client, file, action: "skipped", note: cur.error, part: "auto-save" };
      if (cur.exists && upToDate(cur.data, spec, h)) return { client: spec.client, file, action: "unchanged", part: "auto-save" };
      const next = merge(cur.data, spec, h);
      if (!opts.dryRun) write(file, next, cur.bom);
      return { client: spec.client, file, action: cur.exists ? "updated" : "added", part: "auto-save" };
    },

    uninstall(h, opts = {}) {
      const file = spec.file(h);
      const cur = read(file);
      if (!cur.ok) return { client: spec.client, file, action: "skipped", note: cur.error, part: "auto-save" };
      const next = strip(cur.data, spec.layout);
      if (!cur.exists || same(next, cur.data)) return { client: spec.client, file, action: "absent", part: "auto-save" };
      if (!opts.dryRun) {
        if (spec.ownFile && isEmpty(next, spec)) rmSync(file, { force: true });
        else write(file, next, cur.bom);
      }
      return { client: spec.client, file, action: "removed", part: "auto-save" };
    },

    status(h) {
      const file = spec.file(h);
      if (!existsSync(file)) return { installed: false };
      const cur = read(file);
      if (!cur.ok) return { installed: false, problem: cur.error };
      return { installed: upToDate(cur.data, spec, h) };
    },
  };
}

const TIMEOUT_S = 10;
const win = (h: HostEnv) => h.platform === "win32";

/** Claude Code style handler group. */
const group = (command: string, extra: Json = {}, matcher?: string): Json => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ ...extra, type: "command", command, timeout: TIMEOUT_S }],
});

export const HOOK_INSTALLERS: Record<HookClient, HookInstaller> = {
  "claude-code": installer({
    client: "claude-code",
    layout: "nested",
    ownFile: false,
    file: (h) => join(h.home, ".claude", "settings.json"),
    entries: (h) => ({
      SessionStart: [group(hookCommand(h, "claude-code", "start", "posix"))],
      UserPromptSubmit: [group(hookCommand(h, "claude-code", "prompt", "posix"))],
      PostToolUse: [group(hookCommand(h, "claude-code", "edit", "posix"), {}, "Write|Edit|MultiEdit|NotebookEdit")],
      Stop: [group(hookCommand(h, "claude-code", "stop", "posix"))],
    }),
  }),

  codex: installer({
    client: "codex",
    layout: "nested",
    ownFile: true,
    file: (h) => join(h.home, ".codex", "hooks.json"),
    entries: (h) => {
      const handler = (event: HookEvent): Json => ({
        type: "command",
        command: hookCommand(h, "codex", event, "posix"),
        commandWindows: hookCommand(h, "codex", event, "powershell"),
        timeout: TIMEOUT_S,
      });
      return {
        SessionStart: [{ hooks: [handler("start")] }],
        UserPromptSubmit: [{ hooks: [handler("prompt")] }],
        PostToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [handler("edit")] }],
        Stop: [{ hooks: [handler("stop")] }],
      };
    },
  }),

  "gemini-cli": installer({
    client: "gemini-cli",
    layout: "nested",
    ownFile: false,
    file: (h) => join(h.home, ".gemini", "settings.json"),
    entries: (h) => {
      const handler = (event: HookEvent): Json => ({
        name: `baglam-${event}`,
        type: "command",
        command: hookCommand(h, "gemini-cli", event, "posix"),
        timeout: TIMEOUT_S * 1000,
      });
      return {
        SessionStart: [{ matcher: "*", hooks: [handler("start")] }],
        BeforeAgent: [{ matcher: "*", hooks: [handler("prompt")] }],
        AfterTool: [{ matcher: "write_file|replace", hooks: [handler("edit")] }],
        AfterAgent: [{ matcher: "*", hooks: [handler("stop")] }],
      };
    },
  }),

  cursor: installer({
    client: "cursor",
    layout: "flat",
    ownFile: true,
    top: { version: 1 },
    file: (h) => join(h.home, ".cursor", "hooks.json"),
    entries: (h) => {
      // The Cursor desktop app runs hook commands through PowerShell on Windows.
      const shell: Shell = win(h) ? "powershell" : "posix";
      const handler = (event: HookEvent): Json => ({ command: hookCommand(h, "cursor", event, shell), timeout: TIMEOUT_S });
      return {
        sessionStart: [handler("start")],
        beforeSubmitPrompt: [handler("prompt")],
        afterFileEdit: [handler("edit")],
        afterAgentResponse: [handler("stop")],
      };
    },
  }),

  antigravity: installer({
    client: "antigravity",
    layout: "named",
    ownFile: true,
    file: (h) => join(h.home, ".gemini", "config", "hooks.json"),
    entries: (h) => {
      const handler = (event: HookEvent): Json => ({ type: "command", command: hookCommand(h, "antigravity", event, "posix"), timeout: TIMEOUT_S });
      // Antigravity gives no final reply text, so there is no stop hook.
      return {
        PreInvocation: [handler("prompt")],
        PostToolUse: [{ matcher: "write_file|edit_file|create_file|write_to_file|replace_file_content|multi_replace_file_content", hooks: [handler("edit")] }],
      };
    },
  }),

  vscode: installer({
    client: "vscode",
    layout: "flat",
    ownFile: true,
    top: { version: 1 },
    file: (h) => join(h.home, ".copilot", "hooks", "baglam.json"),
    entries: (h) => {
      const handler = (event: HookEvent): Json => ({ type: "command", command: hookCommand(h, "vscode", event, "posix"), timeoutSec: TIMEOUT_S });
      return {
        sessionStart: [handler("start")],
        userPromptSubmitted: [handler("prompt")],
        postToolUse: [handler("edit")],
        agentStop: [handler("stop")],
      };
    },
  }),
};
