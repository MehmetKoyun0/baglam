# Connecting each tool

`baglam setup` does all of this for you. This page is for checking what it did, or connecting a tool by hand.

Every tool gets the same server entry: the absolute path of Node, the absolute path of Bağlam's `dist/cli.js`, the argument `mcp`, and `BAGLAM_AGENT` set to the tool's id. Absolute paths matter because desktop apps often start without your shell's `PATH`.

Find the two paths:

```bash
node -p "process.execPath"
npm root -g          # Bağlam is in <this>/baglam/dist/cli.js
```

Below, `NODE` and `CLI` stand for those two paths.

| Tool | Agent id | Config file | How setup writes it |
|---|---|---|---|
| Claude Code | `claude-code` | `~/.claude.json` | `claude mcp add baglam -s user -e BAGLAM_AGENT=claude-code -- NODE CLI mcp` |
| Codex CLI | `codex` | `~/.codex/config.toml` | fenced TOML block (below) |
| Antigravity | `antigravity` | `~/.gemini/config/mcp_config.json` (Antigravity 2); older versions `~/.gemini/antigravity/mcp_config.json` | `mcpServers.baglam` |
| Gemini CLI | `gemini-cli` | `~/.gemini/settings.json` | `mcpServers.baglam` |
| Cursor | `cursor` | `~/.cursor/mcp.json` | `mcpServers.baglam` |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.baglam` |
| VS Code | `vscode` | user `mcp.json` (Windows `%APPDATA%\Code\User\mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Linux `~/.config/Code/User/mcp.json`) | `servers.baglam` with `"type": "stdio"` |

## JSON tools (Antigravity, Gemini CLI, Cursor, Windsurf)

```json
{
  "mcpServers": {
    "baglam": {
      "command": "NODE",
      "args": ["CLI", "mcp"],
      "env": { "BAGLAM_AGENT": "cursor" }
    }
  }
}
```

Use the tool's own agent id from the table. VS Code uses `"servers"` instead of `"mcpServers"` and adds `"type": "stdio"`.

Setup keeps every other server and setting in the file. If the file is not plain JSON (for example it has comments), setup leaves it untouched and tells you; add the entry by hand.

## Codex CLI

```toml
# baglam:start
[mcp_servers.baglam]
command = "NODE"
args = ["CLI", "mcp"]
env = { BAGLAM_AGENT = "codex" }
# baglam:end
```

On Windows, write backslashes doubled (`"C:\\Program Files\\nodejs\\node.exe"`). If your file already defines `mcp_servers` in another layout, setup will not touch it; merge the entry by hand.

## Instructions for agents

`baglam init` adds this block to `CLAUDE.md`, `AGENTS.md` (read by Codex, Cursor and most other agents), `GEMINI.md` (Gemini CLI, Antigravity), `.cursor/rules/baglam.mdc`, `.github/copilot-instructions.md` and `.windsurf/rules/baglam.md` according to the installed tools. You can also paste it into any rules file your tool reads:

```markdown
## Shared project context (Bağlam)
This project uses Bağlam to share decisions between AI agents.
- At the start of every task, call the `context_brief` tool with `project_path` set to the absolute path of this project folder, and follow what it returns.
- When you settle a decision, learn a convention or a user preference, or hit a pitfall other agents should know about, call `context_propose` (same `project_path`). Use `supersedes` when it replaces an existing record.
- Never put secrets, credentials or personal data in a proposal.

### Save progress so another agent can continue
- When you start or pick up a task, call `context_checkpoint` with the `goal` before you change anything. Every follow-up request in the same conversation ("now add X") is a new task too: checkpoint its goal first. After every meaningful step (a file finished, a test passing, a decision made) call it again with `done_add`, `now` and `next`. Do this before long operations too: you may be stopped at any moment, and another agent will continue from your last checkpoint.
- If `context_brief` shows a task under "Continue from here" and the user's request is about it, continue from its next steps instead of starting over, and keep checkpointing it (do not pass `new_task`). Pass `new_task: true` only when you start something unrelated.
- When the task is finished, call `context_checkpoint` with `status: "done"`.
- Write checkpoints (goal, done, now, next) in the language the user writes in, so the user can read them in the panel.
```

After upgrading Bağlam, run `baglam init` again in each project to refresh this block; `baglam doctor` tells you when it is outdated.

## Automatic saving & context injection hooks

`baglam setup` also adds hooks that run `node <install>/dist/hook.js <tool> <start|prompt|edit|stop>`. Your own hooks in the same files are kept; `setup --undo` removes only Bağlam's.

| Tool | File | Events |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | SessionStart, UserPromptSubmit, PostToolUse (Write/Edit/MultiEdit/NotebookEdit), Stop |
| Codex CLI | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, PostToolUse (apply_patch/Edit/Write), Stop; trust them once with `/hooks` |
| Gemini CLI | `~/.gemini/settings.json` | SessionStart, BeforeAgent, AfterTool (write_file/replace), AfterAgent |
| Cursor | `~/.cursor/hooks.json` | sessionStart, beforeSubmitPrompt, afterFileEdit, afterAgentResponse |
| Antigravity | `~/.gemini/config/hooks.json` (entry `baglam`) | PreInvocation, PostToolUse (file tools: `write_file`, `edit_file`, `create_file` with `Path`; older `write_to_file`, `replace_file_content` with `TargetFile`) |
| VS Code | `~/.copilot/hooks/baglam.json` | sessionStart, userPromptSubmitted, postToolUse, agentStop |

At session start (and when control switches from another agent on a prompt), hooks inject the live task in progress and approved project memory using each tool's structured context output. A hook never blocks the tool: it always exits 0 within 3 s and does nothing in folders without `.baglam/project.json`. Problems are written to `~/.baglam/hook-errors.log`. Turn saving off per project with `baglam capture off` or everywhere with `BAGLAM_AUTO_CAPTURE=0`; turn context injection off with `BAGLAM_HOOK_INJECT=0`.

## Undo

```bash
baglam setup --undo     # removes Bağlam from every tool
baglam init --undo      # removes the instruction blocks from this project (keeps its id)
```

The first backup of every changed file stays next to it as `*.baglam-backup`.
