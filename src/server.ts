import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RootsListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { KINDS, type ContextStore } from "./store.js";
import { FRAMING, escapeHandoffText, briefBudgetFromEnv, formatBrief, formatEntry, formatHandoff } from "./format.js";
import { branchForRequest, gitSnapshot } from "./git.js";
import { floodLimitFromEnv, submitProposal } from "./policy.js";
import { describeFindings } from "./guards.js";
import { resolveProjectFor, type Resolution } from "./resolve.js";
import type { ProjectRef } from "./project.js";
import type { Handoff } from "./handoff.js";

export { VERSION } from "./version.js";
import { VERSION } from "./version.js";

/** The brief counts "how many more" up to this many records. */
const COUNT_CAP = 1000;

export interface ServerOptions {
  /** The server process's working directory (last-resort project guess). */
  cwd: string;
  /** BAGLAM_PROJECT, when set. */
  envProject?: string;
  /** Agent name; when omitted, the MCP client's own name is used. */
  agent?: string;
  /** Clock for checkpoint reminders (tests). */
  now?: () => number;
}

/** An agent whose own task has not been checkpointed for this long gets a reminder on its next tool call. */
const STALE_CHECKPOINT_MS = 5 * 60_000;

const PROPOSAL_VISIBILITY =
  "By default, proposals wait for human approval before they are shared. For verified agents, a matching " +
  "trust rule can auto-approve new records that do not replace or resemble existing records. In autonomous " +
  "mode, eligible proposals from verified agents are shared immediately with their intended audience and " +
  "the owner reviews them afterward. Proposals similar to rejected records still require human approval. ";

const kindSchema = z.enum(KINDS);
const projectPathSchema = z
  .string()
  .optional()
  .describe("Absolute path of your workspace folder. Pass it whenever you know it.");

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function createServer(store: ContextStore, opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "baglam", version: VERSION },
    {
      instructions:
        "Bağlam shares approved project context between AI agents. Call context_brief at the start of a task. " +
        "Call context_propose when you settle a decision, learn a convention or user preference, or hit a pitfall " +
        "other agents should know about. " + PROPOSAL_VISIBILITY +
        "Always pass project_path (your workspace folder) when you know it.",
    },
  );

  const agentName = (): string =>
    opts.agent ?? server.server.getClientVersion()?.name?.trim() ?? "unknown-agent";

  const audienceAgent = opts.agent ?? "*"; // Unbound connections can read only public records.

  // Client roots, fetched lazily and dropped whenever the client says they changed.
  let rootsCache: string[] | undefined;
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    rootsCache = undefined;
  });
  async function clientRoots(): Promise<string[]> {
    if (rootsCache) return rootsCache;
    if (!server.server.getClientCapabilities()?.roots) return [];
    try {
      rootsCache = (await server.server.listRoots()).roots.map((r) => r.uri);
    } catch {
      rootsCache = [];
    }
    return rootsCache;
  }

  async function resolve(projectPath: string | undefined): Promise<Resolution> {
    const r = resolveProjectFor({ projectPath, env: opts.envProject, roots: await clientRoots(), cwd: opts.cwd });
    if (r.ok) store.touchProject(r.project);
    return r;
  }

  /**
   * Tasks (project + branch) this very connection is working on, i.e. has checkpointed as in progress.
   * Only these get reminders: a fresh session never inherits nagging about a crashed session's task.
   */
  const mine = new Map<string, { project: string; branch: string }>();
  const taskKey = (project: string, branch: string) => `${project}\u0000${branch}`;

  /** Agents forget to save progress; remind this connection when its own task in progress has gone stale. */
  function checkpointReminder(): string {
    if (!mine.size) return "";
    const me = agentName();
    const now = (opts.now ?? Date.now)();
    // Automatic saves from tool hooks refresh updatedAt, so never count from it: count from the agent's
    // own last checkpoint, or, for a task only the hooks saved so far (a request after 12 idle hours
    // starts one in this same session), from when that task began.
    const since = (h: Handoff) => h.agentAt ?? h.createdAt;
    let stale: Handoff | undefined;
    for (const [key, t] of mine) {
      const h = store.getHandoff(t.project, t.branch);
      // Someone else took it over, or it was finished or blocked elsewhere: no longer ours to nag about.
      if (!h || h.agent !== me || h.status !== "in_progress") {
        mine.delete(key);
        continue;
      }
      if (now - since(h) >= STALE_CHECKPOINT_MS && (!stale || since(h) < since(stale))) stale = h;
    }
    if (!stale) return "";
    const min = Math.round((now - since(stale)) / 60_000);
    const what =
      stale.agentAt === null
        ? `you have not checkpointed "${stale.goal}" yet (started ${min} min ago). Call context_checkpoint with this task's goal and what you have done`
        : `your last checkpoint on "${stale.goal}" was ${min} min ago. Call context_checkpoint with what you have done since`;
    return `\n\nReminder: ${what} (done_add, now, next), so another agent can continue if you are stopped.`;
  }

  const label = (p: ProjectRef) => `${p.name} (${p.dir})`;

  const guard =
    <A>(fn: (args: A) => Promise<string>, opts2: { remind?: boolean } = {}) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        const out = await fn(args);
        return ok(opts2.remind === false ? out : out + checkpointReminder());
      } catch (err) {
        return fail(err);
      }
    };

  /** The live handoff for this folder's branch, git's view since, and other branches' tasks. */
  async function workState(project: ProjectRef) {
    const all = store.listHandoffs(project.key);
    // Most briefs have no task in progress: don't spend a git call on them.
    if (!all.length) return { branch: "-", live: undefined, git: null, otherBranches: [] };
    const branch = await branchForRequest(project.dir);
    const live = all.find((h) => h.branch === branch);
    const git = live && live.status !== "done" ? await gitSnapshot(project.dir, live.updatedAt) : null;
    return { branch, live, git, otherBranches: all.filter((h) => h.branch !== branch) };
  }

  async function briefFor(project: ProjectRef, agent: string): Promise<string> {
    const total = store.countVisible(project.key, audienceAgent, COUNT_CAP);
    const work = await workState(project);
    return formatBrief({
      handoff: { live: work.live, git: work.git, otherBranches: work.otherBranches },
      project,
      agent,
      // A brief holds a few dozen records at most; fetch the top slice in priority order and count the rest.
      entries: store.visible(project.key, audienceAgent, { limit: 150, byPriority: true }),
      total,
      totalCapped: total >= COUNT_CAP,
      budgetTokens: briefBudgetFromEnv(),
      pendingCount: store.pending(project.key).length,
    });
  }

  async function brief(projectPath: string | undefined): Promise<string> {
    const agent = agentName();
    const r = await resolve(projectPath);
    if (r.ok) return briefFor(r.project, agent);
    const known = r.candidates.filter((c) => c.initialized);
    if (r.reason === "ambiguous" && known.length) {
      return [r.message, ...(await Promise.all(known.map((p) => briefFor(p, agent))))].join("\n\n---\n\n");
    }
    return r.message;
  }

  server.registerResource(
    "brief",
    "baglam://brief",
    {
      title: "Shared project context",
      description: "Approved Bağlam records for the current project (same as the context_brief tool).",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: await brief(undefined) }] }),
  );

  server.registerPrompt(
    "baglam_start",
    {
      title: "Start with shared context",
      description: "Load the project's shared Bağlam context before starting work.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              "Before you start, call the context_brief tool (pass project_path with this workspace's folder) and " +
              "follow the decisions, conventions and warnings it returns. When you settle something other agents " +
              "should know, propose it with context_propose.",
          },
        },
      ],
    }),
  );

  server.registerTool(
    "context_brief",
    {
      title: "Get shared project context",
      description:
        "Returns every approved, active record shared with you for this project: decisions, conventions, " +
        "preferences, facts and warnings. Call this once at the start of a task.",
      inputSchema: { project_path: projectPathSchema },
      annotations: { readOnlyHint: true },
    },
    guard(({ project_path }) => brief(project_path)),
  );

  server.registerTool(
    "context_search",
    {
      title: "Search shared project context",
      description: "Full-text search over approved records shared with you. All words must match.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for"),
        kind: kindSchema.optional().describe("Only return this kind of record"),
        limit: z.number().int().min(1).max(50).optional(),
        project_path: projectPathSchema,
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ query, kind, limit, project_path }) => {
      const r = await resolve(project_path);
      if (!r.ok) return r.message;
      const hits = store.search(r.project.key, audienceAgent, query, { kind, limit });
      if (!hits.length) return `No matching approved records for "${query}".`;
      return [FRAMING, ...hits.map((e) => formatEntry(e))].join("\n\n");
    }),
  );

  server.registerTool(
    "context_get",
    {
      title: "Get one shared record",
      description: "Returns one record by id, including what it replaces or was replaced by.",
      inputSchema: { id: z.string().min(1), project_path: projectPathSchema },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ id, project_path }) => {
      const r = await resolve(project_path);
      if (!r.ok) return r.message;
      const e = store.getForAgent(id, r.project.key, audienceAgent);
      if (!e) throw new Error('no record ' + id + ' is visible to ' + agentName() + ' in this project');
      return `${FRAMING}\n\n${formatEntry(e, { full: true })}`;
    }),
  );

  server.registerTool(
    "context_propose",
    {
      title: "Propose shared context",
      description:
        "Propose a record for other agents on this project. " + PROPOSAL_VISIBILITY +
        "Write it so an agent with no other context can act on it. " +
        "Do not include secrets, credentials or personal data.",
      inputSchema: {
        kind: kindSchema.describe(
          "decision: a choice that was made · convention: how things are done here · preference: what the user wants · " +
            "fact: something true about the project · warning: a pitfall or known problem",
        ),
        title: z.string().min(1).max(200).describe("One-line summary"),
        body: z.string().min(1).max(8000).describe("The content itself, self-contained"),
        rationale: z.string().max(4000).optional().describe("Why; evidence or reasoning"),
        tags: z.array(z.string().max(50)).max(20).optional(),
        audience: z
          .array(z.string().max(100))
          .max(50)
          .optional()
          .describe("Agent names that may see this; omit to share with all agents"),
        ttl_days: z.number().positive().max(3650).optional().describe("Forget after this many days"),
        supersedes: z.string().optional().describe("Id of an existing record this one replaces"),
        project_path: projectPathSchema,
      },
    },
    guard(async ({ ttl_days, project_path, ...rest }) => {
      const r = await resolve(project_path);
      if (!r.ok) throw new Error(r.message);
      const outcome = submitProposal(
        store,
        { ...rest, ttlDays: ttl_days, project: r.project.key, sourceAgent: agentName() },
        { agentVerified: opts.agent !== undefined, floodLimit: floodLimitFromEnv(), autonomous: store.isAutonomous(r.project.key) },
      );
      switch (outcome.status) {
        case "blocked":
          throw new Error(
            `Not stored: it looks like it contains a secret (${describeFindings(outcome.findings)}). ` +
              "Remove it and propose again.",
          );
        case "refused":
          throw new Error(outcome.reason);
        case "auto-shared":
          return `Saved ${outcome.entry.id} ("${outcome.entry.title}") for ${label(r.project)} and shared now (autonomous mode); the owner reviews it afterwards.`;
        case "auto-approved":
          return `Saved ${outcome.entry.id} ("${outcome.entry.title}") for ${label(r.project)} and shared with other agents (auto-approved by a trust rule the owner set).`;
        case "pending": {
          const e = outcome.entry;
          const base = `Proposed ${e.id} ("${e.title}") for ${label(r.project)}. It is pending human approval and is not yet visible to other agents.`;
          // Only name records this agent may already read: never other agents' pending proposals
          // or records whose audience leaves it out. The owner sees the full list in review.
          const shown = outcome.similar.filter((s) =>
            s.status === "approved" && store.getForAgent(s.id, r.project.key, audienceAgent),
          );
          if (!shown.length) return base;
          const list = shown.map((s) => `${s.id} "${s.title}"`).join(", ");
          return `${base}\nSimilar records already exist: ${list}. If yours replaces one, propose again with supersedes set to its id.`;
        }
      }
    }),
  );

  const list = (max: number) => z.array(z.string().max(300)).max(max).optional();

  server.registerTool(
    "context_checkpoint",
    {
      title: "Save progress on the current task",
      description:
        "Save where you are so any agent can continue if you stop (token limit, crash, the user switches tools). " +
        'Call it when you start a task (with goal), after every meaningful step (done_add, now, next), and with status "done" at the end. ' +
        "Fields you leave out keep their values. Shared at once, no review. Never include secrets.",
      inputSchema: {
        goal: z.string().max(300).optional().describe("What the task is (required when starting one)"),
        status: z.enum(["in_progress", "blocked", "done"]).optional(),
        done: list(30).describe("Replace the list of finished steps"),
        done_add: list(30).describe("Append finished steps"),
        now: z.string().max(1000).optional().describe("What you are doing right now"),
        next: list(20).describe("Ordered next steps"),
        files: list(50).describe("Files touched or important, relative to the project"),
        blockers: z.string().max(1000).optional(),
        notes: z.string().max(2000).optional().describe("Anything the next agent must know"),
        new_task: z.boolean().optional().describe("Start a new, unrelated task (the current one goes to history)"),
        project_path: projectPathSchema,
      },
    },
    guard(async ({ project_path, done_add, new_task, ...fields }) => {
      const r = await resolve(project_path);
      if (!r.ok) throw new Error(r.message);
      const branch = await branchForRequest(r.project.dir);
      const h = store.checkpoint({
        ...fields,
        doneAdd: done_add,
        newTask: new_task,
        project: r.project.key,
        branch,
        dir: r.project.dir,
        agent: agentName(),
        agentVerified: opts.agent !== undefined,
      });
      const key = taskKey(r.project.key, branch);
      if (h.status === "in_progress") mine.set(key, { project: r.project.key, branch });
      else mine.delete(key);
      const again =
        h.status === "in_progress"
          ? " Checkpoint again right after your next step (done_add, now, next)."
          : h.status === "done"
            ? " If the user asks for anything more, call context_checkpoint with the new goal before you start working on it."
            : "";
      return `Saved progress for "${h.goal}" (${h.status.replace("_", " ")}, branch ${branch}). Any agent on this project can continue from here.${again}`;
    }, { remind: false }),
  );

  server.registerTool(
    "context_handoff",
    {
      title: "Get the task in progress",
      description: "Full details of the task in progress on this branch: progress, recent history and what git shows changed since.",
      inputSchema: { project_path: projectPathSchema },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ project_path }) => {
      const r = await resolve(project_path);
      if (!r.ok) return r.message;
      const work = await workState(r.project);
      if (!work.live) return `No task in progress on branch ${work.branch}.`;
      const h = work.live;
      const history = store
        .handoffHistory(r.project.key, h.branch, 10)
        .map(
          (x) =>
            `- ${new Date(x.updatedAt).toISOString().slice(0, 16).replace("T", " ")} ${x.agent}: ${x.now ?? x.goal}${x.replaced ? " (replaced by a new task)" : ""}`,
        );
      const details = [
        h.done.length ? `All done steps:\n${h.done.map((d) => `- ${d}`).join("\n")}` : "",
        history.length ? `Recent checkpoints:\n${history.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const summary = formatHandoff({ live: h, git: work.git, otherBranches: [] }, 20_000);
      return details ? summary + "\n\n<unreviewed_history>\n" + escapeHandoffText(details) + "\n</unreviewed_history>" : summary;
    }),
  );

  server.registerPrompt(
    "baglam_resume",
    { title: "Continue the task in progress", description: "Pick up the task another agent was working on." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              'Call context_brief (pass project_path with this workspace\'s folder). If it shows a task under "Continue from here", ' +
              "continue it from its next steps, check the files git lists as changed, and keep calling context_checkpoint as you go.",
          },
        },
      ],
    }),
  );

  return server;
}
