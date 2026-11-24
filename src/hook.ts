#!/usr/bin/env node
/**
 * Entry for AI tool hooks: `node hook.js <client> <start|prompt|edit|stop>` with the tool's JSON on stdin.
 * Saves what the tool saw into the live handoff, and injects the live task and approved memory at
 * session start or when control switches from another agent. Never blocks or slows down the tool:
 * always exits 0 within the deadline. Kept small on purpose (no MCP SDK).
 */
import { appendFileSync, realpathSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDataDirectory, protectExisting } from "./private-files.js";
import { resolveDbPath } from "./config.js";
import { formatBrief, formatHandoff } from "./format.js";
import { fastBranch } from "./git.js";
import { contextOutput, HOOK_CLIENTS, HOOK_EVENTS, neutralOutput, normalize, type HookClient, type HookEvent } from "./hooks/normalize.js";
import { resolveDirectory } from "./project.js";
import { ContextStore } from "./store.js";

const HOOK_START_BUDGET_TOKENS = 900;
const HOOK_SWITCH_MAX_CHARS = 2400;

const MAX_STDIN = 1024 * 1024;
const DEADLINE_MS = 3000;
/**
 * SQLite waits for a lock synchronously, so the deadline timer cannot fire meanwhile. Each wait is
 * capped well below the deadline instead: at most two writes wait, so a locked database costs the
 * tool under 1.5 s and the save is skipped (and logged) rather than holding the tool up.
 */
export const HOOK_BUSY_MS = 700;
const MAX_LOG = 256 * 1024;

export interface HookIo {
  stdin: string;
  env: NodeJS.ProcessEnv;
  dbPath: string;
  /** Folder to use when the tool's payload names none. */
  cwd?: string;
  now?: () => number;
}

function logError(dbPath: string, what: string, err: unknown): void {
  try {
    const file = join(dirname(dbPath), "hook-errors.log");
    ensureDataDirectory(file);
    if (process.platform !== "win32") protectExisting(file);
    try {
      if (statSync(file).size > MAX_LOG) truncateSync(file, 0);
    } catch {
      // No log yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${what}: ${(err as Error)?.stack ?? String(err)}\n`, { mode: 0o600 });
  } catch {
    // Nowhere to write: stay silent rather than disturb the tool.
  }
}

/** Cursor's hook payloads carry these; Claude Code's never do. */
function fromCursor(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.cursor_version === "string" || Array.isArray(p.workspace_roots);
}

export function runHook(argv: string[], io: HookIo): { stdout: string; code: 0 } {
  const [c, e] = argv;
  const client = (HOOK_CLIENTS as readonly string[]).includes(c) ? (c as HookClient) : undefined;
  const event = (HOOK_EVENTS as string[]).includes(e) ? (e as HookEvent) : undefined;
  let stdout = client ? neutralOutput(client, event ?? "edit") : "";
  if (!client || !event) return { stdout, code: 0 };

  try {
    let payload: unknown = {};
    try {
      payload = io.stdin.trim() ? JSON.parse(io.stdin) : {};
    } catch {
      payload = {};
    }
    // Cursor also runs Claude Code's hooks (~/.claude/settings.json), with its own payload shape.
    // Cursor's own hook handles the same event under the right name, so this copy is skipped.
    if (client === "claude-code" && fromCursor(payload)) return { stdout, code: 0 };
    const n = normalize(client, event, payload);
    const project = resolveDirectory(n.cwd ?? io.cwd ?? process.cwd());
    // Hooks fire in every folder; only projects set up with `baglam init` are touched.
    if (!project.initialized) return { stdout, code: 0 };
    const canInject = io.env.BAGLAM_HOOK_INJECT !== "0";
    const store = new ContextStore(io.dbPath, io.now, { busyTimeoutMs: HOOK_BUSY_MS });
    try {
      const branch = fastBranch(project.dir);
      if (event === "start") {
        if (canInject) {
          const live = store.getHandoff(project.key, branch);
          const activeLive = live && live.status !== "done" ? live : undefined;
          const otherBranches = store.listHandoffs(project.key).filter((h) => h.branch !== branch && h.status !== "done");
          const entries = store.visible(project.key, client, { limit: 30, byPriority: true });
          if (activeLive || otherBranches.length > 0 || entries.length > 0) {
            const brief = formatBrief({
              project,
              agent: client,
              entries,
              pendingCount: 0,
              budgetTokens: HOOK_START_BUDGET_TOKENS,
              handoff: activeLive || otherBranches.length > 0 ? { live: activeLive, git: null, otherBranches } : undefined,
            });
            stdout = contextOutput(client, "start", brief);
          }
        }
        store.noteHookSeen(client, "start");
      } else {
        // Check handoff state before autoCapture overwrites live.agent with the current client.
        const before = event === "prompt" && canInject ? store.getHandoff(project.key, branch) : undefined;
        const lastSeen = before && before.status !== "done" && before.agent !== client ? store.hookSeen()[client] : undefined;
        // The save first: if the database stays locked, it is the write worth its one wait.
        if (n.event && store.isAutoCapture(project.key)) {
          store.autoCapture({ project: project.key, branch, dir: project.dir, agent: client, event: n.event });
        }
        if (
          before &&
          before.status !== "done" &&
          before.agent !== client &&
          !(lastSeen?.event === "start" && lastSeen.at >= before.updatedAt)
        ) {
          const otherBranches = store.listHandoffs(project.key).filter((h) => h.branch !== branch && h.status !== "done");
          const handoffText = formatHandoff({ live: before, git: null, otherBranches }, HOOK_SWITCH_MAX_CHARS);
          stdout = contextOutput(client, "prompt", handoffText);
        }
        store.noteHookSeen(client, event);
      }
    } finally {
      store.close();
    }
  } catch (err) {
    logError(io.dbPath, `${client} ${event}`, err);
  }
  return { stdout, code: 0 };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_STDIN) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const client = (HOOK_CLIENTS as readonly string[]).includes(argv[0]) ? (argv[0] as HookClient) : undefined;
  const neutral = client ? neutralOutput(client, (argv[1] as HookEvent) ?? "edit") : "";
  // Whatever happens, the tool gets its answer within the deadline.
  const timer = setTimeout(() => {
    process.stdout.write(neutral);
    process.exit(0);
  }, DEADLINE_MS);
  readStdin()
    .catch(() => "")
    .then((stdin) => {
      const r = runHook(argv, { stdin, env: process.env, dbPath: resolveDbPath() });
      clearTimeout(timer);
      process.stdout.write(r.stdout, () => process.exit(0));
    });
}
