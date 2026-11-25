import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ContextStore } from "../store.js";
import type { HostEnv } from "../host.js";
import { HttpError, readJson, route, sendJson, sendText, serveStatic, statusFor, type Route } from "./http.js";

export interface PanelOptions {
  store: ContextStore;
  /** Actor recorded for every change made in the panel. */
  user: string;
  host: HostEnv;
  dbPath: string;
  port?: number;
  staticDir: string;
  /** How often to check for changes made by other processes (agents, CLI). */
  pollMs?: number;
  /** Extra API routes (the panel API registers itself here). */
  routes?: (ctx: PanelContext) => Route[];
}

export interface PanelContext {
  store: ContextStore;
  user: string;
  host: HostEnv;
  /** Tell open panels something changed (writes from this process do not bump data_version). */
  notify: () => void;
}

export interface Panel {
  /** Open this once; it carries the one-time login token. */
  url: string;
  port: number;
  close(): Promise<void>;
}


export const LOGIN_LIFETIME = 5 * 60_000;
const SESSION_LIFETIME = 8 * 60 * 60_000;
const MAX_STREAMS = 20;

const OPEN_AGAIN = `<!doctype html><meta charset="utf-8"><title>Bağlam</title>
<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>Open the panel again</h1>
<p>This link was already used, or this browser is not signed in to this panel. Run <code>baglam ui</code> in a terminal to get a fresh link.</p>
<p lang="tr">Bu bağlantı kullanılmış. Yeni bağlantı için terminalde <code>baglam ui</code> çalıştırın.</p></body>`;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** Start the review panel on 127.0.0.1. */
export async function startPanel(o: PanelOptions): Promise<Panel> {
  let token: string | null = randomBytes(24).toString("hex");
  const loginUntil = Date.now() + LOGIN_LIFETIME;
  let session: string | null = null;
  let sessionUntil = 0;
  const listeners = new Set<ServerResponse>();
  let port = 0;
  // Browsers share cookies across ports, so each panel's cookie carries its own port.
  const cookieName = () => `baglam_session_${port}`;

  const broadcast = (message: string) => {
    for (const res of listeners) {
      if (res.destroyed || res.writableEnded || Date.now() >= sessionUntil) {
        listeners.delete(res);
        if (!res.destroyed && !res.writableEnded) res.end();
      } else res.write(message);
    }
  };
  const notify = () => broadcast("event: change\ndata: {}\n\n");
  const ctx: PanelContext = { store: o.store, user: o.user, host: o.host, notify };

  const routes: Route[] = [
    route("GET", "/api/ping", () => ({ ok: true })),
    route("POST", "/api/ping", () => ({ ok: true })),
    ...(o.routes?.(ctx) ?? []),
  ];

  // Changes from agents and the CLI happen in other processes: watch SQLite's data_version.
  let lastVersion = o.store.dataVersion();
  const poll = setInterval(() => {
    try {
      const v = o.store.dataVersion();
      if (v !== lastVersion) {
        lastVersion = v;
        notify();
      }
    } catch {
      /* store closed during shutdown */
    }
  }, o.pollMs ?? 1000);
  const heartbeat = setInterval(() => {
    broadcast(": keep-alive\n\n");
  }, 25_000);

  const hasSession = (req: IncomingMessage) => {
    const s = cookieValue(req, cookieName());
    return !!s && !!session && Date.now() < sessionUntil && sameSecret(session, s);
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) return sendText(res, 403, "forbidden host", "text/plain");
    const origin = req.headers.origin;
    const writes = req.method !== "GET" && req.method !== "HEAD";
    if (writes) {
      // A write must prove it comes from the panel's own page: a matching Origin, or the browser's
      // Sec-Fetch-Site saying same-origin. Anything else (other sites, other localhost ports) is refused.
      const sameOrigin = origin
        ? allowedHosts.map((h) => `http://${h}`).includes(origin)
        : req.headers["sec-fetch-site"] === "same-origin";
      if (!sameOrigin) return sendText(res, 403, "forbidden origin", "text/plain");
      const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
      if (hasBody && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
        return sendJson(res, 415, { error: "send JSON (content-type: application/json)" });
      }
    }

    const url = new URL(req.url ?? "/", `http://${allowedHosts[0]}`);

    // One-time login: the URL printed by `baglam ui` carries a token that becomes a session cookie.
    const t = url.searchParams.get("t");
    if (url.pathname === "/" && t !== null) {
      if (req.method === "HEAD") return sendText(res, 204, "");
      if (req.method !== "GET") return sendText(res, 405, "method not allowed", "text/plain");
      if (token && Date.now() < loginUntil && sameSecret(t, token)) {
        token = null;
        session = randomBytes(32).toString("hex");
        sessionUntil = Date.now() + SESSION_LIFETIME;
        res.writeHead(302, {
          location: "/",
          "set-cookie": `${cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME / 1000}`,
          "cache-control": "no-store",
        });
        return void res.end();
      }
      if (!hasSession(req)) return sendText(res, 403, OPEN_AGAIN);
      res.writeHead(302, { location: "/" });
      return void res.end();
    }

    if (!hasSession(req)) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "not signed in; run baglam ui again" });
      return sendText(res, 403, OPEN_AGAIN);
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        connection: "keep-alive",
      });
      res.once("error", () => { listeners.delete(res); res.destroy(); });
      res.once("close", () => listeners.delete(res));
      res.write(`: connected\n\n`);
      listeners.add(res);
      // Cap open streams: forgotten tabs should not pile up. The oldest stream is closed (its page reconnects).
      while (listeners.size > MAX_STREAMS) {
        const oldest = listeners.values().next().value!;
        listeners.delete(oldest);
        oldest.end();
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const match = routes
        .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
        .find((x) => x.m);
      if (!match) return sendJson(res, 404, { error: "no such endpoint" });
      try {
        const body = await readJson(req);
        const params = Object.fromEntries(match.r.keys.map((k, i) => [k, decodeURIComponent(match.m![i + 1])]));
        const result = await match.r.handler({ req, res, params, query: url.searchParams, body });
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
        if (writes) notify();
      } catch (err) {
        const status = statusFor(err);
        const message =
          status === 500 ? "unexpected error" : status === 503 ? "database busy, try again in a moment" : (err as Error).message;
        sendJson(res, status, { error: message, ...(err instanceof HttpError ? err.details : {}) });
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed", "text/plain");
    serveStatic(res, o.staticDir, url.pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "unexpected error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(poll);
        clearInterval(heartbeat);
        for (const res of listeners) res.end();
        listeners.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export { HttpError } from "./http.js";
