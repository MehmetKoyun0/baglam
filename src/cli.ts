#!/usr/bin/env node
import { copyToClipboard } from "./clipboard.js";
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { ContextStore, KINDS, type Entry, type Kind, type TrustRule } from "./store.js";
import { day, formatEntry, formatHandoff, resumePrompt } from "./format.js";
import { fastBranch, gitSnapshot } from "./git.js";
import { resolveDbPath } from "./config.js";
import { resolveProject } from "./project.js";
import { VERSION } from "./version.js";
import { realHost, writeFileAtomic, type HostEnv } from "./host.js";
import { detectClients, runSetup } from "./setup.js";
import { runInit } from "./init.js";
import { ALL_CLIENTS } from "./clients/index.js";

const KNOWN_AGENT_IDS = ALL_CLIENTS.map((c) => c.id);
import { describeFindings, scanEntryFields } from "./guards.js";
import { exportJson, exportMarkdown, importJson } from "./portable.js";
import { formatCheck, runDoctor, type Handshake } from "./doctor.js";
import { basename, dirname, join } from "node:path";

/**
 * True when the folder or a parent holds `.git` (a folder, or a file in worktrees and submodules).
 * Checked on disk, not by running git, so a missing or refusing git never makes us blame the folder.
 */
function insideGitRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}
import type { Change } from "./clients/types.js";

const USAGE = `Usage: baglam <command> [options]

Get started:
  setup [--yes] [--dry-run] [--undo]  Connect Bağlam to every AI tool installed on this machine
  init [--name n] [--local] [--here] [--undo]
                                      Prepare this folder: project id + instructions for agents
  ui [--port n] [--no-open]           Open the review panel in your browser
  doctor                              Check that everything is connected, with fixes

Review what agents proposed:
  pending [--all-projects]            List proposals waiting for review
  approve (<id...> | --all [--all-projects]) [--note t]
                                      Approve the selected proposals together
  reject <id> [--note text]           Reject a proposal

Manage context yourself:
  add <kind> <title> <body> [--why text] [--tags a,b] [--to agent,agent] [--ttl days] [--replaces id] [--force]
                                      Add an approved record (kind: ${KINDS.join(" | ")})
  list [--everything]                 Show active records (--everything: all statuses)
  show <id>                           Show one record in full
  projects                            Projects in the database with counts

Continue work across agents:
  handoff [--branch b] [--history] [--copy]   The task in progress (copy: resume prompt for any AI tool)
  handoff clear [--branch b]          Mark the task in progress as done
  capture on|off|status               Automatic saving of requests, edited files and replies (on by default)

Autonomous mode (share now, review afterwards):
  auto on [--yes] | auto off | auto status
  review [--all-projects]             Records shared automatically, waiting for your look
  keep <id...> | --all [--all-projects]  Keep them · undo <id>  Take one back

Trust (opt-in auto-approval):
  trust add [--agent id] [--kind k] [--global]  Let matching records skip review
  trust list | trust remove <id>

Move data:
  export [--format md|json] [--out file] [--all-projects]   CONTEXT.md or a full JSON backup
  import <file.json> [--force]        Merge a JSON export (existing records are kept)

For AI tools:
  mcp                                 Run the MCP server on stdio (what setup registers)

Options:
  --project <path>                    Project to act on (default: the project of the current folder)
  --version, --help

Environment:
  BAGLAM_DB            database file (default ~/.baglam/baglam.db)
  BAGLAM_PROJECT       project folder override
  BAGLAM_AGENT         agent id (set by setup for each tool)
  BAGLAM_USER          name recorded for your approvals (default human:<os user>)
  BAGLAM_FLOOD_LIMIT   pending proposals allowed per agent (default 20)
  BAGLAM_BRIEF_BUDGET  token budget of context_brief (default 2000)
  BAGLAM_AUTO_CAPTURE   set to 0 to disable automatic saving across projects
  BAGLAM_HANDOFF_TTL_DAYS  handoff retention in days (default 7)
  BAGLAM_HOOK_INJECT   set to 0 to disable automatic context injection in hooks`;

export interface CliContext {
  store: ContextStore;
  project: string;
  user: string;
  print: (line: string) => void;
  /** Machine access for setup/init/doctor (default: the real machine). */
  host?: HostEnv;
  /** False when nobody can answer a question (CI, piped input). */
  interactive?: boolean;
  /** Answer to "connect these tools?" collected before runCli (interactive shells). */
  confirm?: (labels: string[]) => boolean;
  /** Test seams for doctor. */
  doctor?: { handshake?: Handshake; dbPath?: string };
}

const MARK: Record<Change["action"], string> = {
  added: "✓", updated: "✓", removed: "✓", unchanged: "·", absent: "·", skipped: "✗",
};

export function formatChange(c: Change, label: string): string {
  const line = `${MARK[c.action]} ${label.padEnd(22)} ${c.action.padEnd(9)} ${c.file}`;
  return c.note ? `${line}
    ${c.note}` : line;
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

function describeRule(r: TrustRule): string {
  const who = r.agent ? `from ${r.agent}` : "from any agent";
  const what = r.kind ? `${r.kind} records` : "all records";
  const where = r.projectId ? "this project" : "all projects";
  return `auto-approve ${what} ${who} in ${where}`;
}

function summary(e: Entry): string {
  return `${e.id}  [${e.kind}] ${e.title}\n         from ${e.sourceAgent} · ${day(e.createdAt)}${
    e.supersedes ? ` · replaces ${e.supersedes}` : ""
  }${e.audience.includes("*") ? "" : ` · only for ${e.audience.join(", ")}`}`;
}

export function runCli(argv: string[], ctx: CliContext): number | Promise<number> {
  // ctx.store is read lazily so commands that never touch the database never open it.
  const { user, print } = ctx;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: "boolean" },
        "all-projects": { type: "boolean" },
        everything: { type: "boolean" },
        note: { type: "string" },
        why: { type: "string" },
        tags: { type: "string" },
        to: { type: "string" },
        ttl: { type: "string" },
        replaces: { type: "string" },
        project: { type: "string" },
        yes: { type: "boolean", short: "y" },
        "dry-run": { type: "boolean" },
        undo: { type: "boolean" },
        here: { type: "boolean" },
        local: { type: "boolean" },
        name: { type: "string" },
        branch: { type: "string" },
        history: { type: "boolean" },
        copy: { type: "boolean" },
        force: { type: "boolean" },
        global: { type: "boolean" },
        agent: { type: "string" },
        kind: { type: "string" },
        format: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    print(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values: o, positionals } = parsed;
  const project = o.project ? resolveProject(o.project) : ctx.project;
  const reviewProject = o["all-projects"] ? undefined : project;
  const [cmd, ...args] = positionals;
  if (o.version && cmd === undefined) {
    print(VERSION);
    return 0;
  }

  try {
    switch (cmd) {
      case "pending": {
        const items = ctx.store.pending(reviewProject);
        if (!items.length) {
          print("Nothing waiting for review.");
          return 0;
        }
        for (const e of items) {
          print(summary(e) + (o["all-projects"] ? `\n         project ${e.project}` : ""));
          print(`         ${e.body.replace(/\s+/g, " ").slice(0, 160)}`);
          if (e.similarTo.length) print(`         ⚠ possible duplicate of ${e.similarTo.join(", ")}`);
        }
        print(`\n${items.length} pending. Approve: baglam approve <id...>  ·  Reject: baglam reject <id>`);
        return 0;
      }
      case "approve": {
        const ids = o.all ? ctx.store.pending(reviewProject).map((e) => e.id) : args;
        if (!ids.length) throw new Error(o.all ? "nothing pending" : "give at least one id, or --all");
        const { approved } = ctx.store.approveMany(ids, user, { strict: true, note: o.note });
        for (const id of approved) {
          print(`approved ${id}  ${ctx.store.get(id)?.title ?? ""}`.trimEnd());
        }
        return 0;
      }
      case "reject": {
        if (args.length !== 1) throw new Error("give exactly one id");
        const e = ctx.store.reject(args[0], user, o.note);
        print(`rejected ${e.id}  ${e.title}`);
        return 0;
      }
      case "add": {
        const [kind, title, body] = args;
        if (!body) throw new Error("add needs <kind> <title> <body>");
        const findings = scanEntryFields({ title, body, rationale: o.why, tags: list(o.tags), audience: list(o.to) });
        if (findings.length && !o.force) {
          print(
            `This looks like it contains a secret: ${describeFindings(findings)}.\n` +
              "Anything in Bağlam is shown to your AI agents. Add --force to store it anyway.",
          );
          return 1;
        }
        const like = o.force || o.replaces ? [] : ctx.store.findSimilar(project, { title, body }, { kind: kind as Kind, limit: 1 });
        if (like.length) {
          const l = like[0];
          print(
            `This looks like ${l.id} "${l.title}", which agents already see.\n` +
              `  To replace it:   add the same again with --replaces ${l.id}\n` +
              "  To keep both:    add --force",
          );
          return 1;
        }
        const e = ctx.store.addApproved(
          {
            project,
            kind: kind as Kind,
            title,
            body,
            rationale: o.why,
            tags: list(o.tags),
            audience: list(o.to),
            ttlDays: o.ttl ? Number(o.ttl) : undefined,
            supersedes: o.replaces,
          },
          user,
        );
        print(`added ${e.id}  [${e.kind}] ${e.title}`);
        return 0;
      }
      case "list": {
        const items = o.everything
          ? ctx.store.all(project)
          : ctx.store.all(project).filter((e) => e.status === "approved" && (!e.expiresAt || e.expiresAt > Date.now()));
        if (!items.length) {
          print(`No records for ${project}.`);
          return 0;
        }
        for (const e of items) print(formatEntry(e) + "\n");
        return 0;
      }
      case "show": {
        const e = ctx.store.get(args[0] ?? "");
        if (!e) throw new Error(`unknown entry ${args[0] ?? ""}`);
        print(`${formatEntry(e, { full: true })}\nProject: ${e.project}`);
        return 0;
      }
      case "setup": {
        const host = ctx.host ?? realHost();
        if (!o.undo && /[\\/]_npx[\\/]/.test(host.cliPath)) {
          print(
            "This copy of Bağlam runs from npm's temporary npx cache, which npm may delete at any time;\n" +
              "registering it would break every tool later. Install it permanently first:\n\n" +
              "  npm i -g baglam\n  baglam setup",
          );
          return 1;
        }
        const found = detectClients(host);
        if (!found.length) {
          print("No supported AI tools found (Claude Code, Codex, Antigravity, Gemini CLI, Cursor, Windsurf, VS Code).");
          return 0;
        }
        const labels = found.map((c) => c.label);
        print(`Found: ${labels.join(", ")}`);
        let confirm: () => boolean;
        if (o.yes || o["dry-run"]) confirm = () => true;
        else if (ctx.confirm) confirm = () => ctx.confirm!(labels);
        else {
          print("Run again with --yes to confirm (this shell cannot ask).");
          return 1;
        }
        const result = runSetup(host, { undo: o.undo, dryRun: o["dry-run"], confirm });
        if (!result.changes.length) {
          print("Nothing changed.");
          return 0;
        }
        const label = (id: string) => found.find((c) => c.id === id)?.label ?? id;
        if (o["dry-run"]) print("Dry run, nothing was written:");
        for (const c of result.changes) print(formatChange(c, c.part ? `${label(c.client)} ${c.part}` : label(c.client)));
        const failed = result.changes.filter((c) => c.action === "skipped").length;
        if (!o["dry-run"]) print(`
Restart these apps so they load the change.${failed ? ` ${failed} tool(s) need attention (see ✗ above).` : ""}`);
        return failed ? 1 : 0;
      }
      case "export": {
        const format = o.format ?? "md";
        if (format !== "md" && format !== "json") throw new Error("--format must be md or json");
        if (format === "md" && o["all-projects"]) {
          throw new Error("Markdown export covers one project at a time; use --format json --all-projects for everything");
        }
        const text =
          format === "json"
            ? JSON.stringify(exportJson(ctx.store, { project: o["all-projects"] ? undefined : project }), null, 2) + "\n"
            : exportMarkdown(ctx.store, project);
        if (o.out) {
          writeFileAtomic(o.out, text, 0o600, false);
          print(`Wrote ${o.out}`);
        } else print(text.trimEnd());
        return 0;
      }
      case "import": {
        if (args.length !== 1) throw new Error("give the export file: baglam import <file.json>");
        let data: unknown;
        try {
          data = JSON.parse(readFileSync(args[0], "utf8"));
        } catch (err) {
          throw new Error(`cannot read ${args[0]} as JSON (${(err as Error).message})`);
        }
        const r = importJson(ctx.store, data, { force: o.force, by: user, source: basename(args[0]) });
        print(`Imported ${r.imported} record(s); ${r.skipped} skipped (already present).`);
        if (r.handoffs) print(`Restored ${r.handoffs} task(s) in progress.`);
        if (r.autonomousInFile.length) {
          print("Autonomous mode was on for some projects in the file; it stays off here. Turn it on with: baglam auto on");
        }
        if (r.approvedNow) {
          print(`${r.approvedNow} of them ${r.approvedNow === 1 ? "is" : "are"} approved and visible to agents now (as in the file). Review them with baglam list.`);
        }
        for (const b of r.blocked) print(`✗ ${b.id} not imported: looks like a secret (${describeFindings(b.findings)}). Use --force to import anyway.`);
        for (const failure of r.failures) print(failure.id + " not imported: " + failure.reason);
        return r.blocked.length || r.failures.length ? 1 : 0;
      }
      case "auto": {
        const sub = args[0] ?? "status";
        const rules =
          "Records from agents connected by baglam setup are shared at once and listed for you to review afterwards " +
          "(baglam review, or the panel). Secrets are always blocked, the 20-proposal limit stays, and anything that looks " +
          "like something you rejected before still waits for you.";
        if (sub === "status") {
          print(ctx.store.isAutonomous(project) ? `Autonomous mode is on for this project.\n${rules}` : "Autonomous mode is off: every proposal waits for your review.");
          return 0;
        }
        if (sub === "off") {
          ctx.store.setAutonomous(project, false, user);
          print("Autonomous mode is off: proposals wait for your review again.");
          return 0;
        }
        if (sub !== "on") throw new Error("use: baglam auto on|off|status");
        if (!o.yes) {
          if (!ctx.interactive || !ctx.confirm) {
            print(`${rules}\n\nRun again with --yes to turn autonomous mode on (this shell cannot ask).`);
            return 1;
          }
          if (!ctx.confirm(["autonomous mode for this project"])) {
            print("Autonomous mode stays off.");
            return 0;
          }
        }
        ctx.store.setAutonomous(project, true, user);
        print(`Autonomous mode is on for this project.\n${rules}`);
        return 0;
      }
      case "capture": {
        const sub = args[0] ?? "status";
        const what =
          "Your requests, the files agents edit and their last reply are saved to the task in progress by each tool's hooks " +
          "(set up by baglam setup), even when the agent forgets to checkpoint. Stored only on this computer; secrets are hidden.";
        if (sub === "on" || sub === "off") ctx.store.setAutoCapture(project, sub === "on", user);
        else if (sub !== "status") throw new Error("use: baglam capture on|off|status");
        print(ctx.store.isAutoCapture(project) ? `Automatic saving is on for this project.\n${what}` : "Automatic saving is off for this project.");
        return 0;
      }
      case "handoff": {
        const dir = o.project ?? process.cwd();
        const branch = o.branch ?? fastBranch(dir);
        if (args[0] === "clear") {
          print(ctx.store.clearHandoff(project, branch, user) ? `Marked the task on ${branch} as done.` : `No task in progress on ${branch}.`);
          return 0;
        }
        const live = ctx.store.getHandoff(project, branch);
        if (!live) {
          const others = ctx.store.listHandoffs(project).filter((h) => h.status !== "done");
          print(`No task in progress on ${branch}.`);
          for (const h of others) print(`  ${h.branch}: "${h.goal}" (${h.agent}) — baglam handoff --branch ${h.branch}`);
          return 0;
        }
        if (o.history) {
          for (const h of ctx.store.handoffHistory(project, branch, 50)) {
            print(`${new Date(h.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${h.agent.padEnd(12)} ${h.replaced ? "(replaced) " : ""}${h.goal}${h.now ? ` — ${h.now}` : ""}`);
          }
          return 0;
        }
        if (o.copy) {
          const projectName = ctx.store.listProjects({ includeArchived: true }).find((p) => p.key === project)?.name ?? project;
          const records = ctx.store.query({ project, status: "active", limit: 50 }).items;
          const host = ctx.host ?? realHost();
          return (live.dir && existsSync(live.dir) ? gitSnapshot(live.dir, live.updatedAt) : Promise.resolve(null)).then((git) => {
          const text = resumePrompt({ projectName, dir: live.dir, handoff: live, git, records });
          if (copyToClipboard(host, text)) {
            print("Copied a resume prompt to the clipboard. Paste it into any AI tool to continue this task.");
          } else {
            print("Could not reach the clipboard; here is the resume prompt to copy:\n");
            print(text.trimEnd());
          }
          return 0;
          });
        }
        const otherBranches = ctx.store.listHandoffs(project).filter((h) => h.branch !== branch && h.status !== "done");
        print(formatHandoff({ live, git: null, otherBranches }, 20_000));
        return 0;
      }
      case "review": {
        const items = ctx.store.unreviewed(reviewProject);
        if (!items.length) {
          print("Nothing to review: no records were shared automatically since your last review.");
          return 0;
        }
        for (const e of items) {
          print(summary(e) + (o["all-projects"] ? `\n         project ${e.project}` : ""));
          print(`         ${e.body.replace(/\s+/g, " ").slice(0, 160)}`);
        }
        print(`\n${items.length} shared automatically. Keep: baglam keep <id...> | --all  ·  Undo: baglam undo <id>`);
        return 0;
      }
      case "keep": {
        const ids = o.all ? ctx.store.unreviewed(reviewProject).map((e) => e.id) : args;
        if (!ids.length) throw new Error(o.all ? "nothing to review" : "give at least one id, or --all");
        print(`Kept ${ctx.store.keep(ids, user)} record(s).`);
        return 0;
      }
      case "undo": {
        if (args.length !== 1) throw new Error("give exactly one id");
        const r = ctx.store.undoAuto(args[0], user);
        print(`Undid ${r.undone.id} ("${r.undone.title}"); agents no longer see it and it will not be shared automatically again.`);
        if (r.restored) print(`Restored ${r.restored.id} ("${r.restored.title}"), the record it had replaced.`);
        if (r.note) print(`Note: ${r.note}.`);
        return 0;
      }
      case "trust": {
        const [sub, id] = args;
        if (sub === "add") {
          const rule = ctx.store.addTrustRule({
            projectId: o.global ? null : project,
            agent: o.agent,
            kind: o.kind as Kind | undefined,
          });
          print(`added ${rule.id}  ${describeRule(rule)}`);
          if (rule.agent && !KNOWN_AGENT_IDS.includes(rule.agent)) {
            print(`Note: "${rule.agent}" is not one of the agent ids baglam setup writes (${KNOWN_AGENT_IDS.join(", ")}); the rule only matches an agent with exactly that BAGLAM_AGENT.`);
          }
          print(
            "Records matching this rule skip your review. Secrets are always blocked; look-alikes of existing,\n" +
              "rejected or replaced records and anything that replaces a record still come to you for review.",
          );
          return 0;
        }
        if (sub === "list") {
          const rules = ctx.store.listTrustRules(project);
          if (!rules.length) print("No trust rules. Every proposal waits for your review.");
          for (const r of rules) print(`${r.id}  ${describeRule(r)}`);
          return 0;
        }
        if (sub === "remove") {
          if (!id) throw new Error("give the rule id (see baglam trust list)");
          if (!ctx.store.removeTrustRule(id)) throw new Error(`no trust rule ${id}`);
          print(`removed ${id}`);
          return 0;
        }
        throw new Error("use: baglam trust add|list|remove");
      }
      case "doctor": {
        const host = ctx.host ?? realHost();
        return runDoctor({
          host,
          dbPath: ctx.doctor?.dbPath ?? resolveDbPath(),
          cwd: o.project ?? process.cwd(),
          handshake: ctx.doctor?.handshake,
        }).then(
          (checks) => {
            for (const c of checks) print(formatCheck(c));
            const bad = checks.filter((c) => !c.ok).length;
            print(bad ? `\n${bad} problem(s) found.` : "\nEverything looks good.");
            return bad ? 1 : 0;
          },
          (err: Error) => {
            print(`Error: ${err.message}`);
            return 1;
          },
        );
      }
      case "init": {
        const host = ctx.host ?? realHost();
        const dir = o.project ?? process.cwd();
        const r = runInit(dir, { store: ctx.store, host, undo: o.undo, here: o.here, local: o.local, name: o.name });
        print(`Project: ${r.project.name}  (id ${r.project.key})`);
        print(`Folder:  ${r.project.dir}`);
        if (r.moved) print(`Moved ${r.moved} existing record(s) to this project id.`);
        for (const c of r.changes) print(formatChange(c, basename(c.file)));
        if (r.excluded?.length) print(`Added to .git/info/exclude (local only): ${r.excluded.join(", ")}`);
        if (!o.undo) {
          const connected = detectClients(host).some((c) => {
            try {
              return c.status(host).registered;
            } catch {
              return false;
            }
          });
          if (!connected) {
            print('\nNote: no AI tools are connected to Bağlam yet. Run "baglam setup" to connect Claude Code, Codex, Cursor, etc.');
          }
        }
        if (!o.undo && !insideGitRepo(r.project.dir)) {
          print(
            "\nNote: this folder is not a git repository. Handoffs between agents work much better with git: Bağlam then\n" +
              "shows the next agent which files changed after the last checkpoint, even if the previous one stopped abruptly.\n" +
              "  git init",
          );
        }
        if (o.undo) print("\nInstructions removed. The project id (.baglam/project.json) is kept so its history stays linked.");
        else if (o.local) print("\nAgents in this folder will now load the shared context at the start of each task (kept local via .git/info/exclude).");
        else print("\nAgents in this folder will now load the shared context at the start of each task.\nCommit .baglam/project.json so the project keeps its identity everywhere.");
        return 0;
      }
      case "projects": {
        const rows = ctx.store.listProjects();
        if (!rows.length) print("No projects yet.");
        for (const r of rows) {
          print(`${String(r.approved).padStart(4)} active  ${String(r.pending).padStart(3)} pending  ${r.name}${r.path ? `  (${r.path})` : ""}`);
        }
        return 0;
      }
      case undefined:
      case "help":
        print(USAGE);
        return o.help || cmd === "help" ? 0 : 1;
      default:
        print(`Unknown command "${cmd}".\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return 1;
  }
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain() && process.argv[2] === "ui") {
  const { runUi } = await import("./ui/launch.js");
  try {
    await runUi(process.argv.slice(3));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
} else if (isMain() && process.argv[2] === "mcp") {
  const { startMcpServer } = await import("./mcp.js");
  await startMcpServer();
} else if (isMain()) {
  const argv = process.argv.slice(2);
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  let confirm: CliContext["confirm"];
  if (argv[0] === "setup" && interactive && !argv.includes("--yes") && !argv.includes("-y") && !argv.includes("--dry-run")) {
    const labels = detectClients(realHost()).map((c) => c.label);
    if (labels.length) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const verb = argv.includes("--undo") ? "Disconnect Bağlam from" : "Connect Bağlam to";
      const answer = (await rl.question(`${verb} ${labels.join(", ")}? [Y/n] `)).trim().toLowerCase();
      rl.close();
      const yes = answer === "" || answer === "y" || answer === "yes" || answer === "e" || answer === "evet";
      confirm = () => yes;
    }
  }
  if (argv[0] === "auto" && argv[1] === "on" && interactive && !argv.includes("--yes") && !argv.includes("-y")) {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(
      "Autonomous mode shares records from your set-up agents at once; you review them afterwards.\n" +
        "Secrets stay blocked and anything you rejected before still waits for you.",
    );
    // Defaults to No: this removes a review step, so it must be a deliberate yes.
    const answer = (await rl.question("Turn on autonomous mode for this project? [y/N] ")).trim().toLowerCase();
    rl.close();
    const yes = answer === "y" || answer === "yes" || answer === "e" || answer === "evet";
    confirm = () => yes;
  }
  // Open (and so create or migrate) the database only when a command actually touches it:
  // help, version, setup and doctor must never write it.
  let opened: ContextStore | undefined;
  const ctx: CliContext = {
    get store() {
      return (opened ??= new ContextStore(resolveDbPath()));
    },
    project: resolveProject(),
    user: process.env.BAGLAM_USER?.trim() || `human:${userInfo().username}`,
    print: (s) => console.log(s),
    interactive,
    confirm,
  };
  const code = await runCli(argv, ctx);
  opened?.close();
  process.exitCode = code;
}
