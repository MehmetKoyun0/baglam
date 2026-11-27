import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
import { ContextStore } from "../src/store.js";
import { SCHEMA_VERSION, V1_SCHEMA, migrate } from "../src/migrate.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "baglam-mig-")), "baglam.db");

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

describe("schema migrations", () => {
  it("fresh in-memory db ends at SCHEMA_VERSION", () => {
    const db = new DatabaseSync(":memory:");
    expect(migrate(db, ":memory:")).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["entries", "projects", "events", "trust_rules"]));
  });

  it("migrates a v0.1 file and keeps a backup", () => {
    const path = tempDb();
    const old = new DatabaseSync(path);
    old.exec(V1_SCHEMA);
    old.prepare(
      `INSERT INTO entries (id, project, kind, title, body, status, source_agent, created_at)
       VALUES ('cold1', 'c:/p', 'decision', 'Use pnpm', 'b', 'approved', 'claude-code', 1)`,
    ).run();
    old.close();

    const store = new ContextStore(path);
    const e = store.get("cold1");
    expect(e?.title).toBe("Use pnpm");
    expect(e?.editedAt).toBeNull();
    expect(e?.autoApproved).toBe(false);
    store.close();

    const db = new DatabaseSync(path);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
    expect(existsSync(path + ".v1-backup")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("restricts the database, WAL, SHM and migration backups", () => {
    const parent = mkdtempSync(join(tmpdir(), "baglam-permissions-"));
    const path = join(parent, "new", "baglam.db");
    const mode = (p: string) => statSync(p).mode & 0o777;
    const store = new ContextStore(path);
    try {
      expect(mode(join(parent, "new"))).toBe(0o700);
      for (const suffix of ["", "-wal", "-shm"]) expect(mode(path + suffix)).toBe(0o600);
    } finally {
      store.close();
    }
    const legacy = tempDb();
    const old = new DatabaseSync(legacy);
    old.exec(V1_SCHEMA);
    old.close();
    chmodSync(legacy, 0o644);
    new ContextStore(legacy).close();
    expect(mode(legacy)).toBe(0o600);
    expect(mode(legacy + ".v1-backup")).toBe(0o600);
    chmodSync(legacy + ".v1-backup", 0o644);
    new ContextStore(legacy).close();
    expect(mode(legacy + ".v1-backup")).toBe(0o600);
  });

  it("schema 3 adds similar_to, defaulting to [] for existing rows", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    const path = tempDb();
    const old = new DatabaseSync(path);
    old.exec(V1_SCHEMA);
    old.prepare(
      `INSERT INTO entries (id, project, kind, title, body, status, source_agent, created_at)
       VALUES ('cold2', 'c:/p', 'fact', 't', 'b', 'approved', 'a', 1)`,
    ).run();
    old.close();
    const store = new ContextStore(path);
    expect(store.get("cold2")?.similarTo).toEqual([]);
    store.close();
  });

  it("is idempotent", () => {
    const path = tempDb();
    new ContextStore(path).close();
    const db = new DatabaseSync(path);
    expect(migrate(db, path)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.close();
    expect(readdirSync(join(path, "..")).filter((f) => f.includes("backup"))).toEqual([]);
  });

  it("several processes opening a v0.1 file at once all succeed", async () => {
    const path = tempDb();
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL");
    old.exec(V1_SCHEMA);
    old.prepare(
      `INSERT INTO entries (id, project, kind, title, body, status, source_agent, created_at)
       VALUES ('cold1', 'c:/p', 'decision', 'Use pnpm', 'b', 'approved', 'claude-code', 1)`,
    ).run();
    old.close();

    const storeUrl = pathToFileURL(join(root, ".test-dist", "store.js")).href;
    const script = `import { ContextStore } from ${JSON.stringify(storeUrl)}; new ContextStore(${JSON.stringify(path)}).close();`;
    const run = () =>
      new Promise<string>((done) => {
        execFile(process.execPath, ["--input-type=module", "-e", script], (err, _out, stderr) =>
          done(err ? stderr.split("\n").find((l) => /Error/.test(l)) ?? String(err) : "ok"),
        );
      });
    const results = await Promise.all(Array.from({ length: 8 }, run));
    expect(results).toEqual(Array(8).fill("ok"));

    const store = new ContextStore(path);
    expect(store.get("cold1")?.title).toBe("Use pnpm");
    store.close();
    const backup = new DatabaseSync(path + ".v1-backup");
    expect((backup.prepare("SELECT title FROM entries WHERE id='cold1'").get() as { title: string }).title).toBe("Use pnpm");
    backup.close();
  }, 60_000);

  it("refuses a newer schema", () => {
    const path = tempDb();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => new ContextStore(path)).toThrow(/newer version of Bağlam/);
  });
});
