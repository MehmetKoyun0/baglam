# Bağlam

**Shared, human-approved project memory for AI coding agents, and seamless handoff between them.**

> Your agent ran out of tokens? The next one picks up where it stopped.

[Türkçe](README.tr.md)

You use Claude Code on Monday, Cursor on Tuesday and Codex on Wednesday, and you explain the same decisions to each of them. Bağlam ("context" in Turkish) gives all your agents one shared memory per project, and you decide what goes into it.

```
 agent learns something ──► proposes it ──► you approve ──► every agent knows it
   (any tool, any vendor)   context_propose   baglam ui      context_brief
```

- **Works with the tools you already use:** Claude Code, Codex CLI, Antigravity, Gemini CLI, Cursor, Windsurf, VS Code (any MCP client).
- **You stay in control:** nothing an agent writes reaches other agents until you approve it, or until a trust rule you set allows it.
- **Safe by default:** secrets are blocked, look-alike records are flagged, and an agent can't flood your queue.
- **Local-first:** one SQLite file on your machine. No account, no cloud, no telemetry.

## Install

Requires Node.js 22.13 or newer.

```bash
npm i -g baglam
baglam setup
```

`setup` finds the AI tools on your computer, shows what it will change and asks once. Every file it touches is backed up first (`*.baglam-backup`), and `baglam setup --undo` removes it again. Restart your tools afterwards.

Then, in each project folder:

```bash
cd my-project
baglam init
```

`init` gives the folder a stable project id (`.baglam/project.json`, worth committing) and adds a short instruction block to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/baglam.mdc`, `.github/copilot-instructions.md` and `.windsurf/rules/baglam.md` as applicable to the installed tools, so agents load the shared context at the start of every task without being told.

## Daily use

```bash
baglam ui        # review panel in your browser
baglam pending   # or review in the terminal
baglam approve <id> · baglam reject <id> --note "why"
```

The panel shows proposals as cards: approve, edit & approve, or reject. Keyboard: `j`/`k` move, `a` approve, `e` edit, `r` reject. It also lists every record with its history, your projects, trust rules and which tools are connected. It runs only on `127.0.0.1`, and its link works once.

Add something yourself, approved at once:

```bash
baglam add warning "Prod DB is read-only" "Never run migrations from an agent session." --ttl 30
baglam add preference "UI copy is Turkish" "All user-facing text is Turkish." --to cursor,claude-code
baglam add decision "Moved to MySQL" "Primary DB is MySQL 8." --replaces <old-id>
```

Kinds: `decision`, `convention`, `preference`, `fact`, `warning`.

## What agents get

| MCP tool | What it does |
|---|---|
| `context_brief` | All approved, active records for this project, warnings and decisions first, kept under a token budget |
| `context_search` | Full-text search over approved records |
| `context_get` | One record, including what it replaced |
| `context_propose` | Propose a record; it waits for your review |
| `context_checkpoint` | Save progress on the current task (goal, done, now, next, files), shared at once |
| `context_handoff` | Full details of the task in progress, its recent checkpoints and git changes |

Agents pass `project_path` (their workspace folder), so Bağlam always knows the project. If it can't tell, it refuses to write rather than guess.

## Switch agents mid-task

Agents save their progress with `context_checkpoint` after every meaningful step: the goal, what is done, what they are doing now, what comes next and which files matter. When you switch tools (Claude Code ran out, you open Codex), the next agent's brief opens with:

```
## Continue from here
Task: Stripe checkout (in progress) · last update 12 min ago by claude-code
Done: form validation; price calculation
Now: webhook handler in src/payment/webhook.ts
Next: 1) verify signature  2) idempotency  3) tests
Since then (git): 3 files changed, not committed: src/payment/webhook.ts, …
```

The "Since then (git)" line comes from git, not from the agent, so it is right even when the previous agent stopped without warning. One live task per project and branch; it expires after 7 days. Progress notes are shared at once (no review) and secrets are still blocked.

```bash
baglam handoff            # the task in progress
baglam handoff --copy     # copy a resume prompt for any AI tool, even one without Bağlam
baglam handoff clear      # mark it done
```

The panel shows the same as a card at the top of the Inbox.

### Automatic saving

Agents sometimes forget to checkpoint. `baglam setup` therefore also installs small hooks in each tool, and they save the task in progress on their own, even when the agent never calls Bağlam:

- **your request**, when you send it (it starts a task, or joins the one in progress, so "continue" to the next agent picks it up);
- **every file the agent edits**;
- **the agent's last reply** when its turn ends ("Last reply: …"), unless the agent checkpointed itself.

The agent's own checkpoints stay the richer source; automatic saving never marks a task done or rewrites its next steps. It only works in folders where you ran `baglam init`, everything stays on this computer, and secrets are hidden.

```bash
baglam capture off        # turn it off for this project (on by default); also in the panel's Settings
```

Supported: Claude Code, Codex CLI, Cursor, Antigravity, Gemini CLI, VS Code (Copilot agent hooks, preview). Antigravity gives no reply text, so there only the request and the files are saved. **Codex asks you to trust new hooks once:** open Codex, run `/hooks` and trust Bağlam's. `baglam doctor` shows, per tool, when it last saved automatically.

## Autonomous mode (optional)

Don't want to stop for approvals? Per project:

```bash
baglam auto on
```

Records from agents set up by `baglam setup` are shared at once and listed for you to review afterwards (`baglam review`, `baglam keep <id>`, `baglam undo <id>`, or the panel). Undoing a replacement brings the old record back. Secrets stay blocked, the proposal limit stays, and anything you rejected before still waits for you. `baglam auto off` returns to review-first.

## Trust rules (optional)

By default every proposal waits for you. To let some through:

```bash
baglam trust add --agent codex --kind fact          # this project
baglam trust add --kind convention --global         # every project
baglam trust list · baglam trust remove <id>
```

Trust rules never apply to secrets (always blocked), to records that replace another, to look-alikes of existing records, or to anything you rejected before.

## When something doesn't work

```bash
baglam doctor
```

It checks Node, the database, each tool's registration (and starts the server the way the tool would), and the current folder, and prints a fix for each problem. See [docs/troubleshooting.md](docs/troubleshooting.md) and per-tool setup in [docs/clients.md](docs/clients.md).

## Data

- One file: `~/.baglam/baglam.db` (`BAGLAM_DB` to move it). Upgrades back it up first.
- Configure the project and agent with `BAGLAM_PROJECT` and `BAGLAM_AGENT`, and the review author with `BAGLAM_USER`. `BAGLAM_FLOOD_LIMIT` controls the review queue and `BAGLAM_BRIEF_BUDGET` the brief size. Set `BAGLAM_AUTO_CAPTURE=0` to disable automatic saving or `BAGLAM_HOOK_INJECT=0` to disable hook context injection. `BAGLAM_HANDOFF_TTL_DAYS` sets handoff retention (default 7 days).
- `baglam export --format md` writes a readable `CONTEXT.md`; `--format json` writes a full backup with history; `baglam import <file>` merges one back (existing records are never overwritten).
- Every change is recorded: who proposed, who approved, edits, retirements.

## Limits worth knowing

- Agent names are labels set by `baglam setup`, not a security boundary: any program on your computer can already read the database. Your approval is the boundary.
- Agents that are not set up by `baglam setup` report their own name; the 20-proposal limit counts per name.
- Speed: brief, search and duplicate checks stay under 50 ms with 10,000+ records.

## Development

```bash
npm install
npm test            # unit, MCP, CLI, panel API and UI tests, 10k-record speed test
npm run typecheck
npm run build       # server to dist/, panel to dist/panel
npm run smoke       # pack, install into a temp prefix, run the installed CLI
```

Design: [docs/superpowers/specs/2026-11-17-baglam-v1-design.md](docs/superpowers/specs/2026-11-17-baglam-v1-design.md). Licence: MIT.
