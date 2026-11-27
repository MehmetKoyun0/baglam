import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { testHost, type TestHost } from "./helpers.js";
import { ContextStore } from "../src/store.js";
import { runInit } from "../src/init.js";
import { instructionBlock } from "../src/instructions.js";
import { normalizeProject } from "../src/config.js";
import { runCli } from "../src/cli.js";

describe("baglam init", () => {
  let store: ContextStore;
  let host: TestHost;
  let dir: string;

  beforeEach(() => {
    store = new ContextStore(":memory:");
    host = testHost({ commands: { claude: () => ({ code: 0 }) } });
    dir = mkdtempSync(join(tmpdir(), "baglam-init-"));
  });

  it("creates its temporary project under the suite-owned fixture directory", () => {
    expect(join(dir, "..")).toBe(tmpdir());
    expect(tmpdir()).toMatch(/[/\\]baglam-tests-[^/\\]+$/);
  });

  it("creates marker and instruction files", () => {
    const r = runInit(dir, { store, host });
    const marker = JSON.parse(readFileSync(join(dir, ".baglam", "project.json"), "utf8"));
    expect(r.project.key).toBe(marker.id);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(instructionBlock());
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(instructionBlock());
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(false);
    expect(r.changes.map((c) => c.action)).toEqual(["added", "added"]);
    expect(store.projectInfo(marker.id)?.name).toBe(marker.name);
  });

  it("keeps existing CLAUDE.md content", () => {
    const mine = "# My rules\r\n\r\nUse tabs.\r\n";
    writeFileSync(join(dir, "CLAUDE.md"), mine);
    runInit(dir, { store, host });
    const text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(text.startsWith(mine + "\r\n<!-- baglam:start -->")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("re-running init is a no-op", () => {
    const first = runInit(dir, { store, host });
    const second = runInit(dir, { store, host });
    expect(second.project.key).toBe(first.project.key);
    expect(second.changes.every((c) => c.action === "unchanged")).toBe(true);
    expect(second.moved).toBe(0);
  });

  it("updates an outdated block in place", () => {
    writeFileSync(join(dir, "AGENTS.md"), "top\n\n<!-- baglam:start -->\nold text\n<!-- baglam:end -->\nbottom\n");
    runInit(dir, { store, host });
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(text).toBe("top\n\n" + instructionBlock() + "bottom\n");
  });

  it.each(["invalid JSON", "path id"])("repairs a %s marker with legacy records and --name", (form) => {
    const pathKey = normalizeProject(dir);
    const entry = store.addApproved({ project: pathKey, kind: "fact", title: "Old", body: "Keep me" }, "owner");
    mkdirSync(join(dir, ".baglam"));
    const file = join(dir, ".baglam", "project.json");
    writeFileSync(file, form === "path id" ? JSON.stringify({ id: pathKey }) : "{");
    const { project } = runInit(dir, { store, host, name: "Renamed" });
    expect(project.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ id: project.key, name: "Renamed" });
    expect(store.get(entry.id)?.project).toBe(project.key);
    expect(store.projectInfo(project.key)?.name).toBe("Renamed");
    expect(runInit(dir, { store, host }).project.key).toBe(project.key);
  });

  it("moves path-keyed records to the new id", () => {
    const old = store.addApproved(
      { project: normalizeProject(dir), kind: "convention", title: "Use pnpm", body: "pnpm only" },
      "human",
    );
    const r = runInit(dir, { store, host });
    expect(r.moved).toBe(1);
    expect(store.visible(r.project.key, "cursor").map((e) => e.id)).toEqual([old.id]);
    expect(store.visible(normalizeProject(dir), "cursor")).toEqual([]);
  });

  it("writes GEMINI.md and cursor rule only when those tools are detected", () => {
    mkdirSync(join(host.home, ".gemini", "antigravity"), { recursive: true });
    mkdirSync(join(host.home, ".cursor"));
    runInit(dir, { store, host });
    expect(readFileSync(join(dir, "GEMINI.md"), "utf8")).toBe(instructionBlock());
    const rule = readFileSync(join(dir, ".cursor", "rules", "baglam.mdc"), "utf8");
    expect(rule.startsWith("---\ndescription: Shared project context (Bağlam)\nalwaysApply: true\n---\n")).toBe(true);
    expect(rule).toContain(instructionBlock());
  });

  it("undo removes blocks but keeps the marker", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n");
    mkdirSync(join(host.home, ".cursor"));
    runInit(dir, { store, host });
    const r = runInit(dir, { store, host, undo: true });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# Mine\n");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".cursor", "rules", "baglam.mdc"))).toBe(false);
    expect(existsSync(join(dir, ".baglam", "project.json"))).toBe(true);
    expect(r.changes.every((c) => c.action === "removed" || c.action === "absent")).toBe(true);
  });

  it("refuses the home folder", () => {
    expect(() => runInit(homedir(), { store, host })).toThrow(/cannot be a project/);
    expect(existsSync(join(homedir(), ".baglam", "project.json"))).toBe(false);
  });

  it("cli: init prints the project id and files", () => {
    const out: string[] = [];
    const code = runCli(["init", "--project", dir], { store, project: "unused", user: "ev", print: (s) => out.push(s), host });
    expect(code).toBe(0);
    const id = JSON.parse(readFileSync(join(dir, ".baglam", "project.json"), "utf8")).id;
    const text = out.join("\n");
    expect(text).toContain(id);
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("AGENTS.md");
  });

  it("undo in a never-initialised folder creates no marker and keeps records reachable", () => {
    const old = store.addApproved({ project: normalizeProject(dir), kind: "fact", title: "Old", body: "b" }, "human");
    runInit(dir, { store, host, undo: true });
    expect(existsSync(join(dir, ".baglam", "project.json"))).toBe(false);
    const r = runInit(dir, { store, host });
    expect(r.moved).toBe(1);
    expect(store.get(old.id)?.project).toBe(r.project.key);
  });

  it("a later init still moves records left under the old key", () => {
    const first = runInit(dir, { store, host });
    const late = store.addApproved({ project: normalizeProject(dir), kind: "fact", title: "Late", body: "b" }, "human");
    const again = runInit(dir, { store, host });
    expect(again.project.key).toBe(first.project.key);
    expect(again.moved).toBe(1);
    expect(store.get(late.id)?.project).toBe(first.project.key);
  });

  it("refuses a subfolder of an existing project and leaves its records alone", () => {
    mkdirSync(join(dir, ".git"));
    const sub = join(dir, "packages", "web");
    mkdirSync(sub, { recursive: true });
    const repoWide = store.addApproved({ project: normalizeProject(dir), kind: "fact", title: "Repo", body: "b" }, "human");
    expect(() => runInit(sub, { store, host })).toThrow(/inside project/);
    expect(existsSync(join(sub, ".baglam"))).toBe(false);
    expect(store.get(repoWide.id)?.project).toBe(normalizeProject(dir));
  });

  it("--here makes a subfolder its own project without taking the parent's records", () => {
    mkdirSync(join(dir, ".git"));
    const sub = join(dir, "packages", "web");
    mkdirSync(sub, { recursive: true });
    const repoWide = store.addApproved({ project: normalizeProject(dir), kind: "fact", title: "Repo", body: "b" }, "human");
    const r = runInit(sub, { store, host, here: true });
    expect(r.moved).toBe(0);
    expect(store.get(repoWide.id)?.project).toBe(normalizeProject(dir));
  });

  it("writes CLAUDE.md only when Claude Code is installed", () => {
    const r = runInit(dir, { store, host: testHost() });
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(r.changes.map((c) => c.file)).toEqual([join(dir, "AGENTS.md")]);
  });

  it("instruction block mentions context_checkpoint", () => {
    expect(instructionBlock()).toMatch(/context_checkpoint/);
    expect(instructionBlock()).toMatch(/new_task/);
  });

  it("writes VS Code Copilot and Windsurf rules when detected, and undo removes both", () => {
    mkdirSync(join(host.appData, "Code", "User"), { recursive: true });
    mkdirSync(join(host.home, ".codeium", "windsurf"), { recursive: true });
    runInit(dir, { store, host });
    expect(readFileSync(join(dir, ".github", "copilot-instructions.md"), "utf8")).toContain(instructionBlock());
    const ws = readFileSync(join(dir, ".windsurf", "rules", "baglam.md"), "utf8");
    expect(ws.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    expect(ws).toContain(instructionBlock());
    runInit(dir, { store, host, undo: true });
    expect(existsSync(join(dir, ".github", "copilot-instructions.md"))).toBe(false);
    expect(existsSync(join(dir, ".windsurf", "rules", "baglam.md"))).toBe(false);
  });

  it("--name sets and updates the project name in marker and store", () => {
    const first = runInit(dir, { store, host, name: "Billing API" });
    expect(first.project.name).toBe("Billing API");
    expect(JSON.parse(readFileSync(join(dir, ".baglam", "project.json"), "utf8")).name).toBe("Billing API");
    expect(store.projectInfo(first.project.key)?.name).toBe("Billing API");
    const renamed = runInit(dir, { store, host, name: "Payments Core" });
    expect(renamed.project.key).toBe(first.project.key);
    expect(renamed.project.name).toBe("Payments Core");
    expect(store.projectInfo(first.project.key)?.name).toBe("Payments Core");
  });

  it("--local computes patterns relative to the linked worktree and writes the common exclude", () => {
    const common = join(dir, "main", ".git");
    const metadata = join(common, "worktrees", "feature");
    const feature = join(dir, "feature");
    mkdirSync(metadata, { recursive: true });
    mkdirSync(feature);
    writeFileSync(join(feature, ".git"), "gitdir: ../main/.git/worktrees/feature\n");
    writeFileSync(join(metadata, "commondir"), "../..\n");
    runInit(feature, { store, host, local: true });
    const exclude = readFileSync(join(common, "info", "exclude"), "utf8").split(/\r?\n/);
    expect(exclude).toEqual(expect.arrayContaining([".baglam/", "AGENTS.md"]));
  });

  it("--local excludes Bağlam files via .git/info/exclude without touching .gitignore", () => {
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    const r = runInit(dir, { store, host, local: true });
    expect(r.excluded).toEqual(expect.arrayContaining([".baglam/", "AGENTS.md", "CLAUDE.md"]));
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".baglam/");
    expect(exclude).toContain("AGENTS.md");
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    // Idempotent: re-running adds nothing duplicate.
    const again = runInit(dir, { store, host, local: true });
    expect(again.excluded).toEqual([]);
  });

  it("cli: init warns when no AI tools are connected yet", () => {
    const out: string[] = [];
    const bareHost = testHost();
    const code = runCli(["init", "--project", dir, "--name", "Demo"], { store, project: "x", user: "ev", print: (s) => out.push(s), host: bareHost });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Project: Demo");
    expect(out.join("\n")).toContain('Run "baglam setup"');
  });
});

describe("init repairs a broken marker without losing the project", () => {
  it("reuses the id this folder was registered with, so its records stay", () => {
    const store = new ContextStore(":memory:");
    const host = testHost();
    const dir = mkdtempSync(join(tmpdir(), "baglam-repair-"));
    const first = runInit(dir, { store, host }).project;
    store.addApproved({ project: first.key, kind: "decision", title: "Use pnpm", body: "Always pnpm" }, "me");
    writeFileSync(join(dir, ".baglam", "project.json"), "not json");
    const again = runInit(dir, { store, host }).project;
    expect(again.key).toBe(first.key);
    expect(JSON.parse(readFileSync(join(dir, ".baglam", "project.json"), "utf8")).id).toBe(first.key);
    expect(store.all(again.key).map((e) => e.title)).toEqual(["Use pnpm"]);
  });

  it("a folder Bağlam never saw still gets a fresh id", () => {
    const store = new ContextStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "baglam-repair2-"));
    mkdirSync(join(dir, ".baglam"));
    writeFileSync(join(dir, ".baglam", "project.json"), "{}");
    const r = runInit(dir, { store, host: testHost() }).project;
    expect(r.key).toMatch(/^[0-9a-f-]{36}$/);
  });
});
