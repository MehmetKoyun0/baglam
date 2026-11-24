import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextStore } from "../src/store.js";
import { floodLimitFromEnv, submitProposal } from "../src/policy.js";

const P = "11111111-2222-4333-8444-555555555555";
const Q = "99999999-2222-4333-8444-555555555555";
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("submitProposal", () => {
  let store: ContextStore;
  beforeEach(() => {
    store = new ContextStore(":memory:");
  });

  const input = (over: Record<string, unknown> = {}) => ({
    project: P, kind: "fact" as const, title: "Build runs on Node 24", body: "CI and local builds use Node 24 LTS.",
    sourceAgent: "codex", ...over,
  });
  const ctx = { agentVerified: true, floodLimit: 20 };

  it("blocks a secret and stores nothing", () => {
    const r = submitProposal(store, input({ body: `key ${AWS}` }), ctx);
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") expect(r.findings[0].type).toBe("AWS access key");
    expect(store.pending(P)).toEqual([]);
  });

  it("flood limit counts only pending", () => {
    for (let i = 0; i < 20; i++) {
      const r = submitProposal(store, input({ title: `Fact number ${i} alpha${i}`, body: `Distinct body ${i} zeta${i} omega${i}` }), ctx);
      expect(r.status).toBe("pending");
    }
    const over = submitProposal(store, input({ title: "One more", body: "Something else entirely new here" }), ctx);
    expect(over).toMatchObject({ status: "refused", reason: expect.stringMatching(/20 proposals are already waiting/) });
    store.reject(store.pending(P)[0].id, "human");
    expect(submitProposal(store, input({ title: "One more", body: "Something else entirely new here" }), ctx).status).toBe("pending");
  });

  it("shares one review budget between pending and autonomous proposals", () => {
    const auto = { ...ctx, autonomous: true };
    submitProposal(store, input(), ctx);
    for (let i = 1; i < 20; i++) expect(submitProposal(store, input(), auto).status).toBe("auto-shared");
    expect(submitProposal(store, input(), auto).status).toBe("refused");
    expect(store.unreviewed(P)).toHaveLength(19);
    expect(submitProposal(store, input({ project: Q }), auto).status).toBe("auto-shared");
    expect(submitProposal(store, input({ sourceAgent: "cursor" }), auto).status).toBe("auto-shared");
    store.keep([store.unreviewed(P).find(e => e.sourceAgent === "codex")!.id], "owner");
    expect(submitProposal(store, input(), auto).status).toBe("auto-shared");
  });

  it("flood limit is per agent", () => {
    for (let i = 0; i < 3; i++) submitProposal(store, input({ title: `T${i} kappa${i}`, body: `B${i} lambda${i} sigma${i}` }), { ...ctx, floodLimit: 3 });
    const other = submitProposal(store, input({ sourceAgent: "cursor", title: "Other agent", body: "Separate quota applies" }), { ...ctx, floodLimit: 3 });
    expect(other.status).toBe("pending");
  });

  it("auto-approves with a matching rule for a verified agent", () => {
    const rule = store.addTrustRule({ projectId: P, agent: "codex", kind: "fact" });
    const r = submitProposal(store, input(), ctx);
    expect(r.status).toBe("auto-approved");
    if (r.status === "auto-approved") {
      expect(r.rule.id).toBe(rule.id);
      expect(r.entry.status).toBe("approved");
      expect(r.entry.autoApproved).toBe(true);
      expect(r.entry.decidedBy).toBe(`trust-rule:${rule.id}`);
    }
  });

  it("never auto-approves an unverified agent", () => {
    store.addTrustRule({ projectId: P, agent: "codex" });
    expect(submitProposal(store, input(), { ...ctx, agentVerified: false }).status).toBe("pending");
  });

  it("trust rules never auto-approve a supersede", () => {
    const human = store.addApproved({ project: P, kind: "decision", title: "Use Postgres", body: "Primary DB is Postgres." }, "human");
    store.addTrustRule({ projectId: P, agent: "codex" });
    const r = submitProposal(store, input({ kind: "decision", title: "Use MySQL", body: "Primary DB is MySQL 8.", supersedes: human.id }), ctx);
    expect(r.status).toBe("pending");
    expect(store.get(human.id)?.status).toBe("approved");
  });

  it("duplicates go to review even with a rule, and are recorded", () => {
    const first = store.addApproved({ project: P, kind: "fact", title: "Build runs on Node 24", body: "CI and local builds use Node 24 LTS." }, "human");
    store.addTrustRule({ projectId: P, agent: "codex" });
    const r = submitProposal(store, input(), ctx);
    expect(r.status).toBe("pending");
    if (r.status === "pending") {
      expect(r.similar.map((e) => e.id)).toEqual([first.id]);
      expect(r.entry.similarTo).toEqual([first.id]);
    }
  });

  it("a trust rule never re-approves something the owner rejected", () => {
    store.addTrustRule({ projectId: P, agent: "codex" });
    const first = submitProposal(store, input({ kind: "decision", title: "Use yarn workspaces", body: "Switch the monorepo to yarn workspaces." }), { ...ctx, agentVerified: false });
    if (first.status !== "pending") throw new Error("expected pending");
    store.reject(first.entry.id, "human", "we use pnpm");
    const again = submitProposal(store, input({ kind: "decision", title: "Use yarn workspaces", body: "Switch the monorepo to yarn workspaces." }), ctx);
    expect(again.status).toBe("pending");
    if (again.status === "pending") expect(again.closed.map((e) => e.id)).toEqual([first.entry.id]);
  });

  it("blocks a secret placed in audience", () => {
    expect(submitProposal(store, input({ audience: [AWS] }), ctx).status).toBe("blocked");
  });

  it("project rule does not apply to another project; global rule does", () => {
    store.addTrustRule({ projectId: P, agent: "codex" });
    expect(submitProposal(store, input({ project: Q }), ctx).status).toBe("pending");
    store.addTrustRule({ projectId: null, kind: "fact" });
    expect(submitProposal(store, input({ project: Q, title: "Second fact", body: "Totally different words here" }), ctx).status).toBe("auto-approved");
  });

  it("addTrustRule needs agent or kind; list and remove work", () => {
    expect(() => store.addTrustRule({ projectId: P })).toThrow(/agent or kind/);
    const a = store.addTrustRule({ projectId: P, agent: "codex" });
    const g = store.addTrustRule({ projectId: null, kind: "fact" });
    store.addTrustRule({ projectId: Q, agent: "cursor" });
    expect(store.listTrustRules(P).map((r) => r.id).sort()).toEqual([a.id, g.id].sort());
    expect(store.removeTrustRule(a.id)).toBe(true);
    expect(store.removeTrustRule(a.id)).toBe(false);
  });

  it("autonomous: verified agent shared now as unreviewed, even a replacement", () => {
    const human = store.addApproved({ project: P, kind: "decision", title: "Use Postgres", body: "Primary DB is Postgres." }, "human");
    const r = submitProposal(store, input({ kind: "decision", title: "Use MySQL", body: "Primary DB is MySQL 8.", supersedes: human.id }), { ...ctx, autonomous: true });
    expect(r.status).toBe("auto-shared");
    if (r.status === "auto-shared") expect(r.entry.reviewState).toBe("unreviewed");
    expect(store.get(human.id)?.status).toBe("superseded");
  });

  it("autonomous: unverified waits", () => {
    expect(submitProposal(store, input(), { ...ctx, agentVerified: false, autonomous: true }).status).toBe("pending");
  });

  it("autonomous: rejected look-alike waits", () => {
    const first = submitProposal(store, input({ title: "Use yarn workspaces", body: "Switch to yarn workspaces." }), ctx);
    if (first.status !== "pending") throw new Error("expected pending");
    store.reject(first.entry.id, "human");
    expect(submitProposal(store, input({ title: "Use yarn workspaces", body: "Switch to yarn workspaces." }), { ...ctx, autonomous: true }).status).toBe("pending");
  });

  it("autonomous: secret still blocked", () => {
    expect(submitProposal(store, input({ body: AWS }), { ...ctx, autonomous: true }).status).toBe("blocked");
  });
});

describe("floodLimitFromEnv", () => {
  const saved = process.env.BAGLAM_FLOOD_LIMIT;
  afterEach(() => {
    if (saved === undefined) delete process.env.BAGLAM_FLOOD_LIMIT;
    else process.env.BAGLAM_FLOOD_LIMIT = saved;
  });
  it("defaults to 20 and reads a positive integer", () => {
    delete process.env.BAGLAM_FLOOD_LIMIT;
    expect(floodLimitFromEnv()).toBe(20);
    process.env.BAGLAM_FLOOD_LIMIT = "5";
    expect(floodLimitFromEnv()).toBe(5);
    process.env.BAGLAM_FLOOD_LIMIT = "nonsense";
    expect(floodLimitFromEnv()).toBe(20);
  });

});
