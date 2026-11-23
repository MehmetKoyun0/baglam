import { describe, it, expect } from "vitest";
import { chmodSync, statSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { testHost } from "./helpers.js";
import { serverEntry } from "../src/host.js";
import { antigravity, cursor, vscode } from "../src/clients/json.js";

const write = (file: string, data: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("JSON client adapters", () => {
  it("adds an entry and keeps other servers", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const change = cursor.install(host);
    expect(change).toMatchObject({ client: "cursor", action: "updated", file });
    const cfg = readJson(file);
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.baglam).toEqual(serverEntry(host, "cursor"));
  });

  it.skipIf(process.platform === "win32")("preserves POSIX permissions across install and uninstall", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    cursor.install(host);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (const mode of [0o600, 0o640]) {
      chmodSync(file, mode);
      cursor.uninstall(host);
      expect(statSync(file).mode & 0o777).toBe(mode);
      cursor.install(host);
      expect(statSync(file).mode & 0o777).toBe(mode);
    }
  });

  it("creates a missing config file", () => {
    const host = testHost();
    mkdirSync(join(host.home, ".cursor"));
    expect(cursor.install(host).action).toBe("added");
    expect(readJson(join(host.home, ".cursor", "mcp.json")).mcpServers.baglam.env).toEqual({ BAGLAM_AGENT: "cursor" });
  });

  it("replaces a pinned BAGLAM_PROJECT entry", () => {
    const host = testHost();
    const file = join(host.home, ".gemini", "antigravity", "mcp_config.json");
    write(file, JSON.stringify({ mcpServers: { baglam: { command: "node", args: ["old/mcp.js"], env: { BAGLAM_AGENT: "antigravity", BAGLAM_PROJECT: "C:/x" } } } }));
    expect(antigravity.install(host).action).toBe("updated");
    expect(readJson(file).mcpServers.baglam.env).toEqual({ BAGLAM_AGENT: "antigravity" });
  });

  it("Antigravity 2 (settings moved to ~/.gemini/config): registers in config/mcp_config.json, the file it reads", () => {
    const host = testHost();
    const old = join(host.home, ".gemini", "antigravity", "mcp_config.json");
    const now = join(host.home, ".gemini", "config", "mcp_config.json");
    write(old, JSON.stringify({ mcpServers: {} }));
    write(now, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(antigravity.status(host).registered).toBe(false);
    expect(antigravity.install(host)).toMatchObject({ action: "updated", file: now });
    expect(readJson(now).mcpServers).toEqual({ other: { command: "x" }, baglam: serverEntry(host, "antigravity") });
    expect(antigravity.status(host).registered).toBe(true);
  });

  it("Antigravity 2 with only the .migrated marker gets a new config/mcp_config.json", () => {
    const host = testHost();
    write(join(host.home, ".gemini", "config", ".migrated"), "");
    expect(antigravity.detect(host)).toBe(true);
    expect(antigravity.install(host)).toMatchObject({ action: "added", file: join(host.home, ".gemini", "config", "mcp_config.json") });
  });

  it("Antigravity undo also removes Bağlam from the old ~/.gemini/antigravity file, keeping other servers", () => {
    const host = testHost();
    const old = join(host.home, ".gemini", "antigravity", "mcp_config.json");
    const now = join(host.home, ".gemini", "config", "mcp_config.json");
    write(old, JSON.stringify({ mcpServers: { baglam: serverEntry(host, "antigravity"), other: { command: "x" } } }));
    write(now, JSON.stringify({ mcpServers: {} }));
    antigravity.install(host);
    expect(antigravity.uninstall(host).action).toBe("removed");
    expect(readJson(now).mcpServers).toEqual({});
    expect(readJson(old).mcpServers).toEqual({ other: { command: "x" } });
    expect(antigravity.uninstall(host).action).toBe("absent");
  });

  it("is idempotent", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: {} }));
    cursor.install(host);
    expect(cursor.install(host).action).toBe("unchanged");
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith(".baglam-backup"))).toEqual(["mcp.json.baglam-backup"]);
  });

  it("skips an unparsable config untouched", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    const original = '{ // my servers\n  "mcpServers": {},\n}\n';
    write(file, original);
    const change = cursor.install(host);
    expect(change.action).toBe("skipped");
    expect(change.note).toMatch(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(existsSync(file + ".baglam-backup")).toBe(false);
  });

  it("dry run reports without writing", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    write(file, "{}");
    expect(cursor.install(host, { dryRun: true }).action).toBe("updated");
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("vscode uses servers + type stdio", () => {
    const host = testHost();
    mkdirSync(join(host.appData, "Code", "User"), { recursive: true });
    expect(vscode.detect(host)).toBe(true);
    vscode.install(host);
    const cfg = readJson(join(host.appData, "Code", "User", "mcp.json"));
    expect(cfg.servers.baglam).toEqual({ type: "stdio", ...serverEntry(host, "vscode") });
    expect(cfg.mcpServers).toBeUndefined();
  });

  it("uninstall removes only baglam", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    write(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    cursor.install(host);
    expect(cursor.uninstall(host).action).toBe("removed");
    expect(readJson(file).mcpServers).toEqual({ other: { command: "x" } });
    expect(cursor.uninstall(host).action).toBe("absent");
  });

  it("status reports registration and entry", () => {
    const host = testHost();
    expect(cursor.status(host)).toMatchObject({ installed: false, registered: false });
    mkdirSync(join(host.home, ".cursor"));
    expect(cursor.status(host)).toMatchObject({ installed: true, registered: false });
    cursor.install(host);
    const s = cursor.status(host);
    expect(s.registered).toBe(true);
    expect(s.entry?.args).toEqual([host.cliPath, "mcp"]);
  });

  it("keeps a UTF-8 BOM", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    write(file, "﻿" + JSON.stringify({ mcpServers: {} }));
    expect(cursor.install(host).action).toBe("updated");
    const text = readFileSync(file, "utf8");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(JSON.parse(text.slice(1)).mcpServers.baglam).toBeTruthy();
  });

  it("skips when the servers value is not an object", () => {
    const host = testHost();
    const file = join(host.home, ".cursor", "mcp.json");
    const original = JSON.stringify({ mcpServers: [{ command: "x" }] });
    write(file, original);
    expect(cursor.install(host)).toMatchObject({ action: "skipped", note: expect.stringMatching(/not an object/) });
    expect(readFileSync(file, "utf8")).toBe(original);
    write(file, JSON.stringify({ mcpServers: "oops" }));
    expect(cursor.uninstall(host).action).toBe("skipped");
  });
});
