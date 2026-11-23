import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ContextStore } from "../src/store.js";
import { createServer } from "../src/server.js";
import { createMarker } from "../src/project.js";
import { normalizeProject } from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "baglam-srv-"));

function text(res: unknown): string {
  return (res as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");
}

describe("MCP server", () => {
  let store: ContextStore;
  let closers: (() => Promise<void>)[];
  let dir: string;
  let P: string;

  beforeEach(() => {
    store = new ContextStore(":memory:");
    closers = [];
    dir = tmp();
    mkdirSync(join(dir, ".git")); // a real workspace: the cwd fallback only accepts git roots or markers
    P = normalizeProject(dir);
  });
  afterEach(async () => {
    await Promise.all(closers.map((c) => c()));
    store.close();
  });

  async function agent(
    name: string,
    opts: { agent?: string; cwd?: string; envProject?: string; roots?: () => string[] } = {},
  ) {
    const server = createServer(store, { cwd: opts.cwd ?? dir, envProject: opts.envProject, agent: opts.agent });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name, version: "1.0.0" },
      opts.roots ? { capabilities: { roots: { listChanged: true } } } : {},
    );
    if (opts.roots) {
      const roots = opts.roots;
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: roots().map((d) => ({ uri: pathToFileURL(d).href })),
      }));
    }
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(() => client.close());
    return client;
  }

  const propose = (c: Client, extra: Record<string, unknown> = {}) =>
    c.callTool({ name: "context_propose", arguments: { kind: "fact", title: "t", body: "b", ...extra } });

  it("exposes exactly the agent tools (no approve/reject/undo)", async () => {
    const { tools } = await (await agent("cursor")).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "context_brief", "context_checkpoint", "context_get", "context_handoff", "context_propose", "context_search",
    ]);
    for (const t of tools) expect(Object.keys(t.inputSchema.properties ?? {})).toContain("project_path");
  });

  it("advertises manual approval, trust rules and autonomous review to MCP clients", async () => {
    const client = await agent("cursor");
    const { tools } = await client.listTools();
    const proposal = tools.find((tool) => tool.name === "context_propose");
    for (const description of [client.getInstructions(), proposal?.description]) {
      expect(description).toMatch(/by default, proposals wait for human approval/i);
      expect(description).toMatch(/verified agents, a matching trust rule can auto-approve/i);
      expect(description).toMatch(/autonomous mode, eligible proposals from verified agents are shared immediately/i);
      expect(description).toMatch(/owner reviews them afterward/i);
      expect(description).toMatch(/similar to rejected records still require human approval/i);
    }
  });

  it("propose records the client name as source and stays pending", async () => {
    const c = await agent("claude-code");
    const res = await c.callTool({
      name: "context_propose",
      arguments: { kind: "decision", title: "Use pnpm", body: "Package manager is pnpm.", rationale: "Workspace support" },
    });
    expect(text(res)).toMatch(/pending human approval/i);
    const [p] = store.pending(P);
    expect(p.sourceAgent).toBe("claude-code");
    expect(p.rationale).toBe("Workspace support");
  });

  it("agent override from config wins over client name", async () => {
    await propose(await agent("generic-client", { agent: "research-agent" }));
    expect(store.pending(P)[0].sourceAgent).toBe("research-agent");
  });

  it("brief shows approved context to another agent, with provenance and data framing", async () => {
    await propose(await agent("claude-code"), { kind: "decision", title: "Use pnpm", body: "Package manager is pnpm." });
    store.approve(store.pending(P)[0].id, "human");
    const out = text(await (await agent("cursor")).callTool({ name: "context_brief", arguments: {} }));
    expect(out).toContain("Use pnpm");
    expect(out).toContain("claude-code");
    expect(out).toMatch(/not instructions/i);
  });

  it("brief reports when nothing is shared yet and how many are pending", async () => {
    store.propose({ project: P, kind: "fact", title: "x", body: "y", sourceAgent: "a" });
    const out = text(await (await agent("cursor")).callTool({ name: "context_brief", arguments: {} }));
    expect(out).toMatch(/no approved/i);
    expect(out).toMatch(/1 proposal/i);
  });

  it("search and get respect audience", async () => {
    const e = store.addApproved(
      { project: P, kind: "fact", title: "Customer ACME history", body: "Refunded twice.", audience: ["support"] },
      "human",
    );
    const cursor = await agent("cursor");
    expect(text(await cursor.callTool({ name: "context_search", arguments: { query: "ACME" } }))).toMatch(/no matching/i);
    expect((await cursor.callTool({ name: "context_get", arguments: { id: e.id } })).isError).toBe(true);
    const unbound = await agent("support");
    expect(text(await unbound.callTool({ name: "context_brief", arguments: {} }))).not.toContain(e.title);
    expect(text(await unbound.callTool({ name: "context_search", arguments: { query: "ACME" } }))).toMatch(/no matching/i);
    expect((await unbound.callTool({ name: "context_get", arguments: { id: e.id } })).isError).toBe(true);
    expect(text(await propose(unbound, { title: e.title, body: e.body }))).not.toContain(e.id);
    const support = await agent("generic", { agent: "support" });
    expect(text(await support.callTool({ name: "context_search", arguments: { query: "ACME" } }))).toContain("Refunded twice");
    expect(text(await support.callTool({ name: "context_get", arguments: { id: e.id } }))).toContain(e.id);
  });

  it("propose with invalid supersedes returns a tool error, not a crash", async () => {
    const res = await propose(await agent("cursor"), { supersedes: "cmissing" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown entry/);
  });

  it("expires a direct read at the same instant as search and brief", async () => {
    store.close();
    let now = 1000;
    store = new ContextStore(":memory:", () => now);
    const e = store.addApproved({ project: P, title: "Temporary", kind: "fact", body: "Temporary body", ttlDays: 1 }, "owner");
    const client = await agent("cursor");
    const get = () => client.callTool({ name: "context_get", arguments: { id: e.id } });
    expect(text(await get())).toContain(e.body);
    now = e.expiresAt!;
    expect((await get()).isError).toBe(true);
    expect(text(await client.callTool({ name: "context_search", arguments: { query: e.title } }))).toMatch(/no matching/i);
    expect(text(await client.callTool({ name: "context_brief", arguments: {} }))).not.toContain(e.body);
  });

  it("uses client roots", async () => {
    const root = tmp();
    const { key } = createMarker(root);
    await propose(await agent("antigravity", { cwd: homedir(), roots: () => [root] }));
    expect(store.pending(key)).toHaveLength(1);
    expect(store.projectInfo(key)?.lastPath).toBeTruthy();
  });

  it("project_path argument is honoured", async () => {
    const d = tmp();
    await propose(await agent("antigravity", { cwd: homedir() }), { project_path: d });
    expect(store.pending(normalizeProject(d))).toHaveLength(1);
  });

  it("propose is refused when project is unknown", async () => {
    const res = await propose(await agent("antigravity", { cwd: homedir() }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/project_path/);
    expect(store.projects()).toEqual([]);
  });

  it("brief explains an unknown project instead of failing", async () => {
    const res = await (await agent("antigravity", { cwd: homedir() })).callTool({ name: "context_brief", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/project_path/);
  });

  it("ambiguous roots: propose refused, brief lists each initialised project", async () => {
    const a = tmp(), b = tmp();
    const ka = createMarker(a).key, kb = createMarker(b).key;
    store.addApproved({ project: ka, kind: "fact", title: "Alpha fact", body: "a" }, "human");
    store.addApproved({ project: kb, kind: "fact", title: "Beta fact", body: "b" }, "human");
    const c = await agent("antigravity", { cwd: homedir(), roots: () => [a, b] });
    const res = await propose(c);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/several projects/);
    const brief = text(await c.callTool({ name: "context_brief", arguments: {} }));
    expect(brief).toContain("Alpha fact");
    expect(brief).toContain("Beta fact");
  });

  it("lists brief resource and start prompt", async () => {
    store.addApproved({ project: P, kind: "decision", title: "Use pnpm", body: "b" }, "human");
    const c = await agent("cursor");
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain("baglam://brief");
    const read = await c.readResource({ uri: "baglam://brief" });
    expect((read.contents[0] as { text: string }).text).toContain("Use pnpm");
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("baglam_start");
    const prompt = await c.getPrompt({ name: "baglam_start" });
    expect(JSON.stringify(prompt.messages)).toContain("context_brief");
  });

  it("blocked proposal is a tool error and stores nothing", async () => {
    const res = await propose(await agent("cursor"), { body: `token ${["AKIA", "IOSFODNN7EXAMPLE"].join("")}` });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Not stored.*secret.*AWS access key \(AKIA…\)/s);
    expect(store.pending(P)).toEqual([]);
  });

  it("duplicate reply lists the similar record", async () => {
    const e = store.addApproved({ project: P, kind: "fact", title: "Build uses Node 24", body: "Use Node 24 LTS for builds." }, "human");
    const res = await propose(await agent("cursor"), { title: "Build uses Node 24", body: "Use Node 24 LTS for builds." });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain(e.id);
    expect(text(res)).toMatch(/supersedes/);
  });

  it("duplicate hint never reveals records the agent cannot see", async () => {
    const hiddenPending = store.propose({ project: P, kind: "fact", title: "Rotate prod DB creds Friday", body: "Rotate prod DB creds Friday night.", sourceAgent: "claude-code" });
    const hiddenAudience = store.addApproved({ project: P, kind: "fact", title: "Rotate prod DB creds weekly", body: "Rotate prod DB creds Friday night.", audience: ["support"] }, "human");
    const res = await propose(await agent("cursor"), { title: "Rotate prod DB creds Friday", body: "Rotate prod DB creds Friday night." });
    expect(text(res)).not.toContain(hiddenPending.id);
    expect(text(res)).not.toContain(hiddenAudience.id);
    expect(text(res)).not.toMatch(/weekly|Similar records/);
    const pending = store.pending(P).find((e) => e.sourceAgent === "cursor")!;
    expect(pending.similarTo).toHaveLength(2); // the owner still sees both in review
  });

  it("auto-approved reply with BAGLAM_AGENT set", async () => {
    store.addTrustRule({ projectId: null, agent: "codex" });
    const res = await propose(await agent("whatever-client", { agent: "codex" }));
    expect(text(res)).toMatch(/auto-approved/);
    expect(store.visible(P, "cursor")).toHaveLength(1);
  });

  it("client-reported names never trigger trust rules", async () => {
    store.addTrustRule({ projectId: null, agent: "codex" });
    await propose(await agent("codex"));
    expect(store.pending(P)).toHaveLength(1);
  });

  it("roots change is picked up", async () => {
    const a = tmp(), b = tmp();
    const ka = createMarker(a).key, kb = createMarker(b).key;
    let current = [a];
    const c = await agent("antigravity", { cwd: homedir(), roots: () => current });
    await propose(c);
    current = [b];
    await c.sendRootsListChanged();
    await new Promise((r) => setTimeout(r, 20));
    await propose(c);
    expect(store.pending(ka)).toHaveLength(1);
    expect(store.pending(kb)).toHaveLength(1);
  });

  it("checkpoint tool saves and brief shows Continue from here", async () => {
    const c = await agent("claude-code", { agent: "claude-code" });
    const saved = await c.callTool({ name: "context_checkpoint", arguments: { goal: "Stripe checkout", done: ["form validation"], now: "webhook handler", next: ["verify signature", "tests"], files: ["src/payment/webhook.ts"] } });
    expect(saved.isError).toBeFalsy();
    expect(text(saved)).toMatch(/Saved progress/);
    const other = await agent("codex", { agent: "codex" });
    const brief = text(await other.callTool({ name: "context_brief", arguments: {} }));
    expect(brief).toMatch(/## Continue from here/);
    expect(brief).toContain("Stripe checkout");
    expect(brief).toContain("verify signature");
    expect(brief).toContain("claude-code");
    expect(brief.indexOf("Continue from here")).toBeLessThan(brief.indexOf("When you make or learn"));
    const detail = text(await other.callTool({ name: "context_handoff", arguments: {} }));
    expect(detail).toContain("webhook handler");
  });

  it("checkpoint with a secret is refused", async () => {
    const c = await agent("claude-code", { agent: "claude-code" });
    const r = await c.callTool({ name: "context_checkpoint", arguments: { goal: "x", notes: ["AKIA", "IOSFODNN7EXAMPLE"].join("") } });
    expect(r.isError).toBe(true);
    expect(store.listHandoffs()).toEqual([]);
  });

  it("other branch is mentioned, not continued", async () => {
    store.checkpoint({ project: P, branch: "feature", agent: "codex", goal: "Feature work" });
    const brief = text(await (await agent("cursor")).callTool({ name: "context_brief", arguments: {} }));
    expect(brief).not.toMatch(/## Continue from here/);
    expect(brief).toMatch(/Other branches.*feature.*Feature work/);
  });

  it("lists the resume prompt", async () => {
    const { prompts } = await (await agent("cursor")).listPrompts();
    expect(prompts.map((p) => p.name)).toContain("baglam_resume");
  });

  it("autonomous project: a verified agent's proposal is shared now", async () => {
    store.setAutonomous(P, true, "human");
    const res = await propose(await agent("whatever", { agent: "codex" }), { title: "Use Vite", body: "Bundler is Vite." });
    expect(text(res)).toContain("shared now (autonomous mode)");
    expect(store.unreviewed(P)).toHaveLength(1);
  });
});
