import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { migrate } from "./migrate.js";
import { HandoffRepo, type CheckpointInput, type Handoff } from "./handoff.js";
import { planAutoEvent, type AutoEvent } from "./capture.js";

export const KINDS = ["decision", "convention", "preference", "fact", "warning"] as const;
export type Kind = (typeof KINDS)[number];

/** The order a brief keeps records in when it has to cut. */
const PRIORITY: Kind[] = ["warning", "decision", "convention", "preference", "fact"];
export type Status = "proposed" | "approved" | "rejected" | "superseded" | "retired";

export interface Entry {
  id: string;
  project: string;
  kind: Kind;
  title: string;
  body: string;
  rationale: string | null;
  tags: string[];
  audience: string[];
  status: Status;
  sourceAgent: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  expiresAt: number | null;
  supersedes: string | null;
  supersededBy: string | null;
  editedAt: number | null;
  autoApproved: boolean;
  /** Ids of records that looked like this one when it was proposed. */
  similarTo: string[];
  /** Autonomous mode: shared before the owner looked at it ("unreviewed"), then "kept". */
  reviewState: "unreviewed" | "kept" | null;
}

export interface NewEntry {
  project: string;
  kind: Kind;
  title: string;
  body: string;
  rationale?: string;
  tags?: string[];
  /** Agent names allowed to see this entry. Omitted or empty means everyone ("*"). */
  audience?: string[];
  ttlDays?: number;
  supersedes?: string;
  /** Ids of similar records found at proposal time (set by the proposal policy). */
  similarTo?: string[];
}

export type EventType =
  | "proposed" | "approved" | "rejected" | "superseded" | "edited" | "expired" | "deleted"
  | "retired" | "archived" | "restored" | "imported";

export interface HistoryEvent {
  type: EventType;
  actor: string;
  at: number;
  detail: string | null;
}

export type EntryPatch = Partial<Pick<NewEntry, "title" | "body" | "rationale" | "tags" | "audience" | "kind">>;

export interface TrustRule {
  id: string;
  /** null = applies to every project. */
  projectId: string | null;
  agent: string | null;
  kind: Kind | null;
  createdAt: number;
}

export interface ProjectRow {
  key: string;
  name: string;
  path: string | null;
  archived: boolean;
  approved: number;
  pending: number;
  lastActivity: number | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  lastPath: string | null;
  createdAt: number;
  archivedAt: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectSummary {
  project: string;
  approved: number;
  pending: number;
}

const DAY_MS = 86_400_000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** SQL fragment: entry `e` is visible to the agent bound at `:agent`, at time `:now`. */
const ACCESSIBLE = `
  e.project = :project
  AND (e.expires_at IS NULL OR e.expires_at > :now)
  AND (e.audience = '["*"]' OR EXISTS (SELECT 1 FROM json_each(e.audience) WHERE value IN ('*', :agent)))
`;

const VISIBLE = ACCESSIBLE + " AND e.status = 'approved'";

type Row = Record<string, SQLInputValue>;

function newId(): string {
  const bytes = randomBytes(8);
  let id = "c";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

function cleanList(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))];
}

function requireText(value: string | undefined, field: string, max: number): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${field} is required`);
  if (v.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return v;
}

/**
 * Turkish dotted İ and dotless ı both become "i", the same fold the search index applies (schema 8),
 * so "Işık", "ışık", "ISIK" and "isik" match each other and "İmza".toLowerCase() stays one word.
 */
export function foldTurkishI(text: string): string {
  return text.normalize("NFC").replace(/[İı]/g, "i");
}

/** Turn free text into a safe FTS5 query: every word must match, no operators. */
export function toFtsQuery(text: string): string | null {
  const words = foldTurkishI(text).match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  // Prefix match from 3 letters: Turkish words take suffixes ("imza" → "imzasını"), English ones
  // endings ("deploy" → "deployment"). Shorter words stay exact so "go" does not match everything.
  return words.map((w) => ([...w].length >= 3 ? `"${w}"*` : `"${w}"`)).join(" ");
}

function toEntry(r: Row): Entry {
  return {
    id: r.id as string,
    project: r.project as string,
    kind: r.kind as Kind,
    title: r.title as string,
    body: r.body as string,
    rationale: (r.rationale as string | null) ?? null,
    tags: JSON.parse(r.tags as string),
    audience: JSON.parse(r.audience as string),
    status: r.status as Status,
    sourceAgent: r.source_agent as string,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    supersedes: (r.supersedes as string | null) ?? null,
    supersededBy: (r.superseded_by as string | null) ?? null,
    editedAt: r.edited_at == null ? null : Number(r.edited_at),
    autoApproved: Number(r.auto_approved ?? 0) === 1,
    similarTo: JSON.parse((r.similar_to as string | undefined) ?? "[]"),
    reviewState: ((r.review_state as string | null | undefined) ?? null) as Entry["reviewState"],
  };
}

/** Lower-cased words of 3+ letters/digits (Unicode-aware), as a set. */
function wordSet(text: string): Set<string> {
  // İ/ı folded first, then plain toLowerCase: "İmza" would otherwise become "i̇mza" and split.
  return new Set(foldTurkishI(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Validate the editable fields of a record; returns DB-ready values. */
function validate(input: {
  kind: Kind; title: string; body: string; rationale?: string | null; tags?: string[]; audience?: string[];
}) {
  if (!KINDS.includes(input.kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  const audience = cleanList(input.audience).filter((a) => a !== "*");
  return {
    kind: input.kind,
    title: requireText(input.title, "title", 200),
    body: requireText(input.body, "body", 8000),
    rationale: input.rationale?.trim() ? requireText(input.rationale, "rationale", 4000) : null,
    tags: JSON.stringify(cleanList(input.tags)),
    audience: JSON.stringify(audience.length ? audience : ["*"]),
  };
}

export class ContextStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly clock: () => number = Date.now,
    opts: { busyTimeoutMs?: number } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    // Busy timeout first: several agents' servers may open (and migrate) the same file at once.
    this.db = new DatabaseSync(path, { timeout: opts.busyTimeoutMs ?? 5000 });
    // WAL + synchronous=NORMAL: never corrupts; at worst the last commit is lost on power failure.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    migrate(this.db, path);
    this.handoffs = new HandoffRepo(this.db, this.clock, (fn) => this.transaction(fn));
  }

  close(): void {
    this.db.close();
  }

  /** An agent proposes an entry. It stays invisible until a human approves it. */
  propose(input: NewEntry & { sourceAgent: string }): Entry {
    return this.insert(input, requireText(input.sourceAgent, "sourceAgent", 100), "proposed");
  }

  /** A human adds an entry directly; it is approved at once. */
  addApproved(input: NewEntry, by: string): Entry {
    const e = this.insert(input, by, "proposed");
    return this.approve(e.id, by);
  }

  get(id: string): Entry | undefined {
    const r = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Row | undefined;
    return r ? toEntry(r) : undefined;
  }

  getForAgent(id: string, project: string, agent: string): Entry | undefined {
    const row = this.db.prepare(
      "SELECT e.* FROM entries e WHERE " + ACCESSIBLE +
      " AND e.id = :id AND e.status IN ('approved', 'retired', 'superseded')",
    ).get({ id, project, agent, now: this.clock() }) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  approve(id: string, by: string, note?: string, opts: { auto?: boolean; review?: boolean } = {}): Entry {
    const now = this.clock();
    return this.transaction(() => {
      const e = this.mustBePending(id);
      this.approveRow(e, by, note, opts.auto ?? false, now, opts.review ?? false);
      return this.get(id)!;
    });
  }

  /** Approve the listed proposals that are still pending, all in one transaction; others are skipped. */
  approveMany(ids: string[], by: string): { approved: string[]; skipped: string[] } {
    const approved: string[] = [];
    const skipped: string[] = [];
    const now = this.clock();
    this.transaction(() => {
      for (const id of ids) {
        const e = this.get(id);
        if (e?.status === "proposed") {
          this.approveRow(e, by, undefined, false, now);
          approved.push(id);
        } else skipped.push(id);
      }
    });
    return { approved, skipped };
  }

  private checkReplacementTarget(project: string, id: string): void {
    const target = this.get(id);
    if (!target) throw new Error(`supersedes: unknown entry ${id}`);
    if (target.project !== project) throw new Error("supersedes: entry belongs to a different project");
  }

  /** Inside a transaction. The status guard in the UPDATE makes a concurrent decision lose cleanly. */
  private approveRow(e: Entry, by: string, note: string | undefined, auto: boolean, now: number, review = false): void {
    const res = this.db
      .prepare(
        "UPDATE entries SET status='approved', decided_at=?, decided_by=?, decision_note=?, auto_approved=?, review_state=? WHERE id=? AND status='proposed'",
      )
      .run(now, by, note ?? null, auto ? 1 : 0, review ? "unreviewed" : null, e.id);
    if (!Number(res.changes)) this.notPending(e.id);
    this.event(e.id, e.project, "approved", by, note ?? null);
    if (e.supersedes) {
      this.checkReplacementTarget(e.project, e.supersedes);
      const sup = this.db
        .prepare("UPDATE entries SET status='superseded', superseded_by=? WHERE id=? AND project=? AND status='approved'")
        .run(e.id, e.supersedes, e.project);
      if (Number(sup.changes) > 0) this.event(e.supersedes, e.project, "superseded", by, e.id);
    }
  }

  private notPending(id: string): never {
    throw new Error(`entry ${id} is not pending (status: ${this.get(id)?.status ?? "deleted"})`);
  }

  reject(id: string, by: string, note?: string): Entry {
    const e = this.mustBePending(id);
    const now = this.clock();
    this.transaction(() => {
      const res = this.db
        .prepare("UPDATE entries SET status='rejected', decided_at=?, decided_by=?, decision_note=? WHERE id=? AND status='proposed'")
        .run(now, by, note ?? null, id);
      if (!Number(res.changes)) this.notPending(id);
      this.event(id, e.project, "rejected", by, note ?? null);
    });
    return this.get(id)!;
  }


  /** Change a pending or active record. Only humans call this (CLI/panel); agents cannot. */
  edit(id: string, patch: EntryPatch, by: string): Entry {
    this.transaction(() => this.editRow(id, patch, by, ["proposed", "approved"]));
    return this.get(id)!;
  }

  /** Edit a pending proposal and approve it in one transaction: both happen, or neither. */
  editAndApprove(id: string, patch: EntryPatch, by: string): Entry {
    const now = this.clock();
    this.transaction(() => {
      const e = this.editRow(id, patch, by, ["proposed"]);
      this.approveRow(e, by, undefined, false, now);
    });
    return this.get(id)!;
  }

  /** Inside a transaction. Returns the entry as it is after the edit. */
  private editRow(id: string, patch: EntryPatch, by: string, allowed: Status[]): Entry {
    const e = this.get(id);
    if (!e) throw new Error(`unknown entry ${id}`);
    if (!allowed.includes(e.status)) {
      throw new Error(
        allowed.length === 1 && allowed[0] === "proposed"
          ? `entry ${id} is not pending (status: ${e.status})`
          : `cannot edit entry ${id} (status: ${e.status})`,
      );
    }
    // Fields left undefined mean "unchanged", never "clear".
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as EntryPatch;
    const next = validate({ ...e, rationale: e.rationale ?? undefined, ...given });
    const changed = Object.keys(given) as (keyof EntryPatch)[];
    if (!changed.length) return e;
    this.db
      .prepare(`UPDATE entries SET kind=?, title=?, body=?, rationale=?, tags=?, audience=?, edited_at=? WHERE id=?`)
      .run(next.kind, next.title, next.body, next.rationale, next.tags, next.audience, this.clock(), id);
    this.event(id, e.project, "edited", by, changed.join(","));
    return this.get(id)!;
  }

  /** Audit trail of one record, oldest first. */
  /** Register a project known only by id and name (from an import); leaves an existing one untouched. */
  ensureProject(key: string, name: string): void {
    if (!UUID.test(key)) return;
    this.db
      // An archived project that comes back through an import is restored (spec §8).
      .prepare("INSERT INTO projects (id, name, last_path, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET archived_at = NULL")
      .run(key, requireText(name, "name", 100), this.clock());
  }

  /** Raw audit rows for export. */
  eventsOf(entryIds: string[]): (HistoryEvent & { entryId: string; project: string })[] {
    if (!entryIds.length) return [];
    const rows = this.db
      .prepare(
        `SELECT entry_id, project, type, actor, at, detail FROM events
         WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY seq`,
      )
      .all(JSON.stringify(entryIds)) as Row[];
    return rows.map((r) => ({
      entryId: r.entry_id as string,
      project: r.project as string,
      type: r.type as EventType,
      actor: r.actor as string,
      at: Number(r.at),
      detail: (r.detail as string | null) ?? null,
    }));
  }

  /**
   * Insert a record exactly as exported elsewhere (id, status and history kept).
   * Returns false when the id already exists. Fields are validated like any other record.
   */
  importEntry(
    e: Entry,
    events: { type: EventType; actor: string; at: number; detail: string | null }[],
    importedBy?: { actor: string; detail: string | null },
    projectsById?: ReadonlyMap<string, string>,
  ): boolean {
    if (this.get(e.id)) return false;
    const v = validate(e);
    const STATUSES: Status[] = ["proposed", "approved", "rejected", "superseded", "retired"];
    if (!STATUSES.includes(e.status)) throw new Error(`unknown status ${e.status}`);
    const project = requireText(e.project, "project", 1000);
    this.transaction(() => {
      for (const id of [e.supersedes, e.supersededBy]) {
        if (!id) continue;
        const linkedProject = this.get(id)?.project ?? projectsById?.get(id);
        if (linkedProject !== undefined && linkedProject !== project) throw new Error("replacement belongs to a different project");
        if (linkedProject === undefined && e.status === "proposed" && id === e.supersedes) throw new Error("unknown replacement target");
      }
      this.db
        .prepare(
          `INSERT INTO entries (id, project, kind, title, body, rationale, tags, audience, status, source_agent,
             created_at, decided_at, decided_by, decision_note, expires_at, supersedes, superseded_by,
             edited_at, auto_approved, similar_to, review_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id, project, v.kind, v.title, v.body, v.rationale, v.tags, v.audience,
          e.status, requireText(e.sourceAgent, "sourceAgent", 100), e.createdAt, e.decidedAt ?? null,
          e.decidedBy ?? null, e.decisionNote ?? null, e.expiresAt ?? null, e.supersedes ?? null,
          e.supersededBy ?? null, e.editedAt ?? null, e.autoApproved ? 1 : 0, JSON.stringify(cleanList(e.similarTo)),
          e.reviewState ?? null,
        );
      for (const ev of events) {
        this.db
          .prepare("INSERT INTO events (entry_id, project, type, actor, at, detail) VALUES (?, ?, ?, ?, ?, ?)")
          .run(e.id, e.project, ev.type, ev.actor, ev.at, ev.detail);
      }
      // The import itself is part of the record's history: who brought it in, and from where.
      if (importedBy) this.event(e.id, e.project, "imported", importedBy.actor, importedBy.detail);
    });
    return true;
  }

  history(id: string): HistoryEvent[] {
    const rows = this.db
      .prepare("SELECT type, actor, at, detail FROM events WHERE entry_id = ? ORDER BY seq ASC")
      .all(id) as Row[];
    return rows.map((r) => ({
      type: r.type as EventType,
      actor: r.actor as string,
      at: Number(r.at),
      detail: (r.detail as string | null) ?? null,
    }));
  }

  /** Proposals from `agent` in `project` still waiting for review. */
  countPending(project: string, agent: string): number {
    const r = this.db
      .prepare("SELECT count(*) AS n FROM entries WHERE project = ? AND source_agent = ? AND status = 'proposed'")
      .get(project, agent) as Row;
    return Number(r.n);
  }

  /** Owner-defined rule: records from `agent` and/or of `kind` skip review. null projectId = every project. */
  addTrustRule(r: { projectId: string | null; agent?: string; kind?: Kind }): TrustRule {
    const agent = r.agent?.trim() || null;
    const kind = r.kind ?? null;
    if (!agent && !kind) throw new Error("a trust rule needs an agent or kind (or both)");
    if (kind && !KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
    const id = `t${newId().slice(1)}`;
    this.db
      .prepare("INSERT INTO trust_rules (id, project_id, agent, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, r.projectId, agent, kind, this.clock());
    return { id, projectId: r.projectId, agent, kind, createdAt: this.clock() };
  }

  /** Rules for `projectId` plus global ones; every rule when omitted. */
  listTrustRules(projectId?: string): TrustRule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trust_rules WHERE (:p IS NULL OR project_id IS NULL OR project_id = :p)
         ORDER BY created_at, rowid`,
      )
      .all({ p: projectId ?? null }) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      projectId: (r.project_id as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      kind: (r.kind as Kind | null) ?? null,
      createdAt: Number(r.created_at),
    }));
  }

  removeTrustRule(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM trust_rules WHERE id = ?").run(id).changes) > 0;
  }

  /** The first rule that lets this agent's record of this kind skip review in this project. */
  matchTrustRule(project: string, agent: string, kind: Kind): TrustRule | undefined {
    return this.listTrustRules(project).find(
      (r) => (r.agent === null || r.agent === agent) && (r.kind === null || r.kind === kind),
    );
  }

  /** Move every record (and its history) from one project key to another. Returns moved records. */
  rekeyProject(from: string, to: string): number {
    if (from === to) return 0;
    let moved = 0;
    this.transaction(() => {
      moved = Number(this.db.prepare("UPDATE entries SET project = ? WHERE project = ?").run(to, from).changes);
      this.db.prepare("UPDATE events SET project = ? WHERE project = ?").run(to, from);
      this.handoffs.rekey(from, to);
      // The project's own setting wins over the one recorded under its old path key.
      this.db.prepare("UPDATE OR IGNORE project_settings SET project = ? WHERE project = ?").run(to, from);
      this.db.prepare("DELETE FROM project_settings WHERE project = ?").run(from);
    });
    return moved;
  }

  /** Remember an initialised project (marker id) and where it was last seen. */
  touchProject(ref: { key: string; name: string; dir: string }): void {
    if (!UUID.test(ref.key)) return;
    // Writes only when something changed (reads call this on every tool call), and never
    // overwrites a name the owner chose in the panel.
    this.db
      .prepare(
        `INSERT INTO projects (id, name, last_path, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN projects.custom_name = 1 THEN projects.name ELSE excluded.name END,
           last_path = excluded.last_path
         WHERE projects.last_path IS NOT excluded.last_path
            OR (projects.custom_name = 0 AND projects.name IS NOT excluded.name)`,
      )
      .run(ref.key, ref.name, ref.dir, this.clock());
  }

  /** Every project the owner has: registered ones and path-keyed ones that hold records. */
  listProjects(opts: { includeArchived?: boolean } = {}): ProjectRow[] {
    const rows = this.db
      .prepare(
        `WITH keys AS (
           SELECT id AS key FROM projects
           UNION SELECT DISTINCT project FROM entries
         )
         SELECT k.key, p.name, p.last_path, p.archived_at,
           (SELECT count(*) FROM entries e WHERE e.project = k.key AND e.status = 'approved'
              AND (e.expires_at IS NULL OR e.expires_at > :now)) AS approved,
           (SELECT count(*) FROM entries e WHERE e.project = k.key AND e.status = 'proposed') AS pending,
           (SELECT max(at) FROM events v WHERE v.project = k.key) AS last_activity
         FROM keys k LEFT JOIN projects p ON p.id = k.key
         ORDER BY last_activity DESC NULLS LAST, k.key`,
      )
      .all({ now: this.clock() }) as Row[];
    return rows
      .map((r) => {
        const key = r.key as string;
        const path = (r.last_path as string | null) ?? (UUID.test(key) ? null : key);
        return {
          key,
          name: (r.name as string | null) ?? (path ? basename(path) || path : key),
          path,
          archived: r.archived_at != null,
          approved: Number(r.approved),
          pending: Number(r.pending),
          lastActivity: r.last_activity == null ? null : Number(r.last_activity),
        };
      })
      .filter((p) => opts.includeArchived || !p.archived);
  }

  renameProject(id: string, name: string): void {
    const clean = requireText(name, "name", 100);
    const res = this.db.prepare("UPDATE projects SET name = ?, custom_name = 1 WHERE id = ?").run(clean, id);
    if (!Number(res.changes)) throw new Error(`unknown project ${id} (only initialised projects can be renamed)`);
  }

  archiveProject(id: string, by: string): void {
    this.setArchived(id, by, true);
  }

  restoreProject(id: string, by: string): void {
    this.setArchived(id, by, false);
  }

  private setArchived(id: string, by: string, archived: boolean): void {
    this.transaction(() => {
      const res = this.db
        .prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
        .run(archived ? this.clock() : null, id);
      if (!Number(res.changes)) throw new Error(`unknown project ${id} (only initialised projects can be archived)`);
      this.event(null, id, archived ? "archived" : "restored", by, null);
    });
  }

  /**
   * Permanently delete a project: its records (their audit events stay), its tasks in progress and
   * their history, its settings and trust rules. Returns the deleted record count.
   */
  deleteProject(key: string, by: string): number {
    let n = 0;
    this.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM entries WHERE project = ?").all(key) as Row[]).map((r) => r.id as string);
      for (const id of ids) this.event(id, key, "deleted", by, null);
      n = Number(this.db.prepare("DELETE FROM entries WHERE project = ?").run(key).changes);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(key);
      this.db.prepare("DELETE FROM trust_rules WHERE project_id = ?").run(key);
      // Otherwise a deleted project's task stays in the inbox as a card named by its id.
      this.db.prepare("DELETE FROM handoffs WHERE project = ?").run(key);
      this.db.prepare("DELETE FROM handoff_history WHERE project = ?").run(key);
      this.db.prepare("DELETE FROM project_settings WHERE project = ?").run(key);
    });
    return n;
  }

  /** Approved record → retired: kept for history, hidden from agents. */
  retire(id: string, by: string, note?: string): Entry {
    const e = this.get(id);
    if (!e) throw new Error(`unknown entry ${id}`);
    if (e.status !== "approved") throw new Error(`entry ${id} is not active (status: ${e.status}); only active records can be retired`);
    this.transaction(() => {
      const res = this.db.prepare("UPDATE entries SET status = 'retired' WHERE id = ? AND status = 'approved'").run(id);
      if (!Number(res.changes)) throw new Error(`entry ${id} is not active (status: ${this.get(id)?.status ?? "deleted"}); only active records can be retired`);
      this.event(id, e.project, "retired", by, note ?? null);
    });
    return this.get(id)!;
  }

  /** Filtered, paginated listing for humans. Newest first. */
  query(opts: {
    project?: string;
    status?: Status | "active";
    kind?: Kind;
    agent?: string;
    text?: string;
    limit?: number;
    offset?: number;
  }): { items: Entry[]; total: number } {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (opts.project) (where.push("e.project = :project"), (params.project = opts.project));
    if (opts.status === "active") {
      where.push("e.status = 'approved' AND (e.expires_at IS NULL OR e.expires_at > :now)");
      params.now = this.clock();
    } else if (opts.status) (where.push("e.status = :status"), (params.status = opts.status));
    if (opts.kind) (where.push("e.kind = :kind"), (params.kind = opts.kind));
    if (opts.agent) (where.push("e.source_agent = :agent"), (params.agent = opts.agent));
    const match = opts.text ? toFtsQuery(opts.text) : null;
    if (match) {
      where.push("e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH :match)");
      params.match = match;
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number((this.db.prepare(`SELECT count(*) AS n FROM entries e ${sqlWhere}`).get(params) as Row).n);
    const items = (
      this.db
        .prepare(`SELECT e.* FROM entries e ${sqlWhere} ORDER BY e.created_at DESC, e.rowid DESC LIMIT :limit OFFSET :offset`)
        .all({ ...params, limit: Math.min(opts.limit ?? 50, 500), offset: opts.offset ?? 0 }) as Row[]
    ).map(toEntry);
    return { items, total };
  }

  /** Changes whenever any connection commits; the panel uses it to push live updates. */
  dataVersion(): number {
    return Number((this.db.prepare("PRAGMA data_version").get() as Row).data_version);
  }

  projectInfo(id: string): ProjectInfo | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      name: r.name as string,
      lastPath: (r.last_path as string | null) ?? null,
      createdAt: Number(r.created_at),
      archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    };
  }

  /** Approved, unexpired entries this agent may see, newest first. */
  /**
   * Approved, unexpired entries this agent may see. Newest first, or with `byPriority`
   * warnings → decisions → conventions → preferences → facts (newest first within each),
   * which is the order the brief keeps when it has to cut.
   */
  visible(project: string, agent: string, opts: { kind?: Kind; limit?: number; byPriority?: boolean } = {}): Entry[] {
    const limit = opts.limit ?? 200;
    const page = (kind: Kind | null, n: number) =>
      (
        this.db
          .prepare(
            `SELECT e.* FROM entries e WHERE ${VISIBLE}
             AND (:kind IS NULL OR e.kind = :kind)
             ORDER BY e.decided_at DESC, e.rowid DESC LIMIT :limit`,
          )
          .all({ project, agent, now: this.clock(), kind, limit: n }) as Row[]
      ).map(toEntry);
    if (!opts.byPriority || opts.kind) return page(opts.kind ?? null, limit);
    // One indexed query per kind, in priority order, until the slice is full.
    const out: Entry[] = [];
    for (const kind of PRIORITY) {
      if (out.length >= limit) break;
      out.push(...page(kind, limit - out.length));
    }
    return out;
  }

  /** Visible records, counted up to `cap` (counting stops there; the brief only needs "how many more"). */
  countVisible(project: string, agent: string, cap = Number.MAX_SAFE_INTEGER): number {
    return Number(
      (
        this.db
          .prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM entries e WHERE ${VISIBLE} LIMIT :cap)`)
          .get({ project, agent, now: this.clock(), cap }) as Row
      ).n,
    );
  }

  /** Names of the indexes in the database (for health checks and tests). */
  indexNames(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Row[]).map((r) => r.name as string);
  }

  search(project: string, agent: string, text: string, opts: { kind?: Kind; limit?: number } = {}): Entry[] {
    const match = toFtsQuery(text);
    if (!match) return [];
    const rows = this.db
      .prepare(
        // CROSS JOIN pins the plan to "full-text index first"; driving from entries would run one
        // MATCH per row, which is orders of magnitude slower on large projects.
        `SELECT e.* FROM (SELECT rowid, rank FROM entries_fts WHERE entries_fts MATCH :match) f
         CROSS JOIN entries e ON e.rowid = f.rowid
         WHERE ${VISIBLE}
         AND (:kind IS NULL OR e.kind = :kind)
         ORDER BY f.rank LIMIT :limit`,
      )
      .all({ match, project, agent, now: this.clock(), kind: opts.kind ?? null, limit: opts.limit ?? 20 }) as Row[];
    return rows.map(toEntry);
  }

  /**
   * Active (approved, unexpired) or pending records in `project` that say nearly the same thing.
   * Word-set Jaccard on title+body ≥ 0.5, or on titles ≥ 0.8. Best match first.
   */
  findSimilar(
    project: string,
    text: { title: string; body: string },
    opts: { kind?: Kind; excludeId?: string; limit?: number } = {},
  ): Entry[] {
    return this.similarAmong(
      "(e.status = 'proposed' OR (e.status = 'approved' AND (e.expires_at IS NULL OR e.expires_at > :now)))",
      project,
      text,
      opts,
    );
  }

  /** Look-alikes among records the owner rejected (autonomous mode never re-shares those). */
  findRejectedSimilar(
    project: string,
    text: { title: string; body: string },
    opts: { kind?: Kind; excludeId?: string; limit?: number } = {},
  ): Entry[] {
    return this.similarAmong("e.status = 'rejected'", project, text, opts);
  }

  // ---- Handoffs (work in progress) ----

  private readonly handoffs: HandoffRepo;

  checkpoint(i: CheckpointInput): Handoff {
    return this.handoffs.checkpoint(i);
  }

  getHandoff(project: string, branch: string): Handoff | undefined {
    return this.handoffs.get(project, branch);
  }

  listHandoffs(project?: string): Handoff[] {
    return this.handoffs.list(project);
  }

  handoffHistory(project: string, branch: string, limit = 20): (Handoff & { replaced: boolean })[] {
    return this.handoffs.history(project, branch, limit);
  }

  clearHandoff(project: string, branch: string, by: string): boolean {
    return this.handoffs.clear(project, branch, by);
  }

  // ---- Automatic saving (tool hooks) ----

  /** Apply what a tool hook saw to the live handoff. Undefined when there was nothing to save. */
  autoCapture(i: { project: string; branch: string; dir: string; agent: string; event: AutoEvent }): Handoff | undefined {
    // Planned under the write lock: parallel hooks (one per edited file) each add to the latest lists.
    return this.handoffs.checkpointPlanned(i.project, i.branch, (existing) => {
      const plan = planAutoEvent(existing, i.event, { now: this.clock(), dir: i.dir });
      return plan && { ...plan, project: i.project, branch: i.branch, dir: i.dir, agent: i.agent, agentVerified: true, origin: "auto" };
    });
  }

  setAutoCapture(project: string, on: boolean, by: string): void {
    this.db
      .prepare(
        `INSERT INTO project_settings (project, auto_capture, changed_at, changed_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET auto_capture = excluded.auto_capture, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
      )
      .run(project, on ? 1 : 0, this.clock(), by);
  }

  /** On unless turned off for this project, or everywhere with BAGLAM_AUTO_CAPTURE=0. */
  isAutoCapture(project: string): boolean {
    if (process.env.BAGLAM_AUTO_CAPTURE === "0") return false;
    const r = this.db.prepare("SELECT auto_capture FROM project_settings WHERE project = ?").get(project) as Row | undefined;
    return Number(r?.auto_capture ?? 1) === 1;
  }

  noteHookSeen(client: string, event: string): void {
    this.db.prepare("INSERT OR REPLACE INTO hook_seen (client, at, event) VALUES (?, ?, ?)").run(client, this.clock(), event);
  }

  hookSeen(): Record<string, { at: number; event: string }> {
    const rows = this.db.prepare("SELECT client, at, event FROM hook_seen").all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.client as string, { at: Number(r.at), event: r.event as string }]));
  }

  // ---- Autonomous mode ----

  setAutonomous(project: string, on: boolean, by: string): void {
    this.db
      .prepare(
        `INSERT INTO project_settings (project, autonomous, changed_at, changed_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET autonomous = excluded.autonomous, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
      )
      .run(project, on ? 1 : 0, this.clock(), by);
  }

  isAutonomous(project: string): boolean {
    const r = this.db.prepare("SELECT autonomous FROM project_settings WHERE project = ?").get(project) as Row | undefined;
    return Number(r?.autonomous ?? 0) === 1;
  }

  /** Stored per-project settings as saved in the database (ignoring runtime env overrides). */
  projectSettings(project: string): { autonomous: boolean; autoCapture: boolean } {
    const r = this.db.prepare("SELECT autonomous, auto_capture FROM project_settings WHERE project = ?").get(project) as Row | undefined;
    return { autonomous: Number(r?.autonomous ?? 0) === 1, autoCapture: Number(r?.auto_capture ?? 1) === 1 };
  }

  /** Records autonomous mode shared before the owner looked at them, newest first. */
  unreviewed(project?: string): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entries WHERE review_state = 'unreviewed' AND status = 'approved'
         AND (:p IS NULL OR project = :p) ORDER BY decided_at DESC, rowid DESC`,
      )
      .all({ p: project ?? null }) as Row[];
    return rows.map(toEntry);
  }

  /** The owner looked at these auto-shared records and keeps them. */
  keep(ids: string[], by: string): number {
    let n = 0;
    this.transaction(() => {
      for (const id of ids) {
        const res = this.db.prepare("UPDATE entries SET review_state = 'kept' WHERE id = ? AND review_state = 'unreviewed'").run(id);
        if (Number(res.changes)) {
          n++;
          this.event(id, this.get(id)!.project, "approved", by, "kept after automatic sharing");
        }
      }
    });
    return n;
  }

  /**
   * Undo a record autonomous mode shared. It becomes rejected (so it is not auto-shared again);
   * a record it replaced comes back only if nothing changed it since.
   */
  undoAuto(id: string, by: string): { undone: Entry; restored?: Entry; note?: string } {
    return this.transaction(() => {
      const e = this.get(id);
      if (!e) throw new Error(`unknown entry ${id}`);
      if (!e.autoApproved || !e.reviewState) throw new Error(`entry ${id} was not shared automatically; retire it instead`);
      if (e.status === "superseded" && e.supersededBy) throw new Error(`entry ${id} was already replaced; undo ${e.supersededBy} first`);
      if (e.status !== "approved") throw new Error(`entry ${id} is not active (status: ${e.status})`);
      const note = "undone after automatic sharing";
      let restored: Entry | undefined;
      let message: string | undefined;
      const res = this.db
        .prepare(
          "UPDATE entries SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ?, review_state = NULL WHERE id = ? AND status = 'approved'",
        )
        .run(this.clock(), by, note, id);
      if (!Number(res.changes)) this.notPending(id);
      this.event(id, e.project, "rejected", by, note);
      if (e.supersedes) {
        const back = this.db
          .prepare("UPDATE entries SET status = 'approved', superseded_by = NULL WHERE id = ? AND project = ? AND status = 'superseded' AND superseded_by = ?")
          .run(e.supersedes, e.project, id);
        if (Number(back.changes)) {
          restored = this.get(e.supersedes);
          this.event(e.supersedes, e.project, "restored", by, `undo of ${id}`);
        } else {
          message = `${e.supersedes} was not restored because it changed since it was replaced`;
        }
      }
      return { undone: this.get(id)!, ...(restored ? { restored } : {}), ...(message ? { note: message } : {}) };
    });
  }

  /** Like findSimilar, but among records the owner already rejected or replaced. */
  findClosedSimilar(
    project: string,
    text: { title: string; body: string },
    opts: { kind?: Kind; excludeId?: string; limit?: number } = {},
  ): Entry[] {
    return this.similarAmong("e.status IN ('rejected', 'superseded')", project, text, opts);
  }

  private similarAmong(
    statusSql: string,
    project: string,
    text: { title: string; body: string },
    opts: { kind?: Kind; excludeId?: string; limit?: number },
  ): Entry[] {
    const all = wordSet(`${text.title} ${text.body}`);
    const titleWords = wordSet(text.title);
    const query = [...all].slice(0, 24).map((w) => `"${w}"`).join(" OR ");
    if (!query) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM (SELECT rowid, rank FROM entries_fts WHERE entries_fts MATCH :query) f
         CROSS JOIN entries e ON e.rowid = f.rowid
         WHERE e.project = :project
           AND ${statusSql}
           AND (:kind IS NULL OR e.kind = :kind)
           AND (:exclude IS NULL OR e.id != :exclude)
         ORDER BY f.rank LIMIT 10`,
      )
      .all({
        query,
        project,
        kind: opts.kind ?? null,
        exclude: opts.excludeId ?? null,
        // node:sqlite rejects unused named parameters, so :now is bound only when the filter uses it.
        ...(statusSql.includes(":now") ? { now: this.clock() } : {}),
      }) as Row[];
    return rows
      .map(toEntry)
      .map((e) => ({
        e,
        score: Math.max(
          jaccard(all, wordSet(`${e.title} ${e.body}`)),
          jaccard(titleWords, wordSet(e.title)) >= 0.8 ? 1 : 0,
        ),
      }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 3)
      .map((x) => x.e);
  }

  /** Pending proposals; all projects when `project` is omitted. Oldest first. */
  pending(project?: string): Entry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entries WHERE status='proposed' AND (:project IS NULL OR project = :project)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all({ project: project ?? null }) as Row[];
    return rows.map(toEntry);
  }

  /** Every entry for a project regardless of status, newest first (for humans). */
  all(project: string): Entry[] {
    const rows = this.db
      .prepare("SELECT * FROM entries WHERE project = ? ORDER BY created_at DESC, rowid DESC")
      .all(project) as Row[];
    return rows.map(toEntry);
  }

  projects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT project,
                sum(status='approved' AND (expires_at IS NULL OR expires_at > :now)) AS approved,
                sum(status='proposed') AS pending
         FROM entries GROUP BY project ORDER BY project`,
      )
      .all({ now: this.clock() }) as Row[];
    return rows.map((r) => ({ project: r.project as string, approved: Number(r.approved), pending: Number(r.pending) }));
  }

  private insert(input: NewEntry, sourceAgent: string, status: Status): Entry {
    const project = requireText(input.project, "project", 1000);
    const v = validate(input);
    if (input.ttlDays !== undefined && !(input.ttlDays > 0)) throw new Error("ttlDays must be positive");
    if (input.supersedes) this.checkReplacementTarget(project, input.supersedes);
    const now = this.clock();
    const id = newId();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries (id, project, kind, title, body, rationale, tags, audience, status,
                                source_agent, created_at, expires_at, supersedes, similar_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, project, v.kind, v.title, v.body, v.rationale, v.tags, v.audience,
          status, sourceAgent, now,
          input.ttlDays ? now + Math.round(input.ttlDays * DAY_MS) : null,
          input.supersedes ?? null,
          JSON.stringify(cleanList(input.similarTo)),
        );
      this.event(id, project, "proposed", sourceAgent, null);
    });
    return this.get(id)!;
  }

  private event(entryId: string | null, project: string, type: EventType, actor: string, detail: string | null): void {
    this.db
      .prepare("INSERT INTO events (entry_id, project, type, actor, at, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entryId, project, type, actor, this.clock(), detail);
  }

  private mustBePending(id: string): Entry {
    const e = this.get(id);
    if (!e) throw new Error(`unknown entry ${id}`);
    if (e.status !== "proposed") throw new Error(`entry ${id} is not pending (status: ${e.status})`);
    return e;
  }

  readSnapshot<T>(read: () => T): T {
    return this.transaction(read, "BEGIN");
  }

  private transaction<T>(fn: () => T, begin = "BEGIN IMMEDIATE"): T {
    this.db.exec(begin);
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
