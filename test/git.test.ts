import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchForRequest, currentBranch, gitSnapshot } from "../src/git.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const tmp = () => mkdtempSync(join(tmpdir(), "baglam-git-"));
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });

function repo(): string {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  git(d, "add", ".");
  git(d, "commit", "-q", "-m", "first commit");
  return d;
}

describe.skipIf(!hasGit)("git snapshot", () => {
  beforeAll(() => {});

  it('not a repo → null and branch "-"', async () => {
    const d = tmp();
    expect(currentBranch(d)).toBe("-");
    expect(await gitSnapshot(d)).toBeNull();
  });

  it("a new repository without commits still has its branch name", () => {
    const d = tmp();
    git(d, "init", "-q", "-b", "main");
    expect(currentBranch(d)).toBe("main");
  });

  it("resolves unborn, detached and missing branches asynchronously for MCP", async () => {
    const d = tmp();
    expect(await branchForRequest(d)).toBe("-");
    git(d, "init", "-q", "-b", "topic");
    expect(await branchForRequest(d)).toBe("topic");
    const committed = repo();
    git(committed, "checkout", "--detach");
    expect(await branchForRequest(committed)).toBe("detached");
  });

  it("reports branch and uncommitted files", async () => {
    const d = repo();
    writeFileSync(join(d, "a.txt"), "changed");
    writeFileSync(join(d, "new file.ts"), "x");
    expect(currentBranch(d)).toBe("main");
    const s = (await gitSnapshot(d))!;
    expect(s.branch).toBe("main");
    expect(s.changedCount).toBe(2);
    expect(s.changed.sort()).toEqual(["a.txt", "new file.ts"]);
    expect(s.lastCommit?.subject).toBe("first commit");
  });

  it("commits since a time", async () => {
    const d = repo();
    const before = Date.now() - 1000;
    writeFileSync(join(d, "b.txt"), "b");
    git(d, "add", ".");
    git(d, "commit", "-q", "-m", "second commit");
    const s = (await gitSnapshot(d, before))!;
    expect(s.commitsSince.map((c) => c.subject)).toContain("second commit");
    expect(s.lastCommit).toEqual(s.commitsSince[0]);
    const later = (await gitSnapshot(d, Date.now() + 60_000))!;
    expect(later.commitsSince).toEqual([]);
    expect(later.lastCommit?.subject).toBe("second commit");
  });

  it("caps changed list at 20 with full count", async () => {
    const d = repo();
    for (let i = 0; i < 25; i++) writeFileSync(join(d, `f${i}.txt`), "x");
    const s = (await gitSnapshot(d))!;
    expect(s.changed).toHaveLength(20);
    expect(s.changedCount).toBe(25);
  });

  it("timeout returns null", async () => {
    const d = repo();
    if (process.platform === "win32") {
      // Starting a process on Windows alone takes longer than 1 ms.
      expect(await gitSnapshot(d, undefined, { timeoutMs: 1 })).toBeNull();
      return;
    }
    // Elsewhere git can answer within 1 ms, so put a git that never answers in time first on PATH.
    const { chmodSync } = await import("node:fs");
    const bin = tmp();
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 5\n");
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const t = Date.now();
      expect(await gitSnapshot(d, undefined, { timeoutMs: 300 })).toBeNull();
      expect(Date.now() - t).toBeLessThan(3000);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe.skipIf(!hasGit)("git snapshot leaves out Bağlam's own files", () => {
  it(".baglam/ is not listed as work the agent did", async () => {
    const d = repo();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(d, ".baglam"));
    writeFileSync(join(d, ".baglam", "project.json"), "{}");
    writeFileSync(join(d, "app.ts"), "x");
    const s = (await gitSnapshot(d))!;
    expect(s.changed).toEqual(["app.ts"]);
    expect(s.changedCount).toBe(1);
  });
});
