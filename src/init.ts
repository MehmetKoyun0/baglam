import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ContextStore } from "./store.js";
import { writeFileAtomic, type HostEnv } from "./host.js";
import type { Change } from "./clients/types.js";
import { antigravity, cursor, geminiCli, vscode, windsurf } from "./clients/json.js";
import { claudeCode } from "./clients/claude.js";
import { normalizeProject, UUID } from "./config.js";
import { createMarker, readMarker, resolveDirectory, type ProjectRef } from "./project.js";
import { CURSOR_RULE_HEADER, WINDSURF_RULE_HEADER, instructionBlock, removeBlock, upsertBlock } from "./instructions.js";

export interface InitResult {
  project: ProjectRef;
  /** Records moved from the folder's old path key to the new project id. */
  moved: number;
  changes: Change[];
  /** Paths added to .git/info/exclude when `--local` was passed. */
  excluded?: string[];
}

export interface InstructionTarget {
  file: string;
  prefix?: string;
}

/** The instruction files that should exist in `dir` for the AI tools installed on `host`. */
export function expectedInstructionTargets(dir: string, host: HostEnv): InstructionTarget[] {
  const detected = (c: { detect(h: HostEnv): boolean }) => {
    try {
      return c.detect(host);
    } catch {
      return false;
    }
  };
  const all = allTargets(dir);
  const list: InstructionTarget[] = [];
  if (detected(claudeCode)) list.push(all.claude);
  list.push(all.agents); // read by Codex, Cursor, Antigravity and most other agents
  if (detected(antigravity) || detected(geminiCli)) list.push(all.gemini);
  if (detected(cursor)) list.push(all.cursorRule);
  if (detected(vscode)) list.push(all.copilot);
  if (detected(windsurf)) list.push(all.windsurfRule);
  return list;
}

function allTargets(dir: string): Record<"claude" | "agents" | "gemini" | "cursorRule" | "copilot" | "windsurfRule", InstructionTarget> {
  return {
    claude: { file: join(dir, "CLAUDE.md") },
    agents: { file: join(dir, "AGENTS.md") },
    gemini: { file: join(dir, "GEMINI.md") },
    cursorRule: { file: join(dir, ".cursor", "rules", "baglam.mdc"), prefix: CURSOR_RULE_HEADER },
    copilot: { file: join(dir, ".github", "copilot-instructions.md") },
    windsurfRule: { file: join(dir, ".windsurf", "rules", "baglam.md"), prefix: WINDSURF_RULE_HEADER },
  };
}

/** Resolve the git common dir (handling normal repos and linked worktrees), or null outside git. */
function findGitDirs(dir: string): { root: string; common: string } | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m) return null;
        gitDir = resolve(d, m[1].trim());
      }
      const commonFile = join(gitDir, "commondir");
      if (existsSync(commonFile)) {
        return { root: d, common: resolve(gitDir, readFileSync(commonFile, "utf8").trim()) };
      }
      return { root: d, common: gitDir };
    }
    if (dirname(d) === d) return null;
  }
}

/** Add local-only ignore patterns to `.git/info/exclude` without touching tracked `.gitignore`. */
function addLocalExcludes(dir: string, files: string[]): string[] {
  const git = findGitDirs(dir);
  if (!git) return [];
  const excludeFile = join(git.common, "info", "exclude");
  const cur = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  const eol = cur.includes("\r\n") ? "\r\n" : "\n";
  const existing = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const relOf = (p: string) => relative(git.root, p).replace(/\\/g, "/");
  const want = [relOf(join(dir, ".baglam")) + "/", ...files.map(relOf)].filter((p) => p && !p.startsWith(".."));
  const added = want.filter((p) => !existing.has(p));
  if (!added.length) return [];
  const sep = !cur ? "" : cur.endsWith(eol) ? "" : eol;
  const header = existing.has("# Bağlam (local)") ? "" : `# Bağlam (local)${eol}`;
  mkdirSync(dirname(excludeFile), { recursive: true });
  writeFileAtomic(excludeFile, cur + sep + header + added.join(eol) + eol);
  return added;
}

export interface InitOptions {
  store: ContextStore;
  host: HostEnv;
  undo?: boolean;
  /** Make this folder its own project even though it sits inside another one. */
  here?: boolean;
  /** Keep Bağlam's files untracked via `.git/info/exclude` (never touches `.gitignore`). */
  local?: boolean;
  /** Custom display name for the project in `.baglam/project.json` and the panel. */
  name?: string;
}

/**
 * Prepare a folder for Bağlam: give it a stable identity, move records saved under its old path key,
 * and write the instructions agents read. With `undo`, remove the instructions (the identity stays).
 */
export function runInit(dir: string, opts: InitOptions): InitResult {
  const target = resolve(dir);
  const before = resolveDirectory(target);

  if (opts.undo) {
    // Undo never creates an identity; it only removes what init wrote, from every place init can write.
    const changes = Object.values(allTargets(target)).map((t): Change => ({
      client: "init",
      file: t.file,
      action: removeBlock(t.file, { prefix: t.prefix }),
    }));
    return { project: before, moved: 0, changes };
  }

  const belongsElsewhere = normalizeProject(before.dir) !== normalizeProject(target);
  if (belongsElsewhere && !opts.here) {
    throw new Error(
      `This folder is inside project "${before.name}" at ${before.dir}. Run "baglam init" there, ` +
        `or add --here to make this folder a separate project.`,
    );
  }

  // A broken marker (hand-edited, merge conflict): reuse the id this folder was last seen with.
  const current = readMarker(target);
  const previous =
    current && "error" in current
      ? opts.store.listProjects({ includeArchived: true }).find((p) => UUID.test(p.key) && p.path && normalizeProject(p.path) === normalizeProject(target))
      : undefined;
  const customName = opts.name?.trim() || undefined;
  // Throws for home/system folders before anything is written.
  const project = createMarker(target, { id: previous?.key, name: customName ?? previous?.name });
  // Always try: idempotent, and it finishes a move an earlier init could not complete.
  const moved = opts.store.rekeyProject(normalizeProject(target), project.key);
  opts.store.touchProject(project);
  if (customName) opts.store.renameProject(project.key, customName);
  const block = instructionBlock();
  const list = expectedInstructionTargets(target, opts.host);
  const changes = list.map((t): Change => ({
    client: "init",
    file: t.file,
    action: upsertBlock(t.file, block, { prefix: t.prefix }),
  }));
  const excluded = opts.local ? addLocalExcludes(target, list.map((t) => t.file)) : undefined;
  return { project, moved, changes, ...(excluded ? { excluded } : {}) };
}
