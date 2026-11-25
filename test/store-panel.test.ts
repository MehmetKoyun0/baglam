import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/store.js";

const A = "11111111-2222-4333-8444-555555555555";
const PATH_KEY = "c:/work/legacy";

describe("store: panel support", () => {
  let store: ContextStore;
  let now: number;
  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new ContextStore(":memory:", () => now);
  });

  const approved = (project = A, title = "Use pnpm", extra: Record<string, unknown> = {}) =>
    store.addApproved({ project, kind: "convention", title, body: `${title} body`, ...extra }, "human");

  it("logs only actual normalized edits, including when approving an unchanged form", () => {
    const e = store.propose({ project: A, title: "Record", body: "Body", sourceAgent: "codex", kind: "fact" });
    const form = { title: " Record ", body: "Body", kind: e.kind, rationale: "", tags: [], audience: ["*"] };
    expect(store.edit(e.id, form, "owner").editedAt).toBeNull();
    store.edit(e.id, { ...form, title: "Updated" }, "owner");
    store.editAndApprove(e.id, { ...form, title: "Updated" }, "owner");
    expect(store.history(e.id).filter(ev => ev.type === "edited").map(ev => ev.detail)).toEqual(["title"]);
  });

  it("retire hides from agents and logs", () => {
    const e = approved();
    const r = store.retire(e.id, "human", "no longer true");
    expect(r.status).toBe("retired");
    expect(store.visible(A, "cursor")).toEqual([]);
    expect(store.history(e.id).at(-1)).toMatchObject({ type: "retired", actor: "human", detail: "no longer true" });
  });

  it("retire refuses non-approved", () => {
    const p = store.propose({ project: A, kind: "fact", title: "t", body: "b", sourceAgent: "a" });
    expect(() => store.retire(p.id, "human")).toThrow(/only active records/);
  });

  it("listProjects covers uuid and path projects with counts", () => {
    store.touchProject({ key: A, name: "app", dir: "c:/work/app" });
    approved(A);
    store.propose({ project: A, kind: "fact", title: "t", body: "b", sourceAgent: "a" });
    approved(PATH_KEY, "Legacy");
    const rows = store.listProjects();
    expect(rows.find((r) => r.key === A)).toMatchObject({ name: "app", path: "c:/work/app", approved: 1, pending: 1, archived: false });
    expect(rows.find((r) => r.key === PATH_KEY)).toMatchObject({ name: "legacy", path: PATH_KEY, approved: 1, pending: 0 });
    expect(rows.every((r) => typeof r.lastActivity === "number")).toBe(true);
  });

  it("rename, archive hides from default list and restore brings back", () => {
    store.touchProject({ key: A, name: "app", dir: "c:/work/app" });
    store.renameProject(A, "Main app");
    expect(store.listProjects()[0].name).toBe("Main app");
    store.archiveProject(A, "human");
    expect(store.listProjects().map((r) => r.key)).not.toContain(A);
    expect(store.listProjects({ includeArchived: true }).find((r) => r.key === A)?.archived).toBe(true);
    store.restoreProject(A, "human");
    expect(store.listProjects().map((r) => r.key)).toContain(A);
  });

  it("touchProject keeps a custom name chosen in the panel", () => {
    store.touchProject({ key: A, name: "app", dir: "c:/work/app" });
    store.renameProject(A, "Main app");
    store.touchProject({ key: A, name: "app", dir: "c:/work/app2" });
    expect(store.listProjects()[0]).toMatchObject({ name: "Main app", path: "c:/work/app2" });
  });

  it("delete removes entries keeps events", () => {
    store.touchProject({ key: A, name: "app", dir: "c:/work/app" });
    const e = approved();
    expect(store.deleteProject(A, "human")).toBe(1);
    expect(store.get(e.id)).toBeUndefined();
    expect(store.history(e.id).map((h) => h.type)).toEqual(["proposed", "approved", "deleted"]);
    expect(store.listProjects({ includeArchived: true }).map((r) => r.key)).not.toContain(A);
  });

  it("delete also removes the project's tasks, task history and settings (no ghost card in the inbox)", () => {
    store.touchProject({ key: A, name: "app", dir: "c:/work/app" });
    store.checkpoint({ project: A, branch: "main", agent: "codex", agentVerified: true, goal: "Half done" });
    store.checkpoint({ project: A, branch: "main", agent: "codex", agentVerified: true, goal: "Next one", newTask: true });
    store.setAutonomous(A, true, "human");
    store.checkpoint({ project: "other", branch: "main", agent: "codex", agentVerified: true, goal: "Keep me" });
    store.deleteProject(A, "human");
    expect(store.listHandoffs(A)).toEqual([]);
    expect(store.handoffHistory(A, "main")).toEqual([]);
    expect(store.isAutonomous(A)).toBe(false);
    expect(store.listHandoffs("other").map((h) => h.goal)).toEqual(["Keep me"]);
  });

  it("query filters and paginates", () => {
    for (let i = 0; i < 5; i++) {
      now += 1000;
      approved(A, `Rule ${i}`);
    }
    store.propose({ project: A, kind: "fact", title: "pending one", body: "b", sourceAgent: "codex" });
    approved(PATH_KEY, "Other project");
    const page = store.query({ project: A, status: "active", limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.items.map((e) => e.title)).toEqual(["Rule 4", "Rule 3"]);
    expect(store.query({ project: A, status: "active", limit: 2, offset: 4 }).items.map((e) => e.title)).toEqual(["Rule 0"]);
    expect(store.query({ project: A, agent: "codex" }).items.map((e) => e.title)).toEqual(["pending one"]);
    expect(store.query({ kind: "fact" }).total).toBe(1);
    expect(store.query({}).total).toBe(7);
  });

  it("query text search", () => {
    approved(A, "Zebra crossing");
    approved(A, "Lion gate");
    expect(store.query({ project: A, text: "zebra" }).items.map((e) => e.title)).toEqual(["Zebra crossing"]);
    expect(store.query({ project: A, text: "!!" }).total).toBe(2);
  });

  it("dataVersion changes after another connection writes", () => {
    const file = join(mkdtempSync(join(tmpdir(), "baglam-dv-")), "t.db");
    const a = new ContextStore(file);
    const b = new ContextStore(file);
    const before = a.dataVersion();
    b.addApproved({ project: A, kind: "fact", title: "t", body: "b" }, "human");
    expect(a.dataVersion()).not.toBe(before);
    a.close();
    b.close();
  });
});

describe("store: decisions are atomic", () => {
  it("a decision made by another connection between check and write is refused", () => {
    const file = join(mkdtempSync(join(tmpdir(), "baglam-race-")), "t.db");
    const other = new ContextStore(file);
    let id = "";
    let raced = false;
    const store = new ContextStore(file, () => {
      if (id && !raced) {
        raced = true;
        other.reject(id, "cli");
      }
      return Date.now();
    });
    id = store.propose({ project: A, kind: "fact", title: "t", body: "b", sourceAgent: "a" }).id;
    expect(() => store.approve(id, "panel")).toThrow(/not pending/);
    expect(store.get(id)?.status).toBe("rejected");
    expect(store.history(id).map((h) => h.type)).toEqual(["proposed", "rejected"]);
    store.close();
    other.close();
  });

  it("approveMany approves only listed ids that are still pending", () => {
    const store = new ContextStore(":memory:");
    const a = store.propose({ project: A, kind: "fact", title: "a", body: "a", sourceAgent: "x" });
    const b = store.propose({ project: A, kind: "fact", title: "b", body: "b", sourceAgent: "x" });
    const c = store.propose({ project: A, kind: "fact", title: "c", body: "c", sourceAgent: "x" });
    store.reject(b.id, "cli");
    expect(store.approveMany([a.id, b.id, "cmissing"], "panel")).toEqual({ approved: [a.id], skipped: [b.id, "cmissing"] });
    expect(store.get(c.id)?.status).toBe("proposed");
  });

  it("countVisible stops counting at the cap", () => {
    const store = new ContextStore(":memory:");
    for (let i = 0; i < 5; i++) store.addApproved({ project: A, kind: "fact", title: `t${i}`, body: "b" }, "h");
    expect(store.countVisible(A, "x", 3)).toBe(3);
    expect(store.countVisible(A, "x")).toBe(5);
  });

  it("schema has the indexes listProjects and the brief rely on", () => {
    const store = new ContextStore(":memory:");
    expect(store.indexNames()).toEqual(expect.arrayContaining(["entries_visible", "events_project_at"]));
  });
});
