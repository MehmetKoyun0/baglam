import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeAction } from "./clients/types.js";
import { writeFileAtomic } from "./host.js";

export const BLOCK_START = "<!-- baglam:start -->";
export const BLOCK_END = "<!-- baglam:end -->";

/** The instructions every agent reads from CLAUDE.md / AGENTS.md / GEMINI.md / Cursor rules. */
export function instructionBlock(): string {
  return [
    BLOCK_START,
    "## Shared project context (Bağlam)",
    "This project uses Bağlam to share decisions between AI agents.",
    "- At the start of every task, call the `context_brief` tool with `project_path` set to the absolute path of this project folder, and follow what it returns.",
    "- When you settle a decision, learn a convention or a user preference, or hit a pitfall other agents should know about, call `context_propose` (same `project_path`). Use `supersedes` when it replaces an existing record.",
    "- Never put secrets, credentials or personal data in a proposal.",
    "",
    "### Save progress so another agent can continue",
    "- When you start or pick up a task, call `context_checkpoint` with the `goal` before you change anything. Every follow-up request in the same conversation (\"now add X\") is a new task too: checkpoint its goal first. After every meaningful step (a file finished, a test passing, a decision made) call it again with `done_add`, `now` and `next`. Do this before long operations too: you may be stopped at any moment, and another agent will continue from your last checkpoint.",
    "- If `context_brief` shows a task under \"Continue from here\" and the user's request is about it, continue from its next steps instead of starting over, and keep checkpointing it (do not pass `new_task`). Pass `new_task: true` only when you start something unrelated.",
    "- When the task is finished, call `context_checkpoint` with `status: \"done\"`.",
    "- Write checkpoints (goal, done, now, next) in the language the user writes in, so the user can read them in the panel.",
    BLOCK_END,
    "",
  ].join("\n");
}

export const CURSOR_RULE_HEADER = "---\ndescription: Shared project context (Bağlam)\nalwaysApply: true\n---\n";
export const WINDSURF_RULE_HEADER = "---\ntrigger: always_on\n---\n";

function findBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return null;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker < 0) return null;
  let end = endMarker + BLOCK_END.length;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  return { start, end };
}

/**
 * Put `block` (LF line endings) into `file`: replace our fenced block in place, or append it after a
 * blank line, or create the file with `prefix + block`. The file's own line endings are kept.
 */
export function upsertBlock(file: string, block: string, opts: { prefix?: string } = {}): ChangeAction {
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const want = block.replace(/\n/g, eol);
  const found = findBlock(text);
  let next: string;
  if (found) {
    if (text.slice(found.start, found.end) === want) return "unchanged";
    next = text.slice(0, found.start) + want + text.slice(found.end);
  } else if (!exists || !text) {
    next = (opts.prefix ?? "").replace(/\n/g, eol) + want;
  } else {
    next = text + (text.endsWith(eol) ? eol : eol + eol) + want;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, next);
  return exists && text ? "updated" : "added";
}

/** Remove our block. Deletes the file when nothing but `prefix` (or nothing) is left. */
export function removeBlock(file: string, opts: { prefix?: string } = {}): ChangeAction {
  if (!existsSync(file)) return "absent";
  const text = readFileSync(file, "utf8");
  const found = findBlock(text);
  if (!found) return "absent";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let start = found.start;
  const before = text.slice(0, start);
  if (before.endsWith(eol + eol)) start -= eol.length;
  const next = text.slice(0, start) + text.slice(found.end);
  const leftover = next.replace((opts.prefix ?? "").replace(/\n/g, eol), "");
  if (!leftover.trim()) rmSync(file);
  else writeFileAtomic(file, next);
  return "removed";
}
