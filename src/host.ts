import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fchmodSync, mkdirSync, openSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Everything setup/init/doctor need from the machine, so tests can run against a temp home. */
export interface HostEnv {
  home: string;
  /** Per-user app config root: %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
  appData: string;
  platform: NodeJS.Platform;
  /** Absolute paths written into tool configs (GUI apps often have no PATH). */
  nodePath: string;
  cliPath: string;
  /** `input` is written to the command's stdin (used for the clipboard). */
  run(cmd: string, args: string[], input?: string, opts?: RunOptions): { code: number; stdout: string; stderr: string };
  hasCommand(cmd: string): boolean;
}

export interface RunOptions {
  /**
   * The command may leave a process behind that keeps its stdout/stderr open (wl-copy and xclip stay
   * alive to own the clipboard). Do not capture output, so the call returns when the command itself exits.
   */
  background?: boolean;
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function realHost(): HostEnv {
  const home = homedir();
  const appData =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return {
    home,
    appData,
    platform: process.platform,
    nodePath: process.execPath,
    cliPath: join(PACKAGE_ROOT, "dist", "cli.js"),
    run(cmd, args, input, runOpts) {
      const opts = {
        encoding: "utf8" as const,
        timeout: runOpts?.background ? 10_000 : 60_000,
        windowsHide: true,
        ...(input !== undefined ? { input } : {}),
        ...(runOpts?.background ? { stdio: ["pipe", "ignore", "ignore"] as ("pipe" | "ignore")[] } : {}),
      };
      let r;
      const script = process.platform === "win32" ? windowsScriptFor(cmd) : null;
      if (script) {
        // npm installs CLIs as .cmd shims, which Node can only start through cmd.exe.
        try {
          r = spawnSync(windowsCommandLine(script, args), { ...opts, shell: true });
        } catch (err) {
          return { code: 1, stdout: "", stderr: (err as Error).message };
        }
      } else {
        r = spawnSync(cmd, args, opts);
      }
      return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
    },
    hasCommand(cmd) {
      const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
      return probe.status === 0;
    },
  };
}

/** On Windows: the .cmd/.bat file `where` finds first for `cmd`, or null when it is an .exe or missing. */
function windowsScriptFor(cmd: string): string | null {
  const r = spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).find((l) => l.trim())?.trim() : undefined;
  return first && /\.(cmd|bat)$/i.test(first) ? first : null;
}

/**
 * One cmd.exe command line with every part quoted, so paths with spaces or non-ASCII letters survive.
 * Inside quotes cmd.exe still expands %VAR% and stops at line breaks, so those are refused.
 */
export function windowsCommandLine(file: string, args: string[]): string {
  return [file, ...args]
    .map((part) => {
      if (/[%\r\n]/.test(part)) throw new Error(`cannot pass ${JSON.stringify(part)} safely through cmd.exe`);
      return `"${part.replace(/"/g, '""')}"`;
    })
    .join(" ");
}

/** The MCP server entry every tool gets: absolute node + cli path, and the tool's agent id. */
export function serverEntry(host: HostEnv, agentId: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: host.nodePath, args: [host.cliPath, "mcp"], env: { BAGLAM_AGENT: agentId } };
}

/**
 * Replace `file` without ever leaving it half-written: write a temp file next to it, then rename.
 * A crash mid-write leaves either the old file or the new one, never a truncated config.
 */
export function writeFileAtomic(file: string, data: string, createMode = 0o666): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.baglam-${process.pid}-${Date.now()}.tmp`);
  const previous = statSync(file, { throwIfNoEntry: false });
  const fd = openSync(tmp, "wx", previous ? 0o600 : createMode);
  try {
    try {
      writeFileSync(fd, data);
      if (previous && process.platform !== "win32") fchmodSync(fd, previous.mode & 0o777);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Copy `file` to `file.baglam-backup` unless that backup already exists. */
export function backupOnce(file: string): boolean {
  const backup = `${file}.baglam-backup`;
  if (!existsSync(file) || existsSync(backup)) return false;
  copyFileSync(file, backup);
  return true;
}
