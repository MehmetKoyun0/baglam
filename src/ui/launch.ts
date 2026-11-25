import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ContextStore } from "../store.js";
import { resolveDbPath } from "../config.js";
import { realHost } from "../host.js";
import { LOGIN_LIFETIME, startPanel } from "./server.js";
import { panelApi } from "./api.js";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Only the private, short-lived file contains the login URL. */
export function browserLoginFile(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "baglam-ui-"));
  const file = join(dir, "login.html");
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    writeFileSync(file, '<meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=' +
      new URL(url).href.replaceAll("&", "&amp;").replaceAll('"', "&quot;") + '">', { mode: 0o600 });
  } catch (err) {
    remove();
    throw err;
  }
  return { url: pathToFileURL(file).href, remove };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => { /* the printed link remains available */ });
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/** `baglam ui [--port n] [--no-open]`: run the review panel until Ctrl+C. */
export async function runUi(argv: string[], print: (s: string) => void = console.log): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, "no-open": { type: "boolean" } },
    allowPositionals: false,
  });
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error("--port must be a port number");

  const dbPath = resolveDbPath();
  const store = new ContextStore(dbPath);
  const panel = await startPanel({
    store,
    user: process.env.BAGLAM_USER?.trim() || `human:${userInfo().username}`,
    host: realHost(),
    dbPath,
    port,
    staticDir: join(PACKAGE_ROOT, "dist", "panel"),
    routes: panelApi,
  });

  print(`Bağlam panel: ${panel.url}`);
  print("This link works once on this computer and expires in five minutes. Press Ctrl+C to stop.");
  let cleanLogin = () => {};
  if (!values["no-open"]) {
    try {
      const login = browserLoginFile(panel.url);
      const timer = setTimeout(login.remove, LOGIN_LIFETIME).unref();
      cleanLogin = () => { clearTimeout(timer); login.remove(); };
      openBrowser(login.url);
    } catch { /* the terminal link remains available */ }
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      cleanLogin();
      panel.close().finally(() => {
        store.close();
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
