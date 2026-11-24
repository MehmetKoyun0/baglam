import type { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, renameSync, mkdtempSync, rmSync } from "node:fs";

import { join } from "node:path";
import { protectExisting } from "./private-files.js";

/** The v0.1 schema, exactly as shipped. Version 1. */
export const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  rationale     TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  audience      TEXT NOT NULL DEFAULT '["*"]',
  status        TEXT NOT NULL,
  source_agent  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT,
  decision_note TEXT,
  expires_at    INTEGER,
  supersedes    TEXT,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS entries_project_status ON entries(project, status);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body, rationale, tags, content='entries', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, rationale, tags)
  VALUES (new.rowid, new.title, new.body, coalesce(new.rationale, ''), new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, rationale, tags)
  VALUES ('delete', old.rowid, old.title, old.body, coalesce(old.rationale, ''), old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF title, body, rationale, tags ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, rationale, tags)
  VALUES ('delete', old.rowid, old.title, old.body, coalesce(old.rationale, ''), old.tags);
  INSERT INTO entries_fts(rowid, title, body, rationale, tags)
  VALUES (new.rowid, new.title, new.body, coalesce(new.rationale, ''), new.tags);
END;
`;

const V2_SCHEMA = `
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  last_path   TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT,
  project  TEXT NOT NULL,
  type     TEXT NOT NULL,
  actor    TEXT NOT NULL,
  at       INTEGER NOT NULL,
  detail   TEXT
);
CREATE INDEX events_entry ON events(entry_id);
CREATE TABLE trust_rules (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  agent      TEXT,
  kind       TEXT,
  created_at INTEGER NOT NULL
);
ALTER TABLE entries ADD COLUMN edited_at INTEGER;
ALTER TABLE entries ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0;
`;

const V6_SCHEMA = `
CREATE TABLE handoffs (
  project    TEXT NOT NULL,
  branch     TEXT NOT NULL,
  dir        TEXT,
  task_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  agent      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project, branch)
);
CREATE TABLE handoff_history (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  project  TEXT NOT NULL,
  branch   TEXT NOT NULL,
  dir      TEXT,
  task_id  TEXT NOT NULL,
  data     TEXT NOT NULL,
  agent    TEXT NOT NULL,
  at       INTEGER NOT NULL,
  replaced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX handoff_history_key ON handoff_history(project, branch, seq);
CREATE TABLE project_settings (
  project    TEXT PRIMARY KEY,
  autonomous INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL
);
ALTER TABLE entries ADD COLUMN review_state TEXT;
`;

/** Automatic saving from tool hooks: a per-project switch and when each tool's hook last fired. */
const V7_SCHEMA = `
ALTER TABLE project_settings ADD COLUMN auto_capture INTEGER NOT NULL DEFAULT 1;
CREATE TABLE hook_seen (
  client TEXT PRIMARY KEY,
  at     INTEGER NOT NULL,
  event  TEXT NOT NULL
);
`;

/**
 * The search index folds Turkish İ and ı to "i" (the tokenizer folds only ASCII I and leaves ı a
 * separate letter, so "Işık" never found "ışık"). Queries apply the same fold (foldTurkishI).
 * Triggers and the index are rebuilt from the records; never use FTS 'rebuild', it would index
 * the unfolded text.
 */
const FOLD = (x: string) => `replace(replace(${x}, 'İ', 'i'), 'ı', 'i')`;
const ftsValues = (row: "new" | "old") =>
  `${row}.rowid, ${FOLD(`${row}.title`)}, ${FOLD(`${row}.body`)}, ${FOLD(`coalesce(${row}.rationale, '')`)}, ${FOLD(`${row}.tags`)}`;
const V8_SCHEMA = `
DROP TRIGGER IF EXISTS entries_ai;
DROP TRIGGER IF EXISTS entries_ad;
DROP TRIGGER IF EXISTS entries_au;
DROP TABLE IF EXISTS entries_fts;
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, body, rationale, tags, content='entries', content_rowid='rowid'
);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body, rationale, tags) VALUES (${ftsValues("new")});
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, rationale, tags) VALUES ('delete', ${ftsValues("old")});
END;
CREATE TRIGGER entries_au AFTER UPDATE OF title, body, rationale, tags ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body, rationale, tags) VALUES ('delete', ${ftsValues("old")});
  INSERT INTO entries_fts(rowid, title, body, rationale, tags) VALUES (${ftsValues("new")});
END;
INSERT INTO entries_fts(rowid, title, body, rationale, tags)
  SELECT rowid, ${FOLD("title")}, ${FOLD("body")}, ${FOLD("coalesce(rationale, '')")}, ${FOLD("tags")} FROM entries;
`;

const V5_SCHEMA = `
CREATE INDEX IF NOT EXISTS entries_visible ON entries(project, status, kind, decided_at);
CREATE INDEX IF NOT EXISTS events_project_at ON events(project, at);
`;

const V4_SCHEMA = `
ALTER TABLE projects ADD COLUMN custom_name INTEGER NOT NULL DEFAULT 0;
`;

const V3_SCHEMA = `
ALTER TABLE entries ADD COLUMN similar_to TEXT NOT NULL DEFAULT '[]';
`;

/** Index i upgrades the database from version i to version i + 1. */
const STEPS: ((db: DatabaseSync) => void)[] = [
  (db) => db.exec(V1_SCHEMA),
  (db) => db.exec(V2_SCHEMA),
  (db) => db.exec(V3_SCHEMA),
  (db) => db.exec(V4_SCHEMA),
  (db) => db.exec(V5_SCHEMA),
  (db) => db.exec(V6_SCHEMA),
  (db) => db.exec(V7_SCHEMA),
  (db) => db.exec(V8_SCHEMA),
];

export const SCHEMA_VERSION = STEPS.length;

function currentVersion(db: DatabaseSync): number {
  const v = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (v > 0) return v;
  // v0.1 never set user_version; an existing entries table means version 1.
  const hasEntries = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'").get();
  return hasEntries ? 1 : 0;
}

/**
 * Bring the database to SCHEMA_VERSION. A file database that already holds data is
 * copied to `<path>.v<from>-backup` before it is changed.
 */
export function migrate(db: DatabaseSync, filePath: string): { from: number; to: number } {
  const seen = checkVersion(currentVersion(db));
  if (process.platform !== "win32" && filePath !== ":memory:") {
    for (let v = 1; v < SCHEMA_VERSION; v++) protectExisting(filePath + ".v" + v + "-backup");
  }
  if (seen === SCHEMA_VERSION) return { from: seen, to: seen };

  // Consistent snapshot (includes WAL content) before anything changes. Several processes may get
  // here at once; the first one writes the backup, the others find it already there.
  const backup = `${filePath}.v${seen}-backup`;
  if (seen >= 1 && filePath !== ":memory:" && !existsSync(backup)) {
    const dir = mkdtempSync(backup + "-");
    const snapshot = join(dir, "snapshot");
    try {
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      if (process.platform !== "win32") chmodSync(snapshot, 0o600);
      // Publish only a complete snapshot, without replacing another process's backup.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!existsSync(backup)) renameSync(snapshot, backup);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: another process may have migrated while we waited.
    const from = checkVersion(currentVersion(db));
    for (let v = from; v < SCHEMA_VERSION; v++) STEPS[v](db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    return { from, to: SCHEMA_VERSION };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function checkVersion(v: number): number {
  if (v > SCHEMA_VERSION) {
    throw new Error(
      `This database was written by a newer version of Bağlam (schema ${v}, this version supports ${SCHEMA_VERSION}). Update Bağlam.`,
    );
  }
  return v;
}
