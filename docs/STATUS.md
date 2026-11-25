# Bağlam: where the project stands

> **Türkçe özet:** Bağlam, yapay zekâ kod ajanlarına (Claude Code, Codex, Cursor, Gemini, Antigravity,
> VS Code · Copilot, Windsurf) ortak ve insan onaylı bir hafıza ile ajanlar arası devir veren yerel bir
> MCP sunucusu, CLI ve paneldir. 1.0.1 npm'de yayında. 1.0.2 için güvenlik ve panel düzeltmeleri hazırlandı.
> [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) dosyasına bak.

Last updated: 2026-11-24. Read this first when you pick up work on the product (MCP server, CLI, hooks,
panel logic). Design and website work lives in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## Working with the owner

- The owner is not a developer, writes Turkish and wants explanations in plain Turkish. Code, commits
  and docs stay in English.
- Aim: world-class, professional quality. Prefer finishing and verifying over adding scope.
- The owner does every sign-in, password, token and one-time code. Ask before publishing to npm,
  creating accounts or anything outward-facing; pushing `main` deploys the website (see below).
- No fabricated social proof (no fake users, stars or quotes).

## What exists (1.0.x)

| Part | Where | What it does |
|---|---|---|
| MCP server | `src/server.ts` | `context_brief`, `context_search`, `context_get`, `context_propose`, `context_checkpoint`, `context_handoff`; prompt `baglam_resume`; connection-scoped checkpoint nudges (5 min) |
| Store | `src/store.ts`, `src/migrate.ts` | `node:sqlite` (WAL), schema **v8**, FTS5 prefix search (Turkish İ/ı folded to i in index and queries), automatic backup on upgrade |
| Handoff | `src/handoff.ts` | per project + branch task: goal, done, now, next, files, blockers, notes, latest request; `checkpointPlanned` under `BEGIN IMMEDIATE` |
| Automatic saving | `src/hook.ts`, `src/capture.ts`, `src/hooks/normalize.ts`, `src/clients/hooks.ts` | tool hooks save request, edited files and last reply even when the agent forgets; always exits 0, ≤1 MB stdin, 3 s deadline, secrets hidden, only in `baglam init` folders |
| CLI | `src/cli.ts` | `setup`, `init`, `doctor`, `add`, `list`, `show`, `pending`, `approve`, `reject`, `review`, `keep`, `undo`, `trust`, `auto`, `capture`, `handoff`, `projects`, `export`, `import`, `ui` (opens the panel) |
| Panel | `ui/` (Preact 11 + Vite 8) | Inbox, Records, Projects, Settings; "Continue from here" cards; autonomous and auto-save switches |
| Website | `site/` (Astro 7) | 11 pages × EN/TR, see DESIGN-SYSTEM.md |

Hook installers: Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json` (user trusts once via
`/hooks`), Gemini `~/.gemini/settings.json`, Cursor `~/.cursor/hooks.json`, Antigravity
`~/.gemini/config/hooks.json`, VS Code `~/.copilot/hooks/baglam.json`.

Verified with real tools: Antigravity 2, Codex CLI (v0.167.0, including live `SessionStart` context
injection with zero instruction files and zero MCP calls), Cursor (including live confirmation that
Cursor's copies of Claude Code hooks are ignored), Claude Code (hooks fired cleanly; model reply awaits
weekly quota reset 2026-11-24), and live `baglam ui` browser audit (2026-11-21; full details in
[audit-2026-11-21.md](audit-2026-11-21.md)). The npm package installs and runs cleanly from the registry.
Not yet verified with the real tool: macOS desktop apps (friend's test), Linux desktop clipboard,
Gemini CLI (account tier blocked), VS Code Copilot, and Windsurf live hooks.

## Commands

```
npm run build        # tsc + panel bundle into dist/ (dist/ is the live local install)
npm test             # vitest; compiles into .test-dist and never rebuilds dist/
npm run typecheck
npm run smoke        # packs the package and runs the packaged hook
cd site && npm run build   # Astro build + site checks (links, EN/TR parity, no third-party hosts)
```

## Release and hosting

- npm: the published stable release is `1.0.1`. Stable releases use the default `latest` tag.
  Use an explicit `--tag next` for prereleases. Verify with `npm view baglam dist-tags` and a clean installation of `baglam@latest`.
- GitHub: `Mehmet274634/baglam`, branch `main`. Remote URL carries the user name
  (`https://Mehmet274634@github.com/...`) because a cached credential belongs to another account.
- CI (`.github/workflows/ci.yml`): macOS, Linux, Windows × Node 22/24 plus a site job; the perf step
  is skipped on Windows. Anonymous GitHub API is rate-limited; read the Actions page in a browser.
- Website: Vercel project imported from GitHub, root directory `site`; **every push to `main`
  deploys**. Free `*.vercel.app` address; some Turkish ISPs block it (SSL error), so a custom domain
  may be needed later.

## Next steps (in order)

0. **1.0.0-rc.6 is published & live-audited** (2026-11-21, see [audit-2026-11-21.md](audit-2026-11-21.md)):
   automatic context injection via `SessionStart`/`sessionStart` and cross-agent prompt hooks, Linux
   clipboard hang fix, partial secret redaction + expanded secret patterns, `init` for Copilot/Windsurf +
   `--local` + `--name`, `doctor` full instruction scan + stale Node detection, panel hook health + full
   request + checkpoint history, website security headers. Post-audit polish landed on `main` (`d22a016`,
   `[Unreleased]` for `1.0.0`): cached `/api/overview` tool probes (<5 ms badge updates), parallel
   `baglam doctor` handshakes (7.35 s → 3.17 s on 6 tools), and other active branches shown in
   `baglam handoff` CLI.
1. **Mac test** with the owner's friend: `npm i -g baglam`, `baglam setup`, `baglam init`, a Claude
   Code → Codex/Cursor handoff, `baglam doctor`. Fix whatever the Mac run shows. Turkish step-by-step
   list for the tester: [mac-test-checklist.tr.md](mac-test-checklist.tr.md). Watch for: apps opened
   from the Dock (Cursor, VS Code) get launchd's PATH; rc.4+ starts hooks with the absolute Node path
   off Windows, and step 9b checks it. The tester should install rc.6 or newer.
2. **Post-1.0.0 roadmap (core first, custom domain deferred until product matures):**
   - `1.0.x` panel completeness: `+ Add record`, `Supersede/Replace`, panel export/import, tag/audience editing.
   - `1.1` smart memory: folder/path-scoped records (`paths`), `propose_retire`, `baglam handoff move <branch>`, Turkish token calibration.
   - `1.2` multi-machine & zero-server team sync: `.baglam/shared.json` (`baglam sync`), `baglam status`, Turkish CLI (`BAGLAM_LANG=tr`).
   - Later: custom domain + `og:image` + `sitemap.xml` + `robots.txt`, 30 s demo video, Homebrew/winget.

## In 1.0.0-rc.4 (see CHANGELOG)

The real three-agent test (2026-11-19, `Desktop\tip-kartlari`, Antigravity → Codex → Cursor stopped
mid-edit → fresh Cursor chat → Antigravity) found six problems, all fixed with tests: Antigravity 2's
MCP file and file-tool names, Codex approvals kept by setup, the task's first request kept in full,
repeated requests from another tool, Cursor's copies of Claude Code hooks. The four deferred review
minors are fixed too: the hook's busy wait is capped at
`HOOK_BUSY_MS` (700 ms per write; SQLite waits block the deadline timer), `isOurs` checks that an
existing `hook.js` belongs to the `baglam` package, reminders count from the agent's own checkpoint
or the task's start (never `updatedAt`, which hooks refresh), and `baglam doctor` flags hand-made
entries without `BAGLAM_AGENT`.

## History

Plans and specs for each milestone are in `docs/superpowers/` (m1 foundation → m5 release,
handoff + autonomous, auto-capture, site and panel). `CHANGELOG.md` lists every user-visible change.
The original design and threat model is `docs/design.md`.
