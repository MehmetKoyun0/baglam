# Changelog

All notable changes to Bağlam. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-11-24

### Security
- Count pending and automatically shared records awaiting review against the same per-agent, per-project limit.
- Restrict POSIX permissions on database files, migration backups, hook logs and exports.
- Scan credential assignments, Base64 credentials, decision notes, CLI audiences and imported event details.

### Fixed
- Repair invalid project markers with a valid UUID and preserve path-based records when naming the project.

## [1.0.0] - 2026-11-23

### Security
- **Project isolation:** reject imported replacement links across projects and enforce the project boundary when approving or undoing a replacement.
- **Client config permissions:** preserve existing POSIX permission bits during setup and removal. Create new client config files with owner-only access.
- **MCP record visibility:** clients without a configured agent identity can read public records only, and expired records are unavailable through direct lookup.
- **Import audience validation:** reject malformed audience fields to prevent restricted records from becoming public.

### Fixed
- **Autonomous review:** JSON round trips preserve pending and completed review states so automatically shared records remain reviewable and can still be undone.
- **Backup consistency:** JSON exports use a single SQLite snapshot across pages, history, handoffs and settings. Imports identify failed records and handoffs and return a nonzero exit code on incomplete restores.
- **Automatic capture:** keep revised requests that reuse a heading while coalescing duplicate hook deliveries.
- **Review panel:** ignore stale responses when switching records or filters. On Linux, the printed panel link remains usable when the browser launcher is missing.
- **Linked worktrees:** calculate `baglam init --local` exclusions relative to the active worktree and write them to Git's common exclude file.
- **MCP guidance:** explain the default human approval step, automatic approval through trust rules and review after immediate sharing in autonomous mode.
- **Instant panel updates:** `GET /api/overview` caches slow CLI tool probes (such as `claude mcp get`) for 30 s while still reading pending counts and hook activity live from SQLite, eliminating the ~1.5 s badge lag after approving or rejecting proposals (`?fresh=1` bypasses the cache).
- **Faster `baglam doctor`:** MCP server handshakes now run concurrently across detected tools instead of sequentially (preserving deterministic output order).
- **`baglam handoff` CLI:** also lists other branches with tasks in progress when the current branch has a live task.
- **Git snapshot performance:** fetch worktree status and commit history in parallel to reduce snapshot latency on Windows.
- **Import performance:** index exported history by record ID so import processes it in one pass.

## [1.0.0-rc.6] - 2026-11-21

Automatic context injection through hooks, cross-platform reliability fixes (macOS/Linux/Windows), partial secret redaction, and init/doctor/panel upgrades. **Re-run `baglam setup` after upgrading** to install the new session-start hooks.

### Added
- **Automatic context injection via hooks:** `baglam setup` now installs `SessionStart` / `sessionStart` hooks for Claude Code, Codex CLI, Gemini CLI, Cursor and VS Code Copilot. When you open a new session (or switch directly from another agent in an already-open session), Bağlam injects the live task in progress and approved project memory automatically — so typing `"devam et"` / `"continue"` works without relying on the agent remembering to call MCP first. Set `BAGLAM_HOOK_INJECT=0` to disable injection while keeping auto-capture.
- **`baglam init` improvements:** writes VS Code Copilot (`.github/copilot-instructions.md`) and Windsurf (`.windsurf/rules/baglam.md`) instructions when those tools are installed, adds `--local` (keeps Bağlam files untracked via `.git/info/exclude`) and `--name <name>`, and warns when no AI tools have been connected via `baglam setup` yet.
- **Panel upgrades:** Settings now shows each tool's auto-save hook health and last activity time alongside MCP connection status; Continue cards now include collapsible views for the full multi-line request and recent checkpoint history.
- **Broader secret detection and partial redaction:** detects npm (`npm_`), Hugging Face (`hf_`), Supabase (`sbp_`), Groq (`gsk_`), Resend (`re_`), Telegram bot tokens, `Bearer` tokens and `.env`-style secret assignments; automatic capture now redacts only the secret (`[redacted]`) instead of erasing the entire task plan.

### Fixed
- **Linux clipboard hang:** `baglam handoff --copy` no longer waits 60 seconds when `wl-copy` or `xclip` forks a background process holding stdout/stderr open.
- **Export / import fidelity and privacy:** `baglam import` now restores a task's full multi-line `request`, `requests` list and auto-only state; `baglam export` / `import` now preserves per-project `autoCapture: false` so automatic saving never silently turns back on after restoring a backup.
- **Panel history i18n:** added missing `history.imported` translations (`imported` / `içe aktardı`) and removed the unsafe type cast in `Records.tsx`.
- **Handoff brief priority:** raised `Since then (git)` priority above `Notes`, `Files` and `Done` so real uncommitted changes survive tight size budgets.
- **Cross-platform `claude` setup & `doctor` checks:** `baglam setup` backs up `~/.claude.json` before modifying it and updates Claude Code when the Node binary path changes (e.g. nvm/Homebrew upgrades); `baglam doctor` now checks every expected agent instruction file and flags stale Node binary paths.
- **Website & docs:** removed the unimplemented "replace" claim from the panel page, added Vercel security headers and Twitter Card metadata, dropped unused `site/panel.jpg`, and corrected step 10 in the Turkish Mac test checklist.

## [1.0.0-rc.5] - 2026-11-21

Fixes from an outside code review. Schema v8 (automatic backup and upgrade; the search index is rebuilt once).

### Fixed
- **Turkish İ and ı:** search finds "ışık" from "Işık", "IŞIK" or "isik", and "İmza" from "imza"; look-alike checks no longer split "İmza" into "i" + "mza".
- Deleting a project also deletes its tasks in progress, their history and its settings, so no nameless task card is left in the inbox.
- A long task no longer loses its blockers, next steps, other branches or the closing instruction in the brief: when everything does not fit, the least important parts give way instead of the end being cut.
- `baglam handoff --copy` keeps Turkish letters and arrows on Windows (PowerShell instead of `clip`), and works on Linux with Wayland (`wl-copy`) or `xsel` as well as `xclip`.
- A detailed (multi-line) request is kept in full even when it is not the first message of the task; the latest detailed request wins, and a new task started right after it takes it along.
- `baglam setup --undo` also removes Bağlam from the old Antigravity file (`~/.gemini/antigravity/mcp_config.json`).

## [1.0.0-rc.4] - 2026-11-20

Fixes from reviews and from a real run of Antigravity → Codex → Cursor → Antigravity on one project. **Re-run `baglam setup` after upgrading**; it keeps your own settings, and `baglam doctor` tells you when it is needed.

### Fixed
- A tool hook meeting a locked database now gives up within about a second (and logs it) instead of holding the tool for five seconds or more; the save itself is tried first.
- `baglam setup` and `--undo` no longer take another tool's `hook.js` called with the same arguments for Bağlam's own: an existing `hook.js` counts as ours only when its package is `baglam`.
- When a request after 12 idle hours starts a new task in the same session, file edits no longer silence the checkpoint reminder, and the reminder says the task has not been checkpointed yet.
- On macOS and Linux, automatic-saving hooks now always start Node by its full path, so apps opened from the Dock or a desktop launcher (Cursor, VS Code), which do not get the terminal's PATH, still save. Re-run `baglam setup` after upgrading (`baglam doctor` says so).
- **Antigravity 2:** `baglam setup` now registers Bağlam in `~/.gemini/config/mcp_config.json`, the only MCP file the current Antigravity reads (its agents never saw Bağlam's tools before, while `baglam doctor` said it was connected), and automatic saving records the files its agents create and edit (`write_file`, `edit_file`). Re-run `baglam setup` after upgrading.
- `baglam setup` keeps the tool approvals Codex saves inside Bağlam's block when you pick "Always allow", so Codex no longer asks again after an upgrade.
- The request that starts a task is kept in full (up to 2,000 characters, secrets hidden) and the brief shows it, so a plan in it reaches the next agent even when the notes it left are vague.
- The same words sent again after a minute (for example "devam et" first in Codex, then in Cursor) count as a new request; only a repeat within a minute is treated as one message sent twice.
- Cursor also runs Claude Code's hooks; those copies are now ignored, so Cursor's work is no longer saved under Claude Code's name.
- `baglam doctor` flags a tool where Bağlam was added by hand without `BAGLAM_AGENT` (it runs as an unverified agent under the tool's own name) and points to `baglam setup`.

## [1.0.0-rc.3] - 2026-11-18

### Added
- **Automatic saving.** `baglam setup` installs hooks in Claude Code, Codex CLI, Gemini CLI, Cursor, Antigravity and VS Code that save the user's request, every file the agent edits and the agent's last reply into the task in progress, even when the agent never checkpoints. A request joins the task in progress (so "continue" to the next agent picks it up), or starts one when there is none, the last one is done, or it was untouched for 12 hours. Automatic saving never marks a task done or changes its next steps, keeps the agent's own "now", hides secrets and only works in folders set up with `baglam init`.
- `baglam capture on|off|status`, a switch in the panel's Settings, and `BAGLAM_AUTO_CAPTURE=0`.
- The brief, `baglam handoff` and the panel card show the latest request ("Asked") and mark tasks only the tool saved.
- `baglam doctor` checks each tool's hooks and shows when it last saved automatically (and reminds Codex users to trust the hooks once with `/hooks`).

- **New website** (site/): ten pages (including a Panel tour), dark only, a scrolling strip of the supported tools, a new mark (two rings and the context they share), a floating navigation with a Product menu; in English and Turkish in a new dark design language, built with Astro; self-hosted fonts, nothing loaded from other hosts.

### Changed
- The panel uses the same design language: dark by default (light follows the system), Inter and JetBrains Mono bundled, Linear-style cards and pill buttons.
- Schema v7 (automatic backup and upgrade).
- The stale-checkpoint reminder counts from the agent's own last checkpoint, so automatic saves never silence it.
- An agent's `new_task` right after a request only the tool saved names that task instead of replacing it, and a real new task keeps the request that started it.
- Agent instructions ask for checkpoints in the user's language; re-run `baglam init` after upgrading.
- Search matches word beginnings, so "imza" finds "imzasını" and "deploy" finds "deployment" (agents and panel).
- `baglam init` repairing a broken `.baglam/project.json` keeps the folder's id, so its records stay with it.
- `baglam projects` shows names and folders; `baglam add` stops at a near-duplicate and explains `--replaces` / `--force`.
- The task card and brief no longer repeat the request when it is the task's title; Bağlam's own `.baglam/` folder is not listed as changed work.

## [1.0.0-rc.2] - 2026-11-18

### Added
- **Handoff between agents.** `context_checkpoint` saves the task in progress (goal, done, now, next, files, blockers, notes) per project and branch; `context_brief` opens with "Continue from here", including the files git shows changed since, so a task survives an agent stopping abruptly. `context_handoff` gives the details; prompt `baglam_resume`.
- `baglam handoff` (`--history`, `--copy` for a resume prompt usable in any AI tool, `clear`).
- **Autonomous mode** per project: `baglam auto on|off|status`; records from set-up agents are shared at once and reviewed afterwards with `baglam review`, `keep` and `undo` (undoing a replacement restores the original).
- Panel: "Continue from here" cards, "Shared automatically" review list, autonomous switch, task line and badge on Projects.
- Export/import include tasks in progress; an import never turns autonomous mode on by itself.
- `baglam doctor` reports outdated agent instructions and servers missing the new tools.

- **Checkpoint nudges.** Every `context_checkpoint` reply for a task in progress asks for the next checkpoint, and an agent whose own task has not been checkpointed for 5 minutes is reminded on its next tool call (only the session that is working on it; never for blocked or finished tasks). Marking a task done tells the agent to checkpoint a new goal before working on the user's next request, and the agent instructions say a follow-up request in the same conversation is a new task.
- `baglam init` suggests `git init` when the folder is not inside a git repository.

### Changed
- Agent instructions written by `baglam init` teach checkpointing; re-run `baglam init` after upgrading.
- A git repository without commits now keys tasks by its branch name (for example `main`) instead of `-`, so the key no longer changes at the first commit.
- Schema v6 (automatic backup and upgrade).

## [1.0.0-rc.1] - 2026-11-17

First release candidate.

### Added
- **Shared, human-approved memory over MCP.** Agents read approved records with `context_brief` / `context_search` / `context_get` and propose new ones with `context_propose`. Nothing an agent writes reaches other agents until you approve it.
- **One-command setup.** `baglam setup` connects Claude Code, Codex CLI, Antigravity, Gemini CLI, Cursor, Windsurf and VS Code, backing up every file it changes; `--undo` reverts it.
- **Project init.** `baglam init` gives a folder a stable id, moves older path-keyed records to it and writes instructions to `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and Cursor rules.
- **Automatic project detection** from the agent's `project_path`, MCP roots, `BAGLAM_PROJECT` or the working folder; never writes to a guessed or unsafe folder.
- **Review panel.** `baglam ui` opens a local web panel (Turkish/English, light/dark, phone layout): inbox with keyboard shortcuts, records with history, projects, trust rules, connected tools, live updates.
- **Guards.** Secrets (API keys, tokens, private keys, passwords in URLs, high-entropy strings) are blocked; look-alike records are flagged; each agent can have at most 20 proposals waiting.
- **Trust rules (opt-in).** Let chosen agents or kinds skip review; never for replacements, look-alikes or anything you rejected before.
- **Diagnostics.** `baglam doctor` checks Node, the database, every tool's registration and a live handshake, and the current folder, with a fix for each problem.
- **Export / import.** `baglam export --format md|json`, `baglam import <file.json>`.
- **Audit trail** for every change; versioned database migrations with automatic backups.

### Performance
- Brief, search and duplicate checks stay under 50 ms with 10,000+ records.
