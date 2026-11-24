import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** What git can tell the next agent without any help from the previous one. */
export interface GitSnapshot {
  branch: string;
  ahead: number | null;
  behind: number | null;
  /** Uncommitted paths (first 20). */
  changed: string[];
  changedCount: number;
  /** Commits made after `since` (up to 10), newest first. */
  commitsSince: { hash: string; subject: string; at: number }[];
  lastCommit?: { hash: string; subject: string; at: number };
}

const MAX_CHANGED = 20;
/**
 * Read-only for real: --no-optional-locks keeps `git status` from taking index.lock (which would
 * race with the agent's own git add/commit); core.fsmonitor=false never runs a repo-configured hook.
 */
const GIT_SAFE = ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];
const MAX_COMMITS = 10;

function run(dir: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", GIT_SAFE.concat(args), { cwd: dir, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Current branch name; "-" when the folder is not a git work tree (or git is missing). */
export function currentBranch(dir: string): string {
  const git = (args: string[]) =>
    spawnSync("git", GIT_SAFE.concat(args), { cwd: dir, encoding: "utf8", timeout: 2000, windowsHide: true });
  // symbolic-ref also works in a fresh repository without commits (rev-parse HEAD does not), so the
  // branch key stays the same before and after the first commit.
  const sym = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  if (sym.status === 0 && sym.stdout.trim()) return sym.stdout.trim();
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  return inside.status === 0 && inside.stdout.trim() === "true" ? "detached" : "-";
}

/**
 * Same answer as currentBranch, read straight from .git/HEAD (no git process: hooks run on every
 * prompt and edit). Falls back to currentBranch for anything unusual.
 */
export function fastBranch(dir: string): string {
  try {
    for (let d = resolve(dir); ; d = dirname(d)) {
      const dotGit = join(d, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
          if (!m) return currentBranch(dir);
          gitDir = resolve(d, m[1].trim());
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        if (/^[0-9a-f]{40,64}$/.test(head)) return "detached";
        return currentBranch(dir);
      }
      if (dirname(d) === d) return "-";
    }
  } catch {
    return currentBranch(dir);
  }
}

const parseLog = (out: string) =>
  out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, at, ...subject] = line.split("\x1f");
      return { hash, at: Number(at) * 1000, subject: subject.join("\x1f") };
    });

async function snapshotHistory(dir: string, since: number | undefined, timeout: number): Promise<Pick<GitSnapshot, "commitsSince" | "lastCommit">> {
  const format = "--format=%h\x1f%ct\x1f%s";
  if (since !== undefined) {
    const recent = await run(dir, ["log", `-${MAX_COMMITS}`, `--since=@${Math.floor(since / 1000)}`, format], timeout);
    // A nonempty date-limited walk from HEAD starts with HEAD itself.
    if (recent) {
      const commits = parseLog(recent);
      return { lastCommit: commits[0], commitsSince: commits.filter((commit) => commit.at > since) };
    }
  }
  const last = await run(dir, ["log", "-1", format], timeout);
  return last ? { lastCommit: parseLog(last)[0], commitsSince: [] } : { commitsSince: [] };
}

/** Read-only snapshot of the work tree. Never throws: any failure or timeout gives null. */
export async function gitSnapshot(dir: string, since?: number, opts: { timeoutMs?: number } = {}): Promise<GitSnapshot | null> {
  const timeout = opts.timeoutMs ?? 2000;
  // Status and history are independent. Overlap process startup, which is costly on Windows.
  const [status, history] = await Promise.all([
    run(dir, ["status", "--porcelain=v1", "-b", "--untracked-files=all"], timeout),
    snapshotHistory(dir, since, timeout),
  ]);
  if (status === null) return null;
  const lines = status.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const branch = (head.split("...")[0] || "-").replace(/^No commits yet on /, "").trim() || "-";
  const ahead = /ahead (\d+)/.exec(head);
  const behind = /behind (\d+)/.exec(head);
  const tracking = head.includes("...");
  const paths = lines
    .map((l) => {
      const p = l.slice(3);
      const renamed = p.split(" -> ");
      return (renamed[1] ?? renamed[0]).replace(/^"(.*)"$/, "$1");
    })
    // Bağlam's own project marker is not work the agent did.
    .filter((p) => !p.startsWith(".baglam/"));

  return {
    branch,
    ahead: tracking ? Number(ahead?.[1] ?? 0) : null,
    behind: tracking ? Number(behind?.[1] ?? 0) : null,
    changed: paths.slice(0, MAX_CHANGED),
    changedCount: paths.length,
    ...history,
  };
}
