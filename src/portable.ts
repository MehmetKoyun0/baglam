import type { ContextStore, Entry, EventType, Kind } from "./store.js";
import { KINDS } from "./store.js";
import { MAX_DECISION_NOTE, scanSecrets, scanEntryFields, type SecretFinding } from "./guards.js";
import { day } from "./format.js";
import type { Handoff } from "./handoff.js";

export const EXPORT_FORMAT = "baglam/1";

/** Every kind of history event the store writes (the panel has a label for each). */
export const EVENT_TYPES: readonly EventType[] = [
  "proposed", "approved", "rejected", "superseded", "edited", "expired", "deleted", "retired", "archived", "restored", "imported",
];

/** Every row a query matches, fetched page by page (each call counts its own rows). */
function allOf(store: ContextStore, q: Omit<Parameters<ContextStore["query"]>[0], "limit" | "offset">): Entry[] {
  const out: Entry[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = store.query({ ...q, limit: 500, offset });
    out.push(...page.items);
    if (!page.items.length || offset + page.items.length >= page.total) return out;
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = (s: string) => escapeHtml(s.replace(/\r?\n/g, " "));

export interface ExportedEvent {
  entryId: string;
  type: EventType;
  actor: string;
  at: number;
  detail: string | null;
}

export interface BaglamExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  projects: { key: string; name: string }[];
  entries: Entry[];
  events: ExportedEvent[];
  /** Live tasks in progress (optional section). */
  handoffs?: Handoff[];
  /** Per-project settings (optional section). */
  settings?: { project: string; autonomous: boolean; autoCapture?: boolean }[];
}

/** Every record (all statuses) and its history, for one project or all of them. */
export function exportJson(store: ContextStore, opts: { project?: string } = {}): BaglamExport {
  return store.readSnapshot(() => {
    const projects = store
      .listProjects({ includeArchived: true })
      .filter((p) => !opts.project || p.key === opts.project)
      .map((p) => ({ key: p.key, name: p.name }));
    const entries = projects.flatMap((p) => allOf(store, { project: p.key }));
    entries.sort((a, b) => a.createdAt - b.createdAt);
    const events = store.eventsOf(entries.map((e) => e.id)).map(({ project: _p, ...ev }) => ev);
    const keys = projects.map((p) => p.key);
    const handoffs = store.listHandoffs().filter((h) => keys.includes(h.project));
    const settings = keys.flatMap((project) => {
      const s = store.projectSettings(project);
      if (!s.autonomous && s.autoCapture) return [];
      return [{ project, autonomous: s.autonomous, ...(s.autoCapture ? {} : { autoCapture: false }) }];
    });
    return { format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), projects, entries, events, handoffs, settings };
  });
}

const KIND_ORDER: Kind[] = ["warning", "decision", "convention", "preference", "fact"];
const HEADINGS: Record<Kind, string> = {
  warning: "Warnings",
  decision: "Decisions",
  convention: "Conventions",
  preference: "Preferences",
  fact: "Facts",
};

/** Body lines become a blockquote so headings or lists inside a record cannot break the document. */
const quote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/** A readable CONTEXT.md of the project's active records. */
export function exportMarkdown(store: ContextStore, project: string): string {
  const name = store.listProjects({ includeArchived: true }).find((p) => p.key === project)?.name ?? project;
  const active = allOf(store, { project, status: "active" });
  const out = [`# Shared project context: ${oneLine(name)}`, "", `_Exported from Bağlam on ${day(Date.now())}. ${active.length} active record(s)._`];
  for (const kind of KIND_ORDER) {
    const group = active.filter((e) => e.kind === kind);
    if (!group.length) continue;
    out.push("", `## ${HEADINGS[kind]}`);
    for (const e of group) {
      out.push("", `### ${oneLine(e.title)}`, "", quote(e.body));
      if (e.rationale) out.push("", `**Why:** ${oneLine(e.rationale)}`);
      const meta = [`\`${e.id}\``, `from ${e.sourceAgent}`];
      if (e.decidedBy) meta.push(e.autoApproved ? "auto-approved" : `approved by ${e.decidedBy}`);
      if (e.tags.length) meta.push(e.tags.map((t) => `#${t}`).join(" "));
      out.push("", `<sub>${escapeHtml(meta.join(" · "))}</sub>`);
    }
  }
  return out.join("\n") + "\n";
}

export interface ImportResult {
  imported: number;
  /** Imported records that arrived approved, so agents can see them right away. */
  approvedNow: number;
  /** Tasks in progress restored (never replacing a live one). */
  handoffs: number;
  /** Projects that had autonomous mode on in the file; an import never turns it on by itself. */
  autonomousInFile: string[];
  skipped: number;
  failures: { id: string; reason: string }[];
  blocked: { id: string; findings: SecretFinding[] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Coerce one exported record; null when required fields are missing or invalid. */
function toEntry(raw: unknown): Entry | null {
  if (!isObj(raw)) return null;
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  const n = (k: string) => (typeof raw[k] === "number" && Number.isFinite(raw[k]) ? (raw[k] as number) : null);
  const list = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const id = s("id"), project = s("project"), kind = s("kind"), title = s("title"), body = s("body");
  const status = s("status"), sourceAgent = s("sourceAgent"), createdAt = n("createdAt");
  if (!id || !/^c[a-z0-9]{4,20}$/.test(id) || !project || !title || !body || !status || !sourceAgent || createdAt === null) return null;
  if (!KINDS.includes(kind as Kind)) return null;
  const reviewState = raw.reviewState ?? null;
  if (reviewState !== null && (
    (reviewState !== "unreviewed" && reviewState !== "kept") || raw.autoApproved !== true ||
    !["approved", "retired", "superseded"].includes(status)
  )) return null;
  if ("audience" in raw && (!Array.isArray(raw.audience) ||
      !raw.audience.every((value) => typeof value === "string" && value.trim().length > 0))) return null;
  const audience = list("audience");
  return {
    id, project, kind: kind as Kind, title, body, rationale: s("rationale"), tags: list("tags"),
    audience: audience.length ? audience : ["*"], status: status as Entry["status"], sourceAgent, createdAt,
    decidedAt: n("decidedAt"), decidedBy: s("decidedBy"), decisionNote: s("decisionNote"), expiresAt: n("expiresAt"),
    supersedes: s("supersedes"), supersededBy: s("supersededBy"), editedAt: n("editedAt"),
    autoApproved: raw.autoApproved === true, similarTo: list("similarTo"), reviewState,
  };
}

/** Merge an export into this database by record id. Existing ids are never overwritten. */
export function importJson(
  store: ContextStore,
  data: unknown,
  opts: { force?: boolean; by: string; source?: string },
): ImportResult {
  if (!isObj(data) || data.format !== EXPORT_FORMAT || !Array.isArray(data.entries)) {
    throw new Error(`not a Bağlam export (expected "format": "${EXPORT_FORMAT}")`);
  }
  const historyById = new Map<string, ExportedEvent[]>();
  for (const ev of Array.isArray(data.events) ? data.events : []) {
    if (!isObj(ev)) continue;
    const { entryId, type, actor, at, detail } = ev;
    if (typeof entryId !== "string" || !EVENT_TYPES.includes(type as EventType) ||
        typeof actor !== "string" || typeof at !== "number") continue;
    const history = historyById.get(entryId) ?? [];
    history.push({ entryId, type: type as EventType, actor, at, detail: typeof detail === "string" ? detail : null });
    historyById.set(entryId, history);
  }
  const result: ImportResult = { imported: 0, approvedNow: 0, skipped: 0, failures: [], blocked: [], handoffs: 0, autonomousInFile: [] };
  if (Array.isArray(data.projects)) {
    for (const p of data.projects.filter(isObj)) {
      if (typeof p.key === "string" && typeof p.name === "string") store.ensureProject(p.key, p.name);
    }
  }
  const entries = data.entries.map(toEntry);
  // Links can point forward in the export. Existing records win when an id is already present.
  const projectsById = new Map<string, string>();
  for (const e of entries) {
    if (e && !projectsById.has(e.id)) projectsById.set(e.id, e.project);
  }
  for (const [index, e] of entries.entries()) {
    if (!e) {
      const raw = data.entries[index];
      const id = isObj(raw) && typeof raw.id === "string" ? raw.id : "entries[" + index + "]";
      result.failures.push({ id, reason: "invalid record fields" });
      continue;
    }
    if ((e.decisionNote?.length ?? 0) > MAX_DECISION_NOTE) {
      result.failures.push({ id: e.id, reason: "decision note exceeds 1000 characters" });
      continue;
    }
    const history = historyById.get(e.id) ?? [];
    const findings = [...scanEntryFields(e), ...scanSecrets(e.decisionNote ?? ""), ...history.flatMap((ev) => scanSecrets(ev.detail ?? ""))];
    if (findings.length && !opts.force) {
      result.blocked.push({ id: e.id, findings });
      continue;
    }
    try {
      if (store.importEntry(e, history, { actor: opts.by, detail: opts.source ?? null }, projectsById)) {
        result.imported++;
        if (e.status === "approved") result.approvedNow++;
      } else result.skipped++;
    } catch (err) {
      result.failures.push({ id: e.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const handoffs = Array.isArray(data.handoffs) ? data.handoffs : [];
  for (const [index, raw] of handoffs.entries()) {
    if (!isObj(raw) || typeof raw.project !== "string" || typeof raw.branch !== "string" || typeof raw.goal !== "string") {
      result.failures.push({ id: "handoffs[" + index + "]", reason: "invalid handoff fields" });
      continue;
    }
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const restored = store.restoreHandoff({
        project: raw.project,
        branch: raw.branch,
        // A folder from a file is not trusted (git runs there): it is set again on the next checkpoint.
        agent: str(raw.agent) ?? opts.by,
        goal: raw.goal,
        status: raw.status === "blocked" || raw.status === "done" ? raw.status : "in_progress",
        done: strs(raw.done),
        now: str(raw.now),
        next: strs(raw.next),
        files: strs(raw.files),
        blockers: str(raw.blockers),
        notes: str(raw.notes),
        requests: strs(raw.requests),
        request: str(raw.request),
        origin: raw.agentAt === null ? "auto" : undefined,
        newTask: true,
      }, opts.force === true);
      if (restored) result.handoffs++;
    } catch (err) {
      result.failures.push({ id: raw.project + "/" + raw.branch, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (Array.isArray(data.settings)) {
    for (const s of data.settings.filter(isObj)) {
      if (typeof s.project !== "string") continue;
      if (s.autonomous === true) result.autonomousInFile.push(s.project);
      // Turning off automatic saving is privacy-preserving; keep it off on the new machine.
      if (s.autoCapture === false) store.setAutoCapture(s.project, false, opts.by);
    }
  }
  return result;
}
