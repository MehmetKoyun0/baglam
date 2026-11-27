import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/store.js";
import { exportJson, exportMarkdown, importJson } from "../src/portable.js";
import { runCli } from "../src/cli.js";

const P = "11111111-2222-4333-8444-555555555555";
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("export / import", () => {
  let src: ContextStore;
  beforeEach(() => {
    src = new ContextStore(":memory:");
    src.touchProject({ key: P, name: "app", dir: "c:/work/app" });
    const d = src.addApproved({ project: P, kind: "decision", title: "Use Postgres", body: "Primary DB is Postgres 16.", rationale: "Team knows it", tags: ["db"] }, "human:ev");
    src.addApproved({ project: P, kind: "warning", title: "Prod is read-only", body: "Never migrate prod from an agent.\n# not a heading" }, "human:ev");
    src.propose({ project: P, kind: "fact", title: "Pending fact", body: "b", sourceAgent: "codex" });
    src.approve(src.propose({ project: P, kind: "decision", title: "Use MySQL", body: "Switched.", sourceAgent: "codex", supersedes: d.id }).id, "human:ev");
  });

  it.each(["decision note", "event detail"])("screens imported %s before insertion", (field) => {
    const data = exportJson(src);
    const entry = data.entries[0];
    if (field === "decision note") entry.decisionNote = AWS;
    else data.events.find(ev => ev.entryId === entry.id)!.detail = AWS;
    const dst = new ContextStore(":memory:");
    expect(importJson(dst, data, { by: "owner" }).blocked.map(b => b.id)).toContain(entry.id);
    expect(dst.get(entry.id)).toBeUndefined();
    expect(importJson(dst, data, { by: "owner", force: true }).blocked).toEqual([]);
    expect(dst.get(entry.id)).toBeDefined();
    dst.close();
  });

  it("json export round-trips into an empty db", () => {
    const data = exportJson(src, { project: P });
    expect(data.format).toBe("baglam/1");
    expect(data.projects).toEqual([{ key: P, name: "app" }]);
    expect(data.entries).toHaveLength(4);
    const dst = new ContextStore(":memory:");
    const r = importJson(dst, JSON.parse(JSON.stringify(data)), { by: "human:ev" });
    expect(r).toEqual({ imported: 4, approvedNow: 2, skipped: 0, blocked: [], failures: [], handoffs: 0, autonomousInFile: [] });
    expect(dst.visible(P, "cursor").map((e) => e.title).sort()).toEqual(src.visible(P, "cursor").map((e) => e.title).sort());
    const old = data.entries.find((e) => e.title === "Use Postgres")!;
    expect(dst.get(old.id)?.status).toBe("superseded");
    expect(dst.history(old.id).map((h) => h.type)).toEqual([...src.history(old.id).map((h) => h.type), "imported"]);
    expect(dst.listProjects()[0]).toMatchObject({ key: P, name: "app" });
  });

  it("skips replacement links to another project, including forward references", () => {
    const entries = exportJson(src).entries;
    const target = entries.find((e) => e.title === "Prod is read-only")!;
    const pending = entries.find((e) => e.status === "proposed")!;
    const dst = new ContextStore(":memory:");
    const result = importJson(dst, { format: "baglam/1", entries: [
      { ...pending, project: "other", supersedes: target.id }, target,
    ] }, { by: "owner" });
    expect(result).toMatchObject({ imported: 1, skipped: 0, failures: [{ id: pending.id }] });
    expect(dst.get(pending.id)).toBeUndefined();
    expect(dst.get(target.id)?.status).toBe("approved");
    dst.close();
  });

  it("rolls back approval and history changes for a legacy out-of-project link", () => {
    const target = src.visible(P, "codex")[0];
    const pending = src.propose({ project: P, kind: "fact", title: "Replacement", body: "Text", sourceAgent: "codex" });
    const path = join(mkdtempSync(join(tmpdir(), "baglam-legacy-")), "legacy.db");
    const dst = new ContextStore(path);
    dst.importEntry(target, []);
    dst.importEntry({ ...pending, project: "other" }, []);
    // Model a row persisted before imports validated replacement projects.
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE entries SET supersedes = ? WHERE id = ?").run(target.id, pending.id);
    legacy.close();
    expect(() => dst.approve(pending.id, "owner")).toThrow(/different project/);
    expect(dst.get(pending.id)?.status).toBe("proposed");
    expect(dst.get(target.id)).toEqual(target);
    expect(dst.history(target.id)).toEqual([]);
    expect(dst.history(pending.id)).toEqual([]);
    dst.close();
  });

  it.each(["unreviewed", "kept"] as const)("round-trips %s replacements and preserves undo", (state) => {
    const original = src.visible(P, "codex")[0];
    const replacement = src.propose({ project: P, kind: "fact", title: "Replacement", body: "Text",
      sourceAgent: "codex", supersedes: original.id });
    src.approve(replacement.id, "autonomous-mode", undefined, { auto: true, review: true });
    if (state === "kept") src.keep([replacement.id], "owner");
    const dst = new ContextStore(":memory:");
    importJson(dst, JSON.parse(JSON.stringify(exportJson(src))), { by: "owner" });
    expect(dst.get(replacement.id)?.reviewState).toBe(state);
    expect(dst.unreviewed(P).map((e) => e.id)).toEqual(state === "kept" ? [] : [replacement.id]);
    expect(dst.undoAuto(replacement.id, "owner").restored?.id).toBe(original.id);
    expect(dst.get(original.id)?.status).toBe("approved");
    dst.close();
  });

  it.each(["support", null, [12], [" "], ["support", null]].map((audience) => ({ audience })))("rejects malformed audiences ($audience)", ({ audience }) => {
    const dst = new ContextStore(":memory:");
    const entry = exportJson(src).entries[0];
    expect(importJson(dst, { format: "baglam/1", entries: [{ ...entry, audience }] }, { by: "owner" }).failures)
      .toEqual([{ id: entry.id, reason: "invalid record fields" }]);
    expect(dst.get(entry.id)).toBeUndefined();
    dst.close();
  });

  it("restores a flagged handoff only with an explicit import override", () => {
    const data = { format: "baglam/1", entries: [], handoffs: [
      { project: P, branch: "main", goal: AWS, dir: "/untrusted", force: true },
    ] };
    expect(importJson(src, data, { by: "owner" }).failures).toHaveLength(1);
    expect(src.getHandoff(P, "main")).toBeUndefined();
    expect(importJson(src, data, { by: "owner", force: true }).handoffs).toBe(1);
    expect(src.getHandoff(P, "main")).toMatchObject({ goal: AWS, dir: null });
    data.handoffs[0].goal = "Changed";
    expect(importJson(src, data, { by: "owner", force: true }).handoffs).toBe(0);
    expect(src.getHandoff(P, "main")?.goal).toBe(AWS);
    expect(() => src.checkpoint({ project: P, branch: "other", agent: "codex", goal: AWS })).toThrow(/secret/);
  });

  it("reports record and handoff write failures and exits unsuccessfully", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-locked-"));
    const path = join(dir, "store.db");
    const dst = new ContextStore(path, Date.now, { busyTimeoutMs: 5 });
    const locker = new DatabaseSync(path);
    const entry = exportJson(src).entries[0];
    const file = join(dir, "archive.json");
    writeFileSync(file, JSON.stringify({ format: "baglam/1", entries: [entry],
      handoffs: [{ project: P, branch: "main", goal: "Restore work" }] }));
    const out: string[] = [];
    locker.exec("BEGIN IMMEDIATE");
    try {
      expect(runCli(["import", file], { store: dst, project: P, user: "owner", print: (s) => out.push(s) })).toBe(1);
      expect(out.join("\n")).toContain(entry.id + " not imported");
      expect(out.join("\n")).toContain(P + "/main not imported");
      expect(out.join("\n")).toMatch(/locked|busy/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
      dst.close();
    }
  });

  it("indexes history once and keeps event order for each record", () => {
    const data = exportJson(src);
    let reads = 0;
    const events = data.events.map((ev) => ({ ...ev, get entryId() { reads++; return ev.entryId; } }));
    const dst = new ContextStore(":memory:");
    importJson(dst, { ...data, events }, { by: "owner" });
    expect(reads).toBeLessThanOrEqual(events.length * 3);
    for (const e of data.entries) expect(dst.history(e.id).slice(0, -1)).toEqual(src.history(e.id));
    dst.close();
  });

  it("import is idempotent", () => {
    const data = exportJson(src, { project: P });
    const dst = new ContextStore(":memory:");
    importJson(dst, data, { by: "x" });
    expect(importJson(dst, data, { by: "x" })).toEqual({ imported: 0, approvedNow: 0, skipped: 4, blocked: [], failures: [], handoffs: 0, autonomousInFile: [] });
    expect(dst.query({ project: P }).total).toBe(4);
  });

  it("import tolerates unknown and missing optional fields", () => {
    const dst = new ContextStore(":memory:");
    const r = importJson(
      dst,
      {
        format: "baglam/1",
        futureField: true,
        entries: [
          { id: "cimport01", project: P, kind: "fact", title: "Minimal", body: "only required fields", status: "approved", sourceAgent: "human", createdAt: 1, extra: "x" },
          { id: "cimport02", project: P, kind: "nonsense", title: "Bad kind", body: "b", status: "approved", sourceAgent: "a", createdAt: 1 },
          { title: "no id" },
        ],
      },
      { by: "x" },
    );
    expect(r.imported).toBe(1);
    expect(r.failures).toHaveLength(2);
    expect(dst.get("cimport01")).toMatchObject({ title: "Minimal", tags: [], audience: ["*"] });
  });

  it("rejects files that are not Bağlam exports", () => {
    expect(() => importJson(new ContextStore(":memory:"), { hello: 1 }, { by: "x" })).toThrow(/not a Bağlam export/);
  });

  it("import blocks secrets unless --force", () => {
    const data = { format: "baglam/1", entries: [{ id: "csecret01", project: P, kind: "fact", title: "Key", body: `use ${AWS}`, status: "approved", sourceAgent: "a", createdAt: 1 }] };
    const dst = new ContextStore(":memory:");
    const r = importJson(dst, data, { by: "x" });
    expect(r.imported).toBe(0);
    expect(r.blocked[0]).toMatchObject({ id: "csecret01" });
    expect(importJson(dst, data, { by: "x", force: true }).imported).toBe(1);
  });

  it("md export groups active records by kind and quotes bodies", () => {
    const md = exportMarkdown(src, P);
    expect(md).toMatch(/^# Shared project context: app/);
    expect(md.indexOf("## Warnings")).toBeLessThan(md.indexOf("## Decisions"));
    expect(md).toContain("### Use MySQL");
    expect(md).not.toContain("Use Postgres"); // superseded
    expect(md).not.toContain("Pending fact");
    expect(md).toContain("> # not a heading");
    expect(md).not.toMatch(/^# not a heading/m);
  });

  it("cli export/import", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-port-"));
    const file = join(dir, "out.json");
    const out: string[] = [];
    const ctx = (store: ContextStore) => ({ store, project: P, user: "human:ev", print: (s: string) => out.push(s) });
    expect(runCli(["export", "--format", "json", "--out", file], ctx(src))).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(4);
    const dst = new ContextStore(":memory:");
    expect(runCli(["import", file], ctx(dst))).toBe(0);
    expect(out.join("\n")).toMatch(/Imported 4/);
    out.length = 0;
    expect(runCli(["export", "--format", "md"], ctx(src))).toBe(0);
    expect(out.join("\n")).toContain("# Shared project context");
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(runCli(["import", join(dir, "bad.json")], ctx(dst))).toBe(1);
  });
});

describe("export / import at scale and edge cases", () => {
  const Q = "99999999-2222-4333-8444-555555555555";
  const fill = (s: ContextStore, project: string, n: number) => {
    for (let i = 0; i < n; i++) s.addApproved({ project, kind: "fact", title: `Fact ${i} ${project.slice(0, 4)}`, body: `Body ${i}` }, "human");
  };

  it("all-projects json export keeps every record of every project", () => {
    const s = new ContextStore(":memory:");
    s.touchProject({ key: P, name: "a", dir: "c:/a" });
    s.touchProject({ key: Q, name: "b", dir: "c:/b" });
    fill(s, P, 600);
    fill(s, Q, 600);
    expect(exportJson(s).entries).toHaveLength(1200);
  }, 60_000);

  it("exports pages and history from one snapshot while another connection commits", () => {
    const path = join(mkdtempSync(join(tmpdir(), "baglam-snapshot-")), "store.db");
    const reader = new ContextStore(path);
    const writer = new ContextStore(path);
    try {
      // Seed more than one export page with one SQLite commit. Only the write
      // between pages needs to go through the store's normal record lifecycle.
      const seed = new DatabaseSync(path);
      try {
        seed.prepare(`
          WITH RECURSIVE ids(n) AS (
            SELECT 1
            UNION ALL
            SELECT n + 1 FROM ids WHERE n < 501
          )
          INSERT INTO entries (id, project, kind, title, body, status, source_agent, created_at, decided_at)
          SELECT printf('cseed%03d', n), ?, 'fact', 'Fixture ' || n, 'Body', 'approved', 'human', n, n FROM ids
        `).run(P);
      } finally {
        seed.close();
      }
      const before = exportJson(reader);
      expect(before.entries).toHaveLength(501);
      const originalQuery = reader.query.bind(reader);
      vi.spyOn(reader, "query").mockImplementationOnce((opts) => {
        const first = originalQuery(opts);
        writer.retire(first.items[0].id, "later");
        fill(writer, P, 1);
        return first;
      });
      const after = exportJson(reader);
      expect(after.entries).toEqual(before.entries);
      expect(after.events).toEqual(before.events);
      expect(writer.query({ project: P }).total).toBe(502);
    } finally {
      writer.close();
      reader.close();
    }
  });

  it("md export includes every active record", () => {
    const s = new ContextStore(":memory:");
    s.touchProject({ key: P, name: "a", dir: "c:/a" });
    fill(s, P, 600);
    const md = exportMarkdown(s, P);
    expect(md).toContain("600 active record(s)");
    expect(md).toContain("### Fact 0 1111");
    expect(md).toContain("### Fact 599 1111");
  }, 60_000);

  it("md export escapes HTML in titles, reasons and tags", () => {
    const s = new ContextStore(":memory:");
    s.addApproved({ project: P, kind: "fact", title: "<img src=x onerror=alert(1)>", body: "b", rationale: "<b>why</b>", tags: ["<i>t</i>"] }, "human");
    const md = exportMarkdown(s, P);
    expect(md).not.toMatch(/<img|<b>|<i>/);
    expect(md).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("import records who imported each record and drops unknown event types", () => {
    const s = new ContextStore(":memory:");
    const data = {
      format: "baglam/1",
      entries: [{ id: "cimp00001", project: P, kind: "fact", title: "T", body: "B", status: "approved", sourceAgent: "a", createdAt: 1, decidedBy: "human:boss" }],
      events: [
        { entryId: "cimp00001", type: "approved", actor: "human:boss", at: 1, detail: null },
        { entryId: "cimp00001", type: "anything", actor: "x", at: 2, detail: null },
      ],
    };
    importJson(s, data, { by: "human:ev", source: "backup.json" });
    const h = s.history("cimp00001");
    expect(h.map((e) => e.type)).toEqual(["approved", "imported"]);
    expect(h.at(-1)).toMatchObject({ actor: "human:ev", detail: "backup.json" });
  });

  it("import restores an archived project", () => {
    const s = new ContextStore(":memory:");
    s.touchProject({ key: P, name: "app", dir: "c:/app" });
    s.archiveProject(P, "human");
    importJson(s, { format: "baglam/1", projects: [{ key: P, name: "app" }], entries: [] }, { by: "x" });
    expect(s.listProjects().map((p) => p.key)).toContain(P);
  });

  it("cli: import says how many records arrive already approved; md ignores no flags silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "baglam-port2-"));
    const file = join(dir, "x.json");
    writeFileSync(file, JSON.stringify({ format: "baglam/1", entries: [{ id: "cimp00002", project: P, kind: "fact", title: "T", body: "B", status: "approved", sourceAgent: "a", createdAt: 1 }] }));
    const out: string[] = [];
    const dst = new ContextStore(":memory:");
    expect(runCli(["import", file], { store: dst, project: P, user: "human:ev", print: (s) => out.push(s) })).toBe(0);
    expect(out.join("\n")).toMatch(/1 of them (is|are) approved and visible to agents now/);
    out.length = 0;
    expect(runCli(["export", "--format", "md", "--all-projects"], { store: dst, project: P, user: "u", print: (s) => out.push(s) })).toBe(1);
    expect(out.join("\n")).toMatch(/one project at a time/);
  });
});

describe("export / import of work in progress", () => {
  const P2 = "11111111-2222-4333-8444-555555555555";
  it("exports live handoffs and autonomous mode; import restores the handoff and reports the mode", () => {
    const src = new ContextStore(":memory:");
    src.touchProject({ key: P2, name: "app", dir: "c:/app" });
    src.checkpoint({ project: P2, branch: "main", agent: "claude-code", goal: "Stripe checkout", next: ["tests"] });
    src.setAutonomous(P2, true, "human");
    const data = exportJson(src, { project: P2 });
    expect(data.handoffs?.map((h) => h.goal)).toEqual(["Stripe checkout"]);
    expect(data.settings).toEqual([{ project: P2, autonomous: true }]);

    const dst = new ContextStore(":memory:");
    const r = importJson(dst, JSON.parse(JSON.stringify(data)), { by: "human:ev" });
    expect(r.handoffs).toBe(1);
    expect(dst.getHandoff(P2, "main")?.next).toEqual(["tests"]);
    // Turning on autonomous mode removes a review step: an import never does it silently.
    expect(dst.isAutonomous(P2)).toBe(false);
    expect(r.autonomousInFile).toEqual([P2]);
  });

  it("import never replaces a live handoff that already exists", () => {
    const src = new ContextStore(":memory:");
    src.checkpoint({ project: P2, branch: "main", agent: "a", goal: "Old from file" });
    const data = exportJson(src, { project: P2 });
    const dst = new ContextStore(":memory:");
    dst.checkpoint({ project: P2, branch: "main", agent: "b", goal: "Current work" });
    const r = importJson(dst, data, { by: "x" });
    expect(r.handoffs).toBe(0);
    expect(dst.getHandoff(P2, "main")?.goal).toBe("Current work");
  });

  it("an imported handoff with a secret is not imported", () => {
    const dst = new ContextStore(":memory:");
    const r = importJson(
      dst,
      { format: "baglam/1", entries: [], handoffs: [{ project: P2, branch: "main", agent: "a", goal: "g", notes: ["AKIA", "IOSFODNN7EXAMPLE"].join(""), status: "in_progress", updatedAt: Date.now() }] },
      { by: "x" },
    );
    expect(r.handoffs).toBe(0);
    expect(dst.getHandoff(P2, "main")).toBeUndefined();
  });

  it("export/import keeps the full request, recent requests, auto-only state, and turned-off auto-capture", () => {
    const src = new ContextStore(":memory:");
    src.touchProject({ key: P2, name: "secret-app", dir: "c:/secret" });
    const plan = "Build billing.\nPart 1: invoices.\nPart 2: refunds.";
    src.autoCapture({ project: P2, branch: "main", dir: "c:/secret", agent: "claude-code", event: { kind: "prompt", text: plan } });
    src.autoCapture({ project: P2, branch: "main", dir: "c:/secret", agent: "claude-code", event: { kind: "prompt", text: "devam et" } });
    src.setAutoCapture(P2, false, "human:ev");

    const data = exportJson(src, { project: P2 });
    expect(data.settings).toEqual([{ project: P2, autonomous: false, autoCapture: false }]);

    const dst = new ContextStore(":memory:");
    const r = importJson(dst, JSON.parse(JSON.stringify(data)), { by: "human:ev" });
    expect(r.handoffs).toBe(1);
    const h = dst.getHandoff(P2, "main")!;
    expect(h.request).toBe(plan);
    expect(h.requests).toEqual(["Build billing.", "devam et"]);
    expect(h.agentAt).toBeNull();
    // Privacy setting survives backup/restore: auto-capture stays off on the new machine.
    expect(dst.isAutoCapture(P2)).toBe(false);
  });

  it("BAGLAM_AUTO_CAPTURE=0 during export does not mark projects as auto-capture off", () => {
    const src = new ContextStore(":memory:");
    src.touchProject({ key: P2, name: "app", dir: "c:/app" });
    const prev = process.env.BAGLAM_AUTO_CAPTURE;
    process.env.BAGLAM_AUTO_CAPTURE = "0";
    try {
      const data = exportJson(src, { project: P2 });
      expect(data.settings).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BAGLAM_AUTO_CAPTURE;
      else process.env.BAGLAM_AUTO_CAPTURE = prev;
    }
  });
});
