import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { statSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runHook } from "../src/hook.js";
import { createMarker } from "../src/project.js";
import { ContextStore } from "../src/store.js";
import { currentBranch, fastBranch } from "../src/git.js";

const root = join(import.meta.dirname, "..");

function project(opts: { git?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "baglam-hook-"));
  if (opts.git) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const ref = createMarker(dir);
  const dbPath = join(mkdtempSync(join(tmpdir(), "baglam-hookdb-")), "b.db");
  const run = (client: string, event: string, payload: unknown) =>
    runHook([client, event], { stdin: typeof payload === "string" ? payload : JSON.stringify(payload), env: {}, dbPath, cwd: dir });
  const open = () => new ContextStore(dbPath);
  return { dir, key: ref.key, dbPath, run, open };
}

describe("runHook", () => {
  it("prompt in an initialised folder starts a task", () => {
    const p = project({ git: true });
    expect(p.run("claude-code", "prompt", { cwd: p.dir, prompt: "Build a todo app" })).toEqual({ stdout: "", code: 0 });
    const s = p.open();
    const h = s.getHandoff(p.key, "main")!;
    expect(h.goal).toBe("Build a todo app");
    expect(h.agent).toBe("claude-code");
    s.close();
  });

  it("edits and the reply land on the same task", () => {
    const p = project({ git: true });
    p.run("cursor", "prompt", { prompt: "Add search", workspace_roots: [p.dir] });
    expect(p.run("cursor", "edit", { file_path: join(p.dir, "app.js"), workspace_roots: [p.dir] }).stdout).toBe("{}");
    p.run("cursor", "stop", { text: "Search works", workspace_roots: [p.dir] });
    const s = p.open();
    const h = s.getHandoff(p.key, "main")!;
    expect([h.goal, h.files, h.now]).toEqual(["Add search", ["app.js"], "Last reply: Search works"]);
    s.close();
  });

  it("works outside git (branch '-')", () => {
    const p = project();
    p.run("gemini-cli", "prompt", { cwd: p.dir, prompt: "p" });
    const s = p.open();
    expect(s.getHandoff(p.key, "-")?.goal).toBe("p");
    s.close();
  });

  it("Cursor running Claude Code's hooks (a Cursor-shaped payload) is ignored; Cursor's own hook saves it", () => {
    const p = project({ git: true });
    const fromCursor = { prompt: "devam et", workspace_roots: [p.dir], cursor_version: "2.4.0", conversation_id: "c1", hook_event_name: "beforeSubmitPrompt" };
    expect(p.run("claude-code", "prompt", fromCursor)).toEqual({ stdout: "", code: 0 });
    p.run("claude-code", "edit", { tool_name: "Write", tool_input: { file_path: join(p.dir, "a.js") }, workspace_roots: [p.dir], cursor_version: "2.4.0" });
    const s = p.open();
    expect(s.getHandoff(p.key, "main")).toBeUndefined();
    expect(Object.keys(s.hookSeen())).toEqual([]);
    s.close();
    p.run("cursor", "prompt", fromCursor);
    const s2 = p.open();
    expect(s2.getHandoff(p.key, "main")?.agent).toBe("cursor");
    s2.close();
  });

  it("no marker: exits without opening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-nomark-"));
    const dbPath = join(tmpdir(), `baglam-never-${Date.now()}`, "b.db");
    const r = runHook(["claude-code", "prompt"], { stdin: JSON.stringify({ cwd: dir, prompt: "x" }), env: {}, dbPath, cwd: dir });
    expect(r).toEqual({ stdout: "", code: 0 });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("auto-capture off: nothing saved, but the hook is still seen", () => {
    const p = project();
    const s = p.open();
    s.setAutoCapture(p.key, false, "me");
    s.close();
    p.run("codex", "prompt", { cwd: p.dir, prompt: "x" });
    const s2 = p.open();
    expect(s2.getHandoff(p.key, "-")).toBeUndefined();
    expect(Object.keys(s2.hookSeen())).toEqual(["codex"]);
    s2.close();
  });

  it("bad JSON, empty stdin and unknown client or event still give the neutral output", () => {
    const p = project();
    expect(p.run("cursor", "prompt", "{not json")).toEqual({ stdout: '{"continue":true}', code: 0 });
    expect(p.run("gemini-cli", "stop", "")).toEqual({ stdout: "{}", code: 0 });
    expect(runHook(["nope", "prompt"], { stdin: "{}", env: {}, dbPath: p.dbPath, cwd: p.dir })).toEqual({ stdout: "", code: 0 });
    expect(runHook(["cursor", "nope"], { stdin: "{}", env: {}, dbPath: p.dbPath, cwd: p.dir })).toEqual({ stdout: "{}", code: 0 });
    expect(runHook([], { stdin: "{}", env: {}, dbPath: p.dbPath, cwd: p.dir })).toEqual({ stdout: "", code: 0 });
  });

  it("a failure is logged next to the database, never thrown", () => {
    const p = project();
    // A directory where the database file should be makes opening it fail.
    const dbPath = join(mkdtempSync(join(tmpdir(), "baglam-baddb-")), "b.db");
    mkdirSync(dbPath);
    const r = runHook(["claude-code", "prompt"], { stdin: JSON.stringify({ cwd: p.dir, prompt: "x" }), env: {}, dbPath, cwd: p.dir });
    expect(r).toEqual({ stdout: "", code: 0 });
    const log = readFileSync(join(dbPath, "..", "hook-errors.log"), "utf8");
    expect(log).toMatch(/claude-code prompt/);
    if (process.platform !== "win32") expect(statSync(join(dbPath, "..", "hook-errors.log")).mode & 0o777).toBe(0o600);
  });

  it("a locked database gives up well inside the deadline (SQLite waits block the deadline timer)", () => {
    const p = project();
    p.open().close(); // create and migrate the file first
    const holder = new DatabaseSync(p.dbPath, { timeout: 0 });
    holder.exec("BEGIN IMMEDIATE");
    try {
      const t0 = Date.now();
      expect(p.run("claude-code", "prompt", { cwd: p.dir, prompt: "x" })).toEqual({ stdout: "", code: 0 });
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(readFileSync(join(p.dbPath, "..", "hook-errors.log"), "utf8")).toMatch(/claude-code prompt: .*locked/i);
  }, 15_000);

  it("the compiled hook prints exactly the neutral output", () => {
    const p = project();
    const r = spawnSync(process.execPath, [join(root, ".test-dist", "hook.js"), "cursor", "prompt"], {
      input: JSON.stringify({ prompt: "From a real process", workspace_roots: [p.dir] }),
      encoding: "utf8",
      env: { ...process.env, BAGLAM_DB: p.dbPath },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('{"continue":true}');
    const s = p.open();
    expect(s.getHandoff(p.key, "-")?.goal).toBe("From a real process");
    s.close();
  });
});

describe("fastBranch agrees with git", () => {
  it("normal branch, fresh repo, detached head, not a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-fb-"));
    expect(fastBranch(dir)).toBe(currentBranch(dir));
    execFileSync("git", ["init", "-q", "-b", "feature/x"], { cwd: dir });
    expect(fastBranch(dir)).toBe("feature/x");
    expect(fastBranch(dir)).toBe(currentBranch(dir));
    writeFileSync(join(dir, "a.txt"), "a");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"], { cwd: dir });
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(fastBranch(sub)).toBe("feature/x");
    execFileSync("git", ["checkout", "-q", "--detach"], { cwd: dir });
    expect(fastBranch(dir)).toBe("detached");
    expect(fastBranch(dir)).toBe(currentBranch(dir));
  });

  it("a linked worktree reads its own HEAD", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-wt-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"], { cwd: dir });
    const wt = join(mkdtempSync(join(tmpdir(), "baglam-wt2-")), "w");
    execFileSync("git", ["worktree", "add", "-q", "-b", "other", wt], { cwd: dir });
    expect(fastBranch(wt)).toBe("other");
    expect(fastBranch(wt)).toBe(currentBranch(wt));
  });
});

describe("hooks firing at the same time", () => {
  it("parallel edit hooks never lose a file", async () => {
    const { spawn } = await import("node:child_process");
    const p = project();
    p.run("claude-code", "prompt", { cwd: p.dir, prompt: "Many edits" });
    const hook = join(root, ".test-dist", "hook.js");
    const one = (i: number) =>
      new Promise<void>((done) => {
        const c = spawn(process.execPath, [hook, "claude-code", "edit"], { env: { ...process.env, BAGLAM_DB: p.dbPath } });
        c.on("exit", () => done());
        c.stdin.end(JSON.stringify({ cwd: p.dir, tool_name: "Write", tool_input: { file_path: join(p.dir, `f${i}.ts`) } }));
      });
    await Promise.all(Array.from({ length: 12 }, (_, i) => one(i)));
    const s = p.open();
    expect(s.getHandoff(p.key, "-")!.files.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `f${i}.ts`).sort());
    s.close();
  }, 60_000);
});

describe("automatic context injection through hooks", () => {
  it("SessionStart / sessionStart injects live task and approved records in each tool's exact schema", () => {
    const p = project({ git: true });
    const s = p.open();
    s.addApproved({ project: p.key, kind: "warning", title: "Never touch prod DB", body: "Read-only." }, "human:ev");
    s.checkpoint({ project: p.key, branch: "main", agent: "claude-code", agentVerified: true, goal: "Todo app", next: ["Add delete button"] });
    s.close();

    const claude = JSON.parse(p.run("claude-code", "start", { cwd: p.dir }).stdout);
    expect(claude.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(claude.hookSpecificOutput.additionalContext).toContain("Todo app");
    expect(claude.hookSpecificOutput.additionalContext).toContain("Add delete button");
    expect(claude.hookSpecificOutput.additionalContext).toContain("Never touch prod DB");

    const codex = JSON.parse(p.run("codex", "start", { cwd: p.dir }).stdout);
    expect(codex.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(codex.hookSpecificOutput.additionalContext).toContain("Todo app");

    const gemini = JSON.parse(p.run("gemini-cli", "start", { cwd: p.dir }).stdout);
    expect(gemini.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(gemini.hookSpecificOutput.additionalContext).toContain("Todo app");

    const cursor = JSON.parse(p.run("cursor", "start", { workspace_roots: [p.dir] }).stdout);
    expect(cursor.additional_context).toContain("Todo app");
    expect(cursor.additional_context).toContain("Never touch prod DB");

    const vscode = JSON.parse(p.run("vscode", "start", { cwd: p.dir }).stdout);
    expect(vscode.hookSpecificOutput.additionalContext).toContain("Todo app");
    expect(vscode.hookSpecificOutput.hookEventName).toBeUndefined();
  });

  it("SessionStart stays neutral when the project has no live task and no records", () => {
    const p = project({ git: true });
    expect(p.run("claude-code", "start", { cwd: p.dir })).toEqual({ stdout: "", code: 0 });
    expect(p.run("cursor", "start", { workspace_roots: [p.dir] })).toEqual({ stdout: "{}", code: 0 });
    expect(p.run("vscode", "start", { cwd: p.dir })).toEqual({ stdout: "{}", code: 0 });
  });

  it("prompt injects the live task when switching from another agent, without spamming the same agent or repeating after SessionStart", () => {
    let now = 1_700_000_000_000;
    const p = project({ git: true });
    const runAt = (client: string, event: string, payload: unknown, env: NodeJS.ProcessEnv = {}) =>
      runHook([client, event], { stdin: JSON.stringify(payload), env, dbPath: p.dbPath, cwd: p.dir, now: () => now });

    // 1. Claude Code works on the task.
    runAt("claude-code", "prompt", { cwd: p.dir, prompt: "Build a todo app\nAdd delete later." });
    runAt("claude-code", "edit", { cwd: p.dir, tool_name: "Write", tool_input: { file_path: join(p.dir, "index.html") } });

    // Same agent next prompt -> no injection spam.
    now += 1000;
    expect(runAt("claude-code", "prompt", { cwd: p.dir, prompt: "style the header" }).stdout).toBe("");

    // 2. Codex already open (or without SessionStart): user types "devam et" -> injects Claude Code's task!
    now += 1000;
    const sw = runAt("codex", "prompt", { cwd: p.dir, prompt: "devam et" });
    const parsed = JSON.parse(sw.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Build a todo app");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("index.html");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("saved by claude-code");

    // 3. Codex next prompt -> already owns the task -> no redundant injection.
    now += 1000;
    expect(runAt("codex", "prompt", { cwd: p.dir, prompt: "make buttons red" }).stdout).toBe("");

    // 4. Fresh Claude Code session: SessionStart injects once, immediate first prompt does NOT double-inject!
    now += 1000;
    const freshStart = JSON.parse(runAt("claude-code", "start", { cwd: p.dir }).stdout);
    expect(freshStart.hookSpecificOutput.additionalContext).toContain("Build a todo app");
    now += 1000;
    expect(runAt("claude-code", "prompt", { cwd: p.dir, prompt: "devam et" }).stdout).toBe("");

    // 5. Cursor beforeSubmitPrompt ALWAYS stays {"continue":true} even when switching agents.
    now += 1000;
    expect(runAt("cursor", "prompt", { workspace_roots: [p.dir], prompt: "devam et" }).stdout).toBe('{"continue":true}');
  });

  it("BAGLAM_HOOK_INJECT=0 disables context injection while keeping auto-capture", () => {
    const p = project({ git: true });
    p.run("claude-code", "prompt", { cwd: p.dir, prompt: "Todo app" });
    const r = runHook(["codex", "prompt"], {
      stdin: JSON.stringify({ cwd: p.dir, prompt: "devam et" }),
      env: { BAGLAM_HOOK_INJECT: "0" },
      dbPath: p.dbPath,
      cwd: p.dir,
    });
    expect(r).toEqual({ stdout: "", code: 0 });
    const s = p.open();
    expect(s.getHandoff(p.key, "main")?.requests.at(-1)).toBe("devam et");
    s.close();
  });

  it("Cursor running Claude Code's SessionStart hook is ignored", () => {
    const p = project({ git: true });
    p.run("claude-code", "prompt", { cwd: p.dir, prompt: "Todo app" });
    expect(p.run("claude-code", "start", { workspace_roots: [p.dir], cursor_version: "2.4.0" })).toEqual({ stdout: "", code: 0 });
  });
});
