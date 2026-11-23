import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { describeFindings, scanEntryFields } from "./guards.js";

/** Live, per (project, branch) note of the task in progress, so another agent can continue it. */

export type HandoffStatus = "in_progress" | "blocked" | "done";
export const HANDOFF_STATUSES: HandoffStatus[] = ["in_progress", "blocked", "done"];

export interface Handoff {
  project: string;
  branch: string;
  /** Folder the last checkpoint came from (feeds the git snapshot for the panel and CLI). */
  dir: string | null;
  taskId: string;
  goal: string;
  status: HandoffStatus;
  done: string[];
  now: string | null;
  next: string[];
  files: string[];
  blockers: string | null;
  notes: string | null;
  agent: string;
  /** The writer's name came from BAGLAM_AGENT (set by setup), not from the client. */
  agentVerified: boolean;
  /** The user's latest requests, saved by tool hooks (newest last). */
  requests: string[];
  /** The user's latest detailed (multi-line) request in full (automatic saving only; null when none). */
  request: string | null;
  lastRequestDetailed?: boolean;
  /** Last checkpoint the agent made itself; null when only the tool's hooks saved this task. */
  agentAt: number | null;
  /** Last automatic save from a tool hook. */
  autoAt: number | null;
  /** When the latest request was saved. */
  requestAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface CheckpointInput {
  project: string;
  branch: string;
  dir?: string;
  agent: string;
  agentVerified?: boolean;
  goal?: string;
  status?: HandoffStatus;
  done?: string[];
  doneAdd?: string[];
  now?: string;
  next?: string[];
  files?: string[];
  blockers?: string;
  notes?: string;
  /** Start a new task even though one is in progress (the old one goes to history). */
  newTask?: boolean;
  /** Replaces the request list (automatic saving only). */
  requests?: string[];
  /** The full text of the request that starts this task (automatic saving only). */
  request?: string;
  /** "auto" for a tool hook; anything else is the agent's own checkpoint. */
  origin?: "agent" | "auto";
  /** Marks this save as a new user request (automatic saving only). */
  isRequest?: boolean;
}

export const LIMITS = {
  goal: 300,
  item: 300,
  done: 30,
  next: 20,
  files: 50,
  now: 1000,
  blockers: 1000,
  notes: 2000,
  requests: 5,
  request: 2000,
  history: 50,
  coalesceMs: 60_000,
} as const;

const DAY = 86_400_000;

export function handoffTtlDays(): number {
  const n = Number(process.env.BAGLAM_HANDOFF_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

const text = (v: string | undefined, max: number): string | undefined => {
  if (v === undefined) return undefined;
  const t = String(v).trim();
  return t.slice(0, max);
};

const list = (v: string[] | undefined, count: number): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error("lists must be arrays of text");
  return v
    .filter((x) => typeof x === "string")
    .map((x) => x.trim().slice(0, LIMITS.item))
    .filter(Boolean)
    .slice(0, count);
};

/** Trim, cap and check a checkpoint before it touches the database. */
export function validateCheckpoint(i: CheckpointInput): CheckpointInput {
  if (i.status !== undefined && !HANDOFF_STATUSES.includes(i.status)) {
    throw new Error(`status must be one of: ${HANDOFF_STATUSES.join(", ")}`);
  }
  return {
    ...i,
    goal: text(i.goal, LIMITS.goal) || undefined,
    now: text(i.now, LIMITS.now),
    blockers: text(i.blockers, LIMITS.blockers),
    notes: text(i.notes, LIMITS.notes),
    done: list(i.done, LIMITS.done),
    doneAdd: list(i.doneAdd, LIMITS.done),
    next: list(i.next, LIMITS.next),
    files: list(i.files, LIMITS.files),
    requests: i.requests === undefined ? undefined : list(i.requests, Number.MAX_SAFE_INTEGER)!.slice(-LIMITS.requests),
    request: text(i.request, LIMITS.request) || undefined,
  };
}

type Row = Record<string, SQLInputValue>;

function fromRow(r: Row): Handoff {
  const d = JSON.parse(r.data as string) as Pick<Handoff, "goal" | "status" | "done" | "now" | "next" | "files" | "blockers" | "notes"> &
    Partial<Pick<Handoff, "agentVerified" | "requests" | "request" | "agentAt" | "autoAt" | "requestAt">>;
  const updatedAt = Number(r.updated_at ?? r.at);
  return {
    project: r.project as string,
    branch: r.branch as string,
    dir: (r.dir as string | null) ?? null,
    taskId: r.task_id as string,
    ...d,
    agentVerified: d.agentVerified === true,
    requests: Array.isArray(d.requests) ? d.requests : [],
    request: typeof d.request === "string" ? d.request : null,
    // Saved before automatic saving existed: every save then came from the agent.
    agentAt: d.agentAt === undefined ? updatedAt : d.agentAt,
    autoAt: d.autoAt ?? null,
    requestAt: d.requestAt ?? null,
    agent: r.agent as string,
    createdAt: Number(r.created_at),
    updatedAt,
    expiresAt: Number(r.expires_at ?? 0),
  };
}

const payload = (h: Handoff) =>
  JSON.stringify({
    goal: h.goal, status: h.status, done: h.done, now: h.now, next: h.next, files: h.files, blockers: h.blockers, notes: h.notes,
    agentVerified: h.agentVerified, requests: h.requests, request: h.request, agentAt: h.agentAt, autoAt: h.autoAt, requestAt: h.requestAt,
    lastRequestDetailed: h.lastRequestDetailed,
  });

/** The task's detailed request is the carried (latest) request, not an older one. */
function carriesRequest(existing: Handoff | undefined, carried: string[]): boolean {
  const r = existing?.request;
  if (!r || !carried.length) return false;
  const firstLine = r.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean);
  return firstLine !== undefined && carried[0] === firstLine.slice(0, LIMITS.goal);
}

/** Storage for handoffs; used through ContextStore. */
export class HandoffRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => number,
    private readonly transaction: (fn: () => void) => void,
  ) {}

  get(project: string, branch: string): Handoff | undefined {
    const r = this.db
      .prepare("SELECT * FROM handoffs WHERE project = ? AND branch = ? AND expires_at > ?")
      .get(project, branch, this.clock()) as Row | undefined;
    return r ? fromRow(r) : undefined;
  }

  list(project?: string): Handoff[] {
    const rows = this.db
      .prepare("SELECT * FROM handoffs WHERE (:p IS NULL OR project = :p) AND expires_at > :now ORDER BY updated_at DESC")
      .all({ p: project ?? null, now: this.clock() }) as Row[];
    return rows.map(fromRow);
  }

  history(project: string, branch: string, limit = 20): (Handoff & { replaced: boolean })[] {
    const rows = this.db
      .prepare("SELECT * FROM handoff_history WHERE project = ? AND branch = ? ORDER BY seq DESC LIMIT ?")
      .all(project, branch, limit) as Row[];
    return rows.map((r) => ({ ...fromRow({ ...r, created_at: r.at, updated_at: r.at }), replaced: Number(r.replaced) === 1 }));
  }

  /** Secret scan and limits; throws when the checkpoint must not be saved. */
  private check(raw: CheckpointInput): CheckpointInput {
    // Scan what the agent sent, before any cutting: a secret split by a size cap must not slip through in part.
    // Only what can be stored matters, plus a margin so a secret straddling the cut is still seen whole.
    const MARGIN = 256;
    const asText = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max + MARGIN) : "");
    const asList = (v: unknown, count: number) =>
      Array.isArray(v) ? v.slice(0, count).map((x) => asText(x, LIMITS.item)) : [];
    const findings = scanEntryFields({
      title: asText(raw.goal, LIMITS.goal),
      body: [
        asText(raw.now, LIMITS.now), asText(raw.blockers, LIMITS.blockers), asText(raw.notes, LIMITS.notes),
        asText(raw.request, LIMITS.request),
      ].join("\n"),
      tags: [
        ...asList(raw.done, LIMITS.done), ...asList(raw.doneAdd, LIMITS.done),
        ...asList(raw.next, LIMITS.next), ...asList(raw.files, LIMITS.files), ...asList(raw.requests, LIMITS.requests + 1),
      ],
    });
    const i = validateCheckpoint(raw);
    if (findings.length) {
      throw new Error(`Not saved: it looks like a secret (${describeFindings(findings)}). Remove it and checkpoint again.`);
    }
    return i;
  }

  checkpoint(raw: CheckpointInput): Handoff {
    const i = this.check(raw);
    let out!: Handoff;
    // Read and write under one write lock: a hook or another agent saving at the same moment can't be lost.
    this.transaction(() => {
      out = this.apply(i, this.get(i.project, i.branch));
    });
    return out;
  }

  /**
   * Like checkpoint, but the input is computed from the live task inside the write lock, so changes
   * built on the current lists (automatic saving appends files and requests) never overwrite a
   * concurrent save. `plan` returns null when there is nothing to save.
   */
  checkpointPlanned(project: string, branch: string, plan: (existing: Handoff | undefined) => CheckpointInput | null): Handoff | undefined {
    let out: Handoff | undefined;
    this.transaction(() => {
      const existing = this.get(project, branch);
      const raw = plan(existing);
      if (raw) out = this.apply(this.check(raw), existing);
    });
    return out;
  }

  /** Writes one checkpoint; the caller holds the write lock. */
  private apply(i: CheckpointInput, existing: Handoff | undefined): Handoff {
    const now = this.clock();
    // An agent Bağlam cannot verify must not rewrite (or replace) a task a set-up agent is working on.
    if (existing && existing.status !== "done" && existing.agentVerified && !i.agentVerified) {
      throw new Error(
        `This task was saved by a set-up agent (${existing.agent}); an agent Bağlam cannot verify may not change it. Ask the user to run baglam setup for this tool.`,
      );
    }
    const agentSave = i.origin !== "auto";
    // A task only the tool's hooks saved is the user's latest request: an agent starting "a new task"
    // right after it is naming that same task, not replacing it.
    const autoOnly = !!existing && existing.status !== "done" && existing.agentAt === null;
    const startsNew = !existing || existing.status === "done" || (i.newTask === true && !(agentSave && autoOnly));
    if (startsNew && !i.goal) throw new Error("goal is required to start a task (what are you working on?)");
    // The request saved since the agent's last checkpoint is what this new task is about: keep it.
    const carried =
      startsNew && agentSave && existing && existing.requestAt !== null && existing.requestAt >= (existing.agentAt ?? -Infinity)
        ? existing.requests.slice(-1)
        : [];

    const base: Handoff = startsNew
      ? {
          project: i.project, branch: i.branch, dir: i.dir ?? existing?.dir ?? null,
          taskId: `t${randomBytes(6).toString("hex")}`, goal: i.goal!, status: "in_progress",
          done: [], now: null, next: [], files: [], blockers: null, notes: null,
          // The detailed request too, but only when it is that same carried request.
          requests: carried, request: carriesRequest(existing, carried) ? existing!.request : null, agentAt: null, autoAt: null, requestAt: carried.length ? existing!.requestAt : null,
          agent: i.agent, agentVerified: false, createdAt: now, updatedAt: now, expiresAt: 0,
        }
      : existing!;

    const done = [...(i.done ?? base.done), ...(i.doneAdd ?? [])].slice(-LIMITS.done);
    const next: Handoff = {
      ...base,
      dir: i.dir ?? base.dir,
      goal: i.goal ?? base.goal,
      status: i.status ?? (startsNew ? "in_progress" : base.status),
      done,
      now: i.now ?? base.now,
      next: i.next ?? base.next,
      files: i.files ?? base.files,
      blockers: i.blockers ?? base.blockers,
      notes: i.notes ?? base.notes,
      requests: i.requests ?? base.requests,
      request: i.request ?? base.request,
      lastRequestDetailed: i.isRequest ? i.request !== undefined : base.lastRequestDetailed,
      agentAt: i.origin === "auto" ? base.agentAt : now,
      autoAt: i.origin === "auto" ? now : base.autoAt,
      requestAt: i.isRequest ? now : base.requestAt,
      agent: i.agent,
      agentVerified: i.agentVerified === true,
      updatedAt: now,
      expiresAt: now + handoffTtlDays() * DAY,
    };

    if (startsNew && existing && existing.status !== "done") this.addHistory(existing, true);
    this.db
      .prepare(
        `INSERT INTO handoffs (project, branch, dir, task_id, data, agent, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, branch) DO UPDATE SET dir = excluded.dir, task_id = excluded.task_id, data = excluded.data,
           agent = excluded.agent, created_at = excluded.created_at, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
      )
      .run(next.project, next.branch, next.dir, next.taskId, payload(next), next.agent, next.createdAt, next.updatedAt, next.expiresAt);
    this.addHistory(next, false);
    return next;
  }

  /** Every checkpoint is saved at once; only history snapshots by the same agent within 60 s are merged. */
  private addHistory(h: Handoff, replaced: boolean): void {
    const last = this.db
      .prepare("SELECT seq, agent, task_id, at, replaced FROM handoff_history WHERE project = ? AND branch = ? ORDER BY seq DESC LIMIT 1")
      .get(h.project, h.branch) as Row | undefined;
    const merge =
      !replaced &&
      last &&
      Number(last.replaced) === 0 &&
      last.agent === h.agent &&
      last.task_id === h.taskId &&
      h.updatedAt - Number(last.at) < LIMITS.coalesceMs;
    if (merge) {
      this.db.prepare("UPDATE handoff_history SET data = ?, dir = ? WHERE seq = ?").run(payload(h), h.dir, last!.seq as number);
    } else {
      this.db
        .prepare("INSERT INTO handoff_history (project, branch, dir, task_id, data, agent, at, replaced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(h.project, h.branch, h.dir, h.taskId, payload(h), h.agent, replaced ? this.clock() : h.updatedAt, replaced ? 1 : 0);
    }
    this.db
      .prepare(
        `DELETE FROM handoff_history WHERE project = ? AND branch = ? AND seq NOT IN
           (SELECT seq FROM handoff_history WHERE project = ? AND branch = ? ORDER BY seq DESC LIMIT ?)`,
      )
      .run(h.project, h.branch, h.project, h.branch, LIMITS.history);
  }

  clear(project: string, branch: string, by: string): boolean {
    const live = this.get(project, branch);
    if (!live || live.status === "done") return false;
    this.checkpoint({ project, branch, agent: by, agentVerified: true, status: "done" });
    return true;
  }

  /** Move handoffs to another project key. A live task already under the new key wins; the old one goes to history. */
  rekey(from: string, to: string): void {
    const rows = this.db.prepare("SELECT * FROM handoffs WHERE project = ?").all(from) as Row[];
    this.db.prepare("UPDATE handoff_history SET project = ? WHERE project = ?").run(to, from);
    for (const r of rows) {
      const clash = this.db.prepare("SELECT 1 FROM handoffs WHERE project = ? AND branch = ?").get(to, r.branch as string);
      if (clash) {
        this.addHistory({ ...fromRow(r), project: to }, true);
        this.db.prepare("DELETE FROM handoffs WHERE project = ? AND branch = ?").run(from, r.branch as string);
      } else {
        this.db.prepare("UPDATE handoffs SET project = ? WHERE project = ? AND branch = ?").run(to, from, r.branch as string);
      }
    }
  }
}
