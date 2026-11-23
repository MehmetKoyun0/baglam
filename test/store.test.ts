import { describe, it, expect, beforeEach } from "vitest";
import { ContextStore } from "../src/store.js";

const P = "c:/work/app";

describe("ContextStore", () => {
  let store: ContextStore;
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new ContextStore(":memory:", () => now);
  });

  const propose = (over: Partial<Parameters<ContextStore["propose"]>[0]> = {}) =>
    store.propose({
      project: P,
      kind: "decision",
      title: "Use Postgres",
      body: "Primary database is Postgres 16.",
      sourceAgent: "claude-code",
      ...over,
    });

  it("new proposals are pending and invisible to agents", () => {
    const e = propose();
    expect(e.status).toBe("proposed");
    expect(store.visible(P, "cursor")).toHaveLength(0);
    expect(store.pending(P).map((x) => x.id)).toEqual([e.id]);
  });

  it("approved entries are visible to every agent when audience is '*'", () => {
    const e = propose();
    store.approve(e.id, "human");
    expect(store.visible(P, "cursor").map((x) => x.id)).toEqual([e.id]);
    expect(store.visible(P, "codex")).toHaveLength(1);
    expect(store.get(e.id)?.decidedBy).toBe("human");
  });

  it("audience restricts visibility to named agents", () => {
    const e = propose({ audience: ["support-agent"] });
    store.approve(e.id, "human");
    expect(store.visible(P, "support-agent")).toHaveLength(1);
    expect(store.visible(P, "cursor")).toHaveLength(0);
  });

  it("entries are isolated per project", () => {
    store.approve(propose().id, "human");
    expect(store.visible("c:/work/other", "cursor")).toHaveLength(0);
  });

  it("expired entries disappear", () => {
    const e = propose({ ttlDays: 7 });
    store.approve(e.id, "human");
    now += 6 * 86_400_000;
    expect(store.visible(P, "cursor")).toHaveLength(1);
    now += 2 * 86_400_000;
    expect(store.visible(P, "cursor")).toHaveLength(0);
  });

  it("approving a superseding entry retires the old one", () => {
    const old = propose();
    store.approve(old.id, "human");
    const next = propose({ title: "Use MySQL", body: "Switched to MySQL 8.", supersedes: old.id });
    expect(store.visible(P, "cursor").map((x) => x.id)).toEqual([old.id]);
    store.approve(next.id, "human");
    expect(store.visible(P, "cursor").map((x) => x.id)).toEqual([next.id]);
    const retired = store.get(old.id)!;
    expect(retired.status).toBe("superseded");
    expect(retired.supersededBy).toBe(next.id);
  });

  it("approves a replacement after the project is rekeyed before the write transaction", () => {
    const project = "c:/work/moved";
    let beforeApproval: (() => void) | undefined;
    const db = new ContextStore(":memory:", () => {
      const callback = beforeApproval;
      beforeApproval = undefined;
      callback?.();
      return now;
    });
    try {
      const original = db.addApproved({ project: P, kind: "fact", title: "Original", body: "Old" }, "human");
      const replacement = db.propose({
        project: P, kind: "fact", title: "Replacement", body: "New", sourceAgent: "codex", supersedes: original.id,
      });
      beforeApproval = () => db.rekeyProject(P, project);
      expect(db.approve(replacement.id, "human")).toMatchObject({ project, status: "approved" });
      expect(db.get(original.id)).toMatchObject({ project, status: "superseded", supersededBy: replacement.id });
      expect(db.eventsOf([original.id, replacement.id]).every((event) => event.project === project)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rejects supersedes pointing at another project or unknown id", () => {
    expect(() => propose({ supersedes: "nope" })).toThrow(/unknown/i);
    const other = propose({ project: "c:/x" });
    expect(() => propose({ supersedes: other.id })).toThrow(/project/i);
  });

  it("rejected entries never become visible and cannot be approved later", () => {
    const e = propose();
    store.reject(e.id, "human", "wrong");
    expect(store.get(e.id)?.status).toBe("rejected");
    expect(store.get(e.id)?.decisionNote).toBe("wrong");
    expect(() => store.approve(e.id, "human")).toThrow(/not pending/i);
  });

  it("full-text search finds visible entries only", () => {
    const a = propose({ title: "Tabs vs spaces", body: "Use two-space indentation.", kind: "convention" });
    propose({ title: "Secret plan", body: "indentation tricks" }); // pending
    store.approve(a.id, "human");
    const hits = store.search(P, "cursor", "indentation");
    expect(hits.map((h) => h.id)).toEqual([a.id]);
    expect(store.search(P, "cursor", "indentation", { kind: "decision" })).toHaveLength(0);
  });

  it("search tolerates punctuation and FTS operators in user queries", () => {
    store.approve(propose({ body: "Node.js 22 \"LTS\" (required)" }).id, "human");
    expect(() => store.search(P, "cursor", 'node.js "LTS" OR (AND')).not.toThrow();
    expect(store.search(P, "cursor", "node.js")).toHaveLength(1);
  });

  it("addApproved creates an immediately visible human entry", () => {
    const e = store.addApproved({ project: P, kind: "preference", title: "Turkish UI", body: "UI copy is Turkish." }, "human");
    expect(e.status).toBe("approved");
    expect(e.sourceAgent).toBe("human");
    expect(store.visible(P, "cursor")).toHaveLength(1);
  });

  it("validates kind and required text", () => {
    expect(() => propose({ kind: "rumor" as never })).toThrow(/kind/i);
    expect(() => propose({ title: "  " })).toThrow(/title/i);
  });

  it("persists tags and audience as arrays", () => {
    const e = propose({ tags: ["db", "infra"], audience: ["cursor", "codex"] });
    const got = store.get(e.id)!;
    expect(got.tags).toEqual(["db", "infra"]);
    expect(got.audience).toEqual(["cursor", "codex"]);
  });

  it("lists projects with counts", () => {
    store.approve(propose().id, "human");
    propose();
    expect(store.projects()).toEqual([{ project: P, approved: 1, pending: 1 }]);
  });

  it("records history for propose → approve → supersede", () => {
    const old = propose();
    store.approve(old.id, "human");
    store.approve(propose({ title: "Use MySQL", supersedes: old.id }).id, "human");
    const h = store.history(old.id);
    expect(h.map((x) => x.type)).toEqual(["proposed", "approved", "superseded"]);
    expect(h.map((x) => x.actor)).toEqual(["claude-code", "human", "human"]);
  });

  it("records the reject note in history", () => {
    const e = propose();
    store.reject(e.id, "human", "we use npm");
    expect(store.history(e.id).at(-1)).toMatchObject({ type: "rejected", detail: "we use npm" });
  });

  it("edit updates fields, FTS and history", () => {
    const e = propose();
    store.approve(e.id, "human");
    now += 1000;
    const edited = store.edit(e.id, { body: "Postgres, zebra edition." }, "human");
    expect(edited.body).toBe("Postgres, zebra edition.");
    expect(edited.editedAt).toBe(now);
    expect(store.search(P, "cursor", "zebra").map((x) => x.id)).toEqual([e.id]);
    expect(store.history(e.id).at(-1)).toMatchObject({ type: "edited", actor: "human", detail: "body" });
  });

  it("edit validates like propose", () => {
    const e = propose();
    expect(() => store.edit(e.id, { title: " " }, "human")).toThrow(/title/);
    expect(() => store.edit(e.id, { kind: "rumor" as never }, "human")).toThrow(/kind/);
  });

  it("edit refuses rejected/superseded", () => {
    const e = propose();
    store.reject(e.id, "human");
    expect(() => store.edit(e.id, { body: "x" }, "human")).toThrow(/cannot edit/);
  });

  it("touchProject upserts", () => {
    const id = "0b8f3c2e-1111-4222-8333-444455556666";
    store.touchProject({ key: id, name: "old", dir: "c:/a" });
    store.touchProject({ key: id, name: "new", dir: "c:/b" });
    expect(store.projectInfo(id)).toMatchObject({ id, name: "new", lastPath: "c:/b" });
  });

  it("touchProject ignores path-keyed projects", () => {
    store.touchProject({ key: "c:/work/app", name: "app", dir: "c:/work/app" });
    expect(store.projectInfo("c:/work/app")).toBeUndefined();
  });
});

describe("ContextStore.edit with partial patches", () => {
  it("treats undefined fields as unchanged", () => {
    const store = new ContextStore(":memory:");
    const e = store.propose({ project: "p", kind: "warning", title: "t", body: "b", sourceAgent: "a" });
    const edited = store.edit(e.id, { body: "new", kind: undefined, title: undefined }, "human");
    expect(edited).toMatchObject({ kind: "warning", title: "t", body: "new" });
    expect(store.history(e.id).at(-1)?.detail).toBe("body");
  });
});

describe("visible() for the brief", () => {
  it("returns warnings first, then decisions, conventions, preferences, facts; and counts the rest", () => {
    const store = new ContextStore(":memory:");
    for (const kind of ["fact", "preference", "convention", "decision", "warning"] as const) {
      store.addApproved({ project: "p", kind, title: kind, body: "b" }, "h");
    }
    expect(store.visible("p", "a", { limit: 3, byPriority: true }).map((e) => e.kind)).toEqual(["warning", "decision", "convention"]);
    expect(store.countVisible("p", "a")).toBe(5);
  });
});

describe("search finds words with suffixes (Turkish and English)", () => {
  it("imza finds imzasını, ödeme finds ödemeler, deploy finds deployment", () => {
    const s = new ContextStore(":memory:");
    for (const [title, body] of [["Webhook imzasını her zaman doğrula", "Stripe"], ["Ödemeler kuruş olarak", "integer"], ["Staging deployment", "every Friday"]]) {
      s.addApproved({ project: "p", kind: "decision", title, body }, "me");
    }
    const titles = (q: string) => s.search("p", "codex", q).map((e) => e.title);
    expect(titles("imza")).toEqual(["Webhook imzasını her zaman doğrula"]);
    expect(titles("ödeme")).toEqual(["Ödemeler kuruş olarak"]);
    expect(titles("deploy")).toEqual(["Staging deployment"]);
    expect(s.query({ project: "p", text: "imza" }).items.map((e) => e.title)).toEqual(["Webhook imzasını her zaman doğrula"]);
    expect(titles("imza doğrula")).toEqual(["Webhook imzasını her zaman doğrula"]);
    expect(titles("imza kuruş")).toEqual([]);
  });

  it("Turkish İ/ı: ışık, Işık, ISIK and isik all find each other; İmza finds imza", () => {
    const s = new ContextStore(":memory:");
    s.addApproved({ project: "p", kind: "decision", title: "Işık ayarı panelde", body: "Karanlık tema" }, "me");
    s.addApproved({ project: "p", kind: "convention", title: "İmza her istekte doğrulanır", body: "Webhook" }, "me");
    const titles = (q: string) => s.search("p", "codex", q).map((e) => e.title);
    for (const q of ["ışık", "Işık", "IŞIK", "isik"]) expect(titles(q)).toEqual(["Işık ayarı panelde"]);
    for (const q of ["imza", "İmza", "IMZA", "İMZA"]) expect(titles(q)).toEqual(["İmza her istekte doğrulanır"]);
    expect(titles("karanlik")).toEqual(["Işık ayarı panelde"]);
  });

  it("a database from schema 7 is re-indexed on upgrade, so old records are found the new way", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(mkdtempSync(join(tmpdir(), "baglam-fold-")), "b.db");
    const s1 = new ContextStore(path);
    s1.addApproved({ project: "p", kind: "fact", title: "Işık sensörü", body: "x" }, "me");
    s1.close();
    // Make it look like schema 7: the old index without İ/ı folding.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP TRIGGER entries_ai; DROP TRIGGER entries_ad; DROP TRIGGER entries_au; DROP TABLE entries_fts;
      CREATE VIRTUAL TABLE entries_fts USING fts5(title, body, rationale, tags, content='entries', content_rowid='rowid');
      INSERT INTO entries_fts(entries_fts) VALUES ('rebuild'); PRAGMA user_version = 7;`);
    raw.close();
    const s2 = new ContextStore(path);
    expect(s2.search("p", "codex", "isik").map((e) => e.title)).toEqual(["Işık sensörü"]);
    s2.close();
  });
});
