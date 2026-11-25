import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testHost } from "./helpers.js";
import { HOOK_INSTALLERS, hookCommand } from "../src/clients/hooks.js";
import type { HookClient } from "../src/hooks/normalize.js";

const read = (f: string) => JSON.parse(readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
const put = (f: string, data: unknown) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(data, null, 2));
};
const cmd = (client: string, event: string) => `"C:/node/node.exe" "C:/baglam/dist/hook.js" ${client} ${event}`;

describe("hookCommand: one form every shell runs", () => {
  it("Windows: uses a bare `node` when PATH finds this same Node, so PowerShell, cmd and bash all run it", () => {
    const where = () => ({ code: 0, stdout: "C:\\Program Files\\nodejs\\node.exe\r\nC:\\other\\node.exe\r\n" });
    const h = { ...testHost({ commands: { where, which: where } }), platform: "win32" as const, nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\ev\\BAĞLAM\\dist\\cli.js" };
    expect(hookCommand(h, "codex", "prompt", "posix")).toBe('node "C:/Users/ev/BAĞLAM/dist/hook.js" codex prompt');
    expect(hookCommand(h, "cursor", "prompt", "powershell")).toBe('node "C:/Users/ev/BAĞLAM/dist/hook.js" cursor prompt');
  });

  it("keeps the absolute path when PATH finds another Node or none", () => {
    const where = () => ({ code: 0, stdout: "C:\\other\\node.exe\r\n" });
    const h = { ...testHost({ commands: { where, which: where } }), nodePath: "C:\\Program Files\\nodejs\\node.exe" };
    expect(hookCommand(h, "codex", "prompt", "posix").startsWith('"C:/Program Files/nodejs/node.exe" ')).toBe(true);
  });

  it.each(["darwin", "linux"] as const)(
    "%s: always the absolute Node path (apps opened from the Dock or a launcher do not get the shell's PATH)",
    (platform) => {
      const which = () => ({ code: 0, stdout: "/Users/me/.nvm/versions/node/v24.1.0/bin/node\n" });
      const h = {
        ...testHost({ commands: { which } }),
        platform,
        nodePath: "/Users/me/.nvm/versions/node/v24.1.0/bin/node",
        cliPath: "/Users/me/.npm-global/lib/node_modules/baglam/dist/cli.js",
      };
      expect(hookCommand(h, "cursor", "edit", "posix")).toBe(
        '"/Users/me/.nvm/versions/node/v24.1.0/bin/node" "/Users/me/.npm-global/lib/node_modules/baglam/dist/hook.js" cursor edit',
      );
    },
  );
});

describe("hookCommand", () => {
  it("quotes expansion characters and apostrophes as literal path data", () => {
    const h = { ...testHost(), platform: "linux" as const, nodePath: "/bin/node", cliPath: "/opt/$team's copy/cli.js" };
    expect(hookCommand(h, "codex", "edit", "posix")).toContain("'/opt/$team'\\''s copy/hook.js'");
    expect(hookCommand(h, "codex", "edit", "powershell")).toContain("'/opt/$team''s copy/hook.js'");
  });

  it("quotes absolute forward-slash paths; PowerShell gets the call operator", () => {
    const h = { ...testHost(), nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\ev\\BAĞLAM\\dist\\cli.js" };
    expect(hookCommand(h, "claude-code", "prompt", "posix")).toBe('"C:/Program Files/nodejs/node.exe" "C:/Users/ev/BAĞLAM/dist/hook.js" claude-code prompt');
    expect(hookCommand(h, "cursor", "edit", "powershell")).toBe('& "C:/Program Files/nodejs/node.exe" "C:/Users/ev/BAĞLAM/dist/hook.js" cursor edit');
  });
});

describe("what each tool's hook file looks like", () => {
  it("Claude Code: settings.json hooks for session start, prompt, file edits and stop", () => {
    const h = testHost();
    HOOK_INSTALLERS["claude-code"].install(h);
    const s = read(join(h.home, ".claude", "settings.json"));
    expect(s.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: cmd("claude-code", "start"), timeout: 10 }] }]);
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: cmd("claude-code", "prompt"), timeout: 10 }] }]);
    expect(s.hooks.PostToolUse).toEqual([{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: cmd("claude-code", "edit"), timeout: 10 }] }]);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(cmd("claude-code", "stop"));
  });

  it("Codex: hooks.json with a Windows command too", () => {
    const h = testHost();
    HOOK_INSTALLERS.codex.install(h);
    const s = read(join(h.home, ".codex", "hooks.json"));
    expect(Object.keys(s.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
    expect(s.hooks.PostToolUse[0].matcher).toBe("apply_patch|Edit|Write");
    const handler = s.hooks.UserPromptSubmit[0].hooks[0];
    expect(handler.command).toBe(cmd("codex", "prompt"));
    expect(typeof handler.commandWindows).toBe("string");
    expect(handler.commandWindows).toContain('hook.js" codex prompt');
  });

  it("Gemini CLI: named hooks in settings.json", () => {
    const h = testHost();
    HOOK_INSTALLERS["gemini-cli"].install(h);
    const s = read(join(h.home, ".gemini", "settings.json"));
    expect(Object.keys(s.hooks)).toEqual(["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"]);
    expect(s.hooks.AfterTool[0]).toEqual({
      matcher: "write_file|replace",
      hooks: [{ name: "baglam-edit", type: "command", command: cmd("gemini-cli", "edit"), timeout: 10000 }],
    });
  });

  it("Cursor: version 1 hooks.json, commands through PowerShell on Windows", () => {
    const h = testHost();
    HOOK_INSTALLERS.cursor.install(h);
    const s = read(join(h.home, ".cursor", "hooks.json"));
    expect(s.version).toBe(1);
    expect(Object.keys(s.hooks)).toEqual(["sessionStart", "beforeSubmitPrompt", "afterFileEdit", "afterAgentResponse"]);
    const c = s.hooks.beforeSubmitPrompt[0];
    expect(c.timeout).toBe(10);
    expect(c.command).toBe(process.platform === "win32" ? `& ${cmd("cursor", "prompt")}` : cmd("cursor", "prompt"));
  });

  it("Antigravity: our own named entry in ~/.gemini/config/hooks.json", () => {
    const h = testHost();
    HOOK_INSTALLERS.antigravity.install(h);
    const s = read(join(h.home, ".gemini", "config", "hooks.json"));
    expect(Object.keys(s)).toEqual(["baglam"]);
    expect(s.baglam.PreInvocation[0].command).toBe(cmd("antigravity", "prompt"));
    // Antigravity 2 names (write_file, edit_file, create_file) and the older ones.
    expect(s.baglam.PostToolUse[0].matcher).toBe(
      "write_file|edit_file|create_file|write_to_file|replace_file_content|multi_replace_file_content",
    );
  });

  it("VS Code: ~/.copilot/hooks/baglam.json", () => {
    const h = testHost();
    HOOK_INSTALLERS.vscode.install(h);
    const s = read(join(h.home, ".copilot", "hooks", "baglam.json"));
    expect(s.version).toBe(1);
    expect(Object.keys(s.hooks)).toEqual(["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"]);
    expect(s.hooks.postToolUse[0]).toEqual({ type: "command", command: cmd("vscode", "edit"), timeoutSec: 10 });
  });
});

describe("living with the user's own hooks", () => {
  const clients = Object.keys(HOOK_INSTALLERS) as HookClient[];

  it.each(clients)("%s: install twice is unchanged", (c) => {
    const h = testHost();
    expect(HOOK_INSTALLERS[c].install(h).action).toBe("added");
    expect(HOOK_INSTALLERS[c].install(h).action).toBe("unchanged");
    expect(HOOK_INSTALLERS[c].status(h).installed).toBe(true);
  });

  it.each(clients)("%s: undo removes only Bağlam and reports absent afterwards", (c) => {
    const h = testHost();
    HOOK_INSTALLERS[c].install(h);
    expect(HOOK_INSTALLERS[c].uninstall(h).action).toBe("removed");
    expect(HOOK_INSTALLERS[c].status(h).installed).toBe(false);
    expect(HOOK_INSTALLERS[c].uninstall(h).action).toBe("absent");
  });

  it("Claude Code keeps the user's own hooks, other settings and our updated path", () => {
    const h = testHost();
    const f = join(h.home, ".claude", "settings.json");
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    put(f, { model: "opus", hooks: { PostToolUse: [mine], SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } });
    HOOK_INSTALLERS["claude-code"].install(h);
    // A new install location replaces our old entries instead of adding a second set.
    HOOK_INSTALLERS["claude-code"].install({ ...h, cliPath: "D:/new/dist/cli.js" });
    const s = read(f);
    expect(s.model).toBe("opus");
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.PostToolUse[0]).toEqual(mine);
    expect(s.hooks.PostToolUse[1].hooks[0].command).toContain('D:/new/dist/hook.js" claude-code edit');
    HOOK_INSTALLERS["claude-code"].uninstall(h);
    expect(read(f)).toEqual({ model: "opus", hooks: { PostToolUse: [mine], SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } });
  });

  it("a group mixing the user's hook with ours keeps the user's hook on undo", () => {
    const h = testHost();
    const f = join(h.home, ".claude", "settings.json");
    put(f, { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }, { type: "command", command: cmd("claude-code", "stop") }] }] } });
    HOOK_INSTALLERS["claude-code"].uninstall(h);
    expect(read(f)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } });
  });

  it("Claude and Gemini settings files are never deleted; our own hook files are", () => {
    const h = testHost();
    for (const c of clients) HOOK_INSTALLERS[c].install(h);
    for (const c of clients) HOOK_INSTALLERS[c].uninstall(h);
    expect(read(join(h.home, ".claude", "settings.json"))).toEqual({});
    expect(read(join(h.home, ".gemini", "settings.json"))).toEqual({});
    expect(existsSync(join(h.home, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(h.home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(h.home, ".copilot", "hooks", "baglam.json"))).toBe(false);
    expect(existsSync(join(h.home, ".gemini", "config", "hooks.json"))).toBe(false);
  });

  it("Cursor keeps the user's hooks when ours are removed", () => {
    const h = testHost();
    const f = join(h.home, ".cursor", "hooks.json");
    put(f, { version: 1, hooks: { afterFileEdit: [{ command: "./hooks/format.sh" }] } });
    HOOK_INSTALLERS.cursor.install(h);
    expect(read(f).hooks.afterFileEdit).toHaveLength(2);
    HOOK_INSTALLERS.cursor.uninstall(h);
    expect(read(f)).toEqual({ version: 1, hooks: { afterFileEdit: [{ command: "./hooks/format.sh" }] } });
  });

  it("invalid JSON is left untouched and reported", () => {
    const h = testHost();
    const f = join(h.home, ".cursor", "hooks.json");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "{ broken");
    const r = HOOK_INSTALLERS.cursor.install(h);
    expect(r.action).toBe("skipped");
    expect(r.note).toMatch(/not valid JSON/);
    expect(readFileSync(f, "utf8")).toBe("{ broken");
    expect(HOOK_INSTALLERS.cursor.status(h).problem).toMatch(/not valid JSON/);
  });

  it("a BOM and CRLF file stays readable and keeps its BOM; a backup is made once", () => {
    const h = testHost();
    const f = join(h.home, ".gemini", "settings.json");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '\uFEFF{\r\n  "theme": "dark"\r\n}\r\n');
    HOOK_INSTALLERS["gemini-cli"].install(h);
    const raw = readFileSync(f, "utf8");
    expect(raw.startsWith("\uFEFF")).toBe(true);
    expect(read(f).theme).toBe("dark");
    expect(existsSync(`${f}.baglam-backup`)).toBe(true);
  });

  it("dry run writes nothing", () => {
    const h = testHost();
    expect(HOOK_INSTALLERS.codex.install(h, { dryRun: true }).action).toBe("added");
    expect(existsSync(join(h.home, ".codex", "hooks.json"))).toBe(false);
  });
});

describe("installed hooks are recognised whatever order the tool keeps", () => {
  it("a user's hook added after ours, and a key after hooks, still count as installed and are not rewritten", () => {
    const h = testHost();
    const f = join(h.home, ".claude", "settings.json");
    HOOK_INSTALLERS["claude-code"].install(h);
    const s = read(f);
    s.hooks.Stop.push({ hooks: [{ type: "command", command: "echo later" }] });
    s.permissions = { allow: ["Bash(ls)"] };
    put(f, s);
    const before = readFileSync(f, "utf8");
    expect(HOOK_INSTALLERS["claude-code"].status(h).installed).toBe(true);
    expect(HOOK_INSTALLERS["claude-code"].install(h).action).toBe("unchanged");
    expect(readFileSync(f, "utf8")).toBe(before);
  });

  it("an old Bağlam hook left behind means not installed, and install replaces it", () => {
    const h = testHost();
    const f = join(h.home, ".cursor", "hooks.json");
    HOOK_INSTALLERS.cursor.install(h);
    const s = read(f);
    s.hooks.afterFileEdit.push({ command: '"C:/old/node.exe" "C:/old/dist/hook.js" cursor edit' });
    put(f, s);
    expect(HOOK_INSTALLERS.cursor.status(h).installed).toBe(false);
    expect(HOOK_INSTALLERS.cursor.install(h).action).toBe("updated");
    expect(read(f).hooks.afterFileEdit).toHaveLength(1);
  });

  it("another tool's hook.js with the same arguments is never taken for ours", () => {
    const h = testHost();
    const other = mkdtempSync(join(tmpdir(), "other-tool-"));
    put(join(other, "package.json"), { name: "other-tool" });
    put(join(other, "dist", "hook.js"), {});
    const theirs = { hooks: [{ type: "command", command: `node "${other.replace(/\\/g, "/")}/dist/hook.js" claude-code stop` }] };
    const f = join(h.home, ".claude", "settings.json");
    put(f, { hooks: { Stop: [theirs] } });
    expect(HOOK_INSTALLERS["claude-code"].install(h).action).toBe("updated");
    expect(read(f).hooks.Stop).toHaveLength(2);
    expect(read(f).hooks.Stop[0]).toEqual(theirs);
    expect(HOOK_INSTALLERS["claude-code"].status(h).installed).toBe(true);
    HOOK_INSTALLERS["claude-code"].uninstall(h);
    expect(read(f)).toEqual({ hooks: { Stop: [theirs] } });
  });

  it("an existing Bağlam install elsewhere (package name baglam) is still ours and gets replaced", () => {
    const h = testHost();
    const old = mkdtempSync(join(tmpdir(), "old-baglam-"));
    put(join(old, "package.json"), { name: "baglam" });
    put(join(old, "dist", "hook.js"), {});
    const f = join(h.home, ".cursor", "hooks.json");
    put(f, { version: 1, hooks: { afterFileEdit: [{ command: `node "${old.replace(/\\/g, "/")}/dist/hook.js" cursor edit` }] } });
    expect(HOOK_INSTALLERS.cursor.status(h).installed).toBe(false);
    HOOK_INSTALLERS.cursor.install(h);
    expect(read(f).hooks.afterFileEdit).toHaveLength(1);
    expect(read(f).hooks.afterFileEdit[0].command).toContain("C:/baglam/dist/hook.js");
  });

  it("keys the tool reorders inside our own entry still match", () => {
    const h = testHost();
    const f = join(h.home, ".gemini", "settings.json");
    HOOK_INSTALLERS["gemini-cli"].install(h);
    const s = read(f);
    const handler = s.hooks.AfterTool[0].hooks[0];
    s.hooks.AfterTool[0] = { hooks: [{ timeout: handler.timeout, command: handler.command, type: handler.type, name: handler.name }], matcher: "write_file|replace" };
    put(f, s);
    expect(HOOK_INSTALLERS["gemini-cli"].status(h).installed).toBe(true);
  });
});
