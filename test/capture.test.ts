import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/store.js";
import { SCHEMA_VERSION } from "../src/migrate.js";

const DIR = join(tmpdir(), "baglam-cap-proj");
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

function setup() {
  let now = 1_700_000_000_000;
  const clock = { tick: (ms: number) => (now += ms) };
  const store = new ContextStore(":memory:", () => now);
  const cap = (agent: string, event: Parameters<ContextStore["autoCapture"]>[0]["event"]) =>
    store.autoCapture({ project: "p", branch: "main", dir: DIR, agent, event });
  return { store, clock, cap, live: () => store.getHandoff("p", "main") };
}

afterEach(() => {
  delete process.env.BAGLAM_AUTO_CAPTURE;
});

describe("auto-capture: requests", () => {
  it("prompt starts a task when none is live", () => {
    const { cap, live } = setup();
    cap("claude-code", { kind: "prompt", text: "  Yapılacaklar uygulaması yap\nayrıntı burada" });
    const h = live()!;
    expect(h.goal).toBe("Yapılacaklar uygulaması yap");
    expect(h.status).toBe("in_progress");
    expect(h.requests).toEqual(["Yapılacaklar uygulaması yap"]);
    expect(h.agent).toBe("claude-code");
    expect(h.agentVerified).toBe(true);
    expect(h.agentAt).toBeNull();
  });

  it("prompt continues a live task of another agent", () => {
    const { store, cap, live } = setup();
    const t = store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "Todo", next: ["search"] });
    cap("codex", { kind: "prompt", text: "devam et" });
    const h = live()!;
    expect(h.taskId).toBe(t.taskId);
    expect(h.goal).toBe("Todo");
    expect(h.next).toEqual(["search"]);
    expect(h.requests.at(-1)).toBe("devam et");
  });

  it("prompt after a done task starts a new one", () => {
    const { store, cap, live } = setup();
    const t = store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "Old", status: "done" });
    cap("claude-code", { kind: "prompt", text: "Add search" });
    expect(live()!.taskId).not.toBe(t.taskId);
    expect(live()!.goal).toBe("Add search");
  });

  it("prompt on a task untouched for 12 hours starts a new one", () => {
    const { store, cap, live, clock } = setup();
    const t = store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "Old" });
    clock.tick(12 * 3_600_000 + 1);
    cap("claude-code", { kind: "prompt", text: "Something else" });
    expect(live()!.taskId).not.toBe(t.taskId);
    expect(live()!.goal).toBe("Something else");
  });

  it("the same request sent twice in a row is kept once (Cursor fires its hook twice)", () => {
    const { cap, live } = setup();
    cap("cursor", { kind: "prompt", text: "ikinci.txt oluştur" });
    cap("cursor", { kind: "prompt", text: "ikinci.txt oluştur" });
    expect(live()!.requests).toEqual(["ikinci.txt oluştur"]);
  });

  it("the same words later are a new request, from any tool (Codex 'devam et', then Cursor 'devam et')", () => {
    const { cap, live, clock } = setup();
    cap("codex", { kind: "prompt", text: "Tıp Kartları" });
    cap("codex", { kind: "prompt", text: "devam et" });
    clock.tick(10 * 60_000);
    cap("cursor", { kind: "prompt", text: "devam et" });
    expect(live()!.requests).toEqual(["Tıp Kartları", "devam et", "devam et"]);
    expect(live()!.agent).toBe("cursor");
  });

  it("requests keep the last 5, each at most 300 chars", () => {
    const { cap, live } = setup();
    for (let i = 1; i <= 7; i++) cap("claude-code", { kind: "prompt", text: `r${i} ` + "x".repeat(400) });
    const r = live()!.requests;
    expect(r).toHaveLength(5);
    expect(r[0].startsWith("r3 ")).toBe(true);
    expect(r.every((x) => x.length <= 300)).toBe(true);
  });

  it("keeps revised instructions under the same heading and coalesces only the repeat", () => {
    const { cap, live } = setup();
    for (const text of ["Plan\nFirst version", "Plan\nRevised version", "Plan\nRevised version", "Plan"]) {
      cap("cursor", { kind: "prompt", text });
    }
    expect(live()?.requests).toEqual(["Plan", "Plan", "Plan"]);
    expect(live()?.request).toBe("Plan\nRevised version");
  });

  it("an empty prompt does nothing", () => {
    const { cap, live } = setup();
    expect(cap("claude-code", { kind: "prompt", text: "   \n " })).toBeUndefined();
    expect(live()).toBeUndefined();
  });

  it("a secret in a request is partially redacted, keeping the rest of the text, and pure secrets are hidden", () => {
    const { cap, live, clock } = setup();
    cap("claude-code", { kind: "prompt", text: `use key ${AWS} for s3` });
    expect(live()!.goal).toBe("use key [redacted] for s3");
    expect(JSON.stringify(live())).not.toContain(AWS);
    clock.tick(12 * 3_600_000 + 1);
    cap("claude-code", { kind: "prompt", text: AWS });
    expect(live()!.goal).toBe("(hidden: looked like a secret)");
    expect(JSON.stringify(live())).not.toContain(AWS);
  });
});

describe("the agent's own checkpoint right after a captured request", () => {
  it("new_task on a task only the tool saved names that task instead of replacing it", () => {
    const { store, cap, live } = setup();
    cap("codex", { kind: "prompt", text: "notlar.txt oluştur" });
    const auto = live()!;
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Create notlar.txt", newTask: true, files: ["notlar.txt"] });
    const h = live()!;
    expect(h.taskId).toBe(auto.taskId);
    expect(h.goal).toBe("Create notlar.txt");
    expect(h.requests).toEqual(["notlar.txt oluştur"]);
  });

  it("the full request that starts a task is kept (the plan in it reaches the next agent), and survives the agent's checkpoints", () => {
    const { store, cap, live } = setup();
    const plan = "Tıp Kartları yapıyoruz.\n\nPlan üç parça:\n1. İskelet\n2. Çalışma modu: bildim / bilemedim, Farmakoloji ve Patoloji\n3. Arama";
    cap("antigravity", { kind: "prompt", text: `  ${plan}  ` });
    expect(live()!.goal).toBe("Tıp Kartları yapıyoruz.");
    expect(live()!.request).toBe(plan);
    store.checkpoint({ project: "p", branch: "main", agent: "antigravity", agentVerified: true, goal: "Tıp Kartları", next: ["2. parça"] });
    cap("codex", { kind: "prompt", text: "devam et" });
    expect(live()!.request).toBe(plan);
    expect(live()!.requests).toEqual(["Tıp Kartları yapıyoruz.", "devam et"]);
  });

  it("a detailed plan sent after a short first message is kept in full; a later one-liner keeps it", () => {
    const { cap, live } = setup();
    const plan = "Plan:\n1. Login\n2. Payments\n3. Reports";
    cap("codex", { kind: "prompt", text: "projeye bir bak" });
    expect(live()!.request).toBeNull();
    cap("codex", { kind: "prompt", text: plan });
    expect(live()!.request).toBe(plan);
    cap("codex", { kind: "prompt", text: "devam et" });
    expect(live()!.request).toBe(plan);
    const newer = "New plan:\n- only reports";
    cap("codex", { kind: "prompt", text: newer });
    expect(live()!.request).toBe(newer);
  });

  it("an agent's new task carries the detailed request that started it, never an older one", () => {
    const { store, cap, live } = setup();
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Old work" });
    const plan = "Build reports:\n- monthly\n- yearly";
    cap("codex", { kind: "prompt", text: plan });
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Reports", newTask: true });
    expect(live()!.request).toBe(plan);
    // An older detailed plan, then a one-line request that starts the next task: nothing detailed to carry.
    cap("codex", { kind: "prompt", text: "now fix the footer" });
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Footer", newTask: true });
    expect(live()!.goal).toBe("Footer");
    expect(live()!.request).toBeNull();
  });

  it("a one-line request is not stored twice; a long one is capped; a secret in it is hidden", () => {
    const { cap, live, clock } = setup();
    cap("codex", { kind: "prompt", text: "Fix the login bug" });
    expect(live()!.request).toBeNull();
    clock.tick(12 * 3_600_000 + 1);
    cap("codex", { kind: "prompt", text: `Big plan\n${"x".repeat(5000)}` });
    expect(live()!.request).toHaveLength(2000);
    clock.tick(12 * 3_600_000 + 1);
    cap("codex", { kind: "prompt", text: `Deploy it\nkey ${AWS}\nThen run smoke tests` });
    expect(live()!.request).toBe("Deploy it\nkey [redacted]\nThen run smoke tests");
    expect(JSON.stringify(live())).not.toContain(AWS);
  });

  it("a real new task keeps the request that started it", () => {
    const { store, cap, live } = setup();
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Old work" });
    cap("codex", { kind: "prompt", text: "now something unrelated" });
    store.checkpoint({ project: "p", branch: "main", agent: "codex", agentVerified: true, goal: "Unrelated", newTask: true });
    expect(live()!.goal).toBe("Unrelated");
    expect(live()!.requests).toEqual(["now something unrelated"]);
  });

  it("agent instructions ask for the user's language", async () => {
    const { instructionBlock } = await import("../src/instructions.js");
    expect(instructionBlock()).toMatch(/in the language the user writes in/);
  });
});

describe("auto-capture: secrets cut by a size limit", () => {
  it("a secret straddling the request limit is never stored even in part", () => {
    const { cap, live } = setup();
    cap("claude-code", { kind: "prompt", text: "x".repeat(290) + " " + AWS });
    expect(live()!.goal).not.toContain("AKIA");
    expect(live()!.goal).not.toContain(AWS.slice(0, 6));
    expect(live()!.goal.startsWith("x".repeat(290))).toBe(true);
  });

  it("a secret straddling the reply limit is never stored even in part", () => {
    const { cap, live } = setup();
    cap("claude-code", { kind: "prompt", text: "Build it" });
    cap("claude-code", { kind: "stop", reply: "y".repeat(980) + " " + AWS });
    expect(live()!.now).not.toContain("AKIA");
    expect(live()!.now).not.toContain(AWS.slice(0, 6));
    expect(live()!.now!.startsWith("Last reply: " + "y".repeat(900))).toBe(true);
  });
});

describe("auto-capture: edits and replies", () => {
  it("edit adds project-relative paths, dedupes, ignores paths outside the project", () => {
    const { cap, live } = setup();
    cap("claude-code", { kind: "prompt", text: "Build it" });
    cap("claude-code", { kind: "edit", files: [join(DIR, "src", "a.ts"), join(DIR, "b.md")] });
    cap("claude-code", { kind: "edit", files: [join(DIR, "src", "a.ts"), join(tmpdir(), "elsewhere.txt"), join(DIR, "..", "..", "outside", "x.ts")] });
    expect(live()!.files).toEqual(["b.md", "src/a.ts"]);
  });

  it("edit with no live task does nothing", () => {
    const { cap, live } = setup();
    expect(cap("claude-code", { kind: "edit", files: [join(DIR, "a.ts")] })).toBeUndefined();
    expect(live()).toBeUndefined();
  });

  it("stop saves the last reply when the agent has not checkpointed since the request", () => {
    const { cap, live } = setup();
    cap("claude-code", { kind: "prompt", text: "Build it" });
    cap("claude-code", { kind: "stop", reply: "Added index.html. " + "y".repeat(2000) });
    expect(live()!.now!.startsWith("Last reply: Added index.html.")).toBe(true);
    expect(live()!.now!.length).toBeLessThanOrEqual(1000);
  });

  it("stop leaves the agent's own 'now' alone when it checkpointed after the request", () => {
    const { store, cap, live, clock } = setup();
    cap("claude-code", { kind: "prompt", text: "Build it" });
    clock.tick(1000);
    store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, now: "Writing app.js" });
    clock.tick(1000);
    cap("claude-code", { kind: "stop", reply: "Done for now" });
    expect(live()!.now).toBe("Writing app.js");
    expect(live()!.agentAt).not.toBeNull();
  });

  it("auto-capture never changes status, done or next", () => {
    const { store, cap, live } = setup();
    store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "T", status: "blocked", doneAdd: ["a"], next: ["b"] });
    cap("claude-code", { kind: "prompt", text: "go on" });
    cap("claude-code", { kind: "edit", files: [join(DIR, "x.ts")] });
    cap("claude-code", { kind: "stop", reply: "ok" });
    const h = live()!;
    expect([h.status, h.done, h.next]).toEqual(["blocked", ["a"], ["b"]]);
  });

  it("records when the agent and the tool last saved", () => {
    const { store, cap, live, clock } = setup();
    store.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "T" });
    const agentAt = live()!.agentAt;
    clock.tick(5000);
    cap("claude-code", { kind: "edit", files: [join(DIR, "x.ts")] });
    expect(live()!.agentAt).toBe(agentAt);
    expect(live()!.autoAt).toBe(live()!.updatedAt);
  });
});

describe("auto-capture: switch and bookkeeping", () => {
  it("is on by default, can be turned off per project, and the env switch wins", () => {
    const { store } = setup();
    expect(store.isAutoCapture("p")).toBe(true);
    store.setAutoCapture("p", false, "me");
    expect(store.isAutoCapture("p")).toBe(false);
    store.setAutoCapture("p", true, "me");
    process.env.BAGLAM_AUTO_CAPTURE = "0";
    expect(store.isAutoCapture("p")).toBe(false);
  });

  it("turning auto-capture off keeps autonomous mode as it was", () => {
    const { store } = setup();
    store.setAutonomous("p", true, "me");
    store.setAutoCapture("p", false, "me");
    expect(store.isAutonomous("p")).toBe(true);
  });

  it("remembers when each tool's hook last fired", () => {
    const { store, clock } = setup();
    store.noteHookSeen("cursor", "prompt");
    clock.tick(10);
    store.noteHookSeen("cursor", "edit");
    expect(store.hookSeen()).toEqual({ cursor: { at: 1_700_000_000_010, event: "edit" } });
  });

  it("migrates a v6 database to the current schema keeping handoffs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "baglam-cap-mig-")), "b.db");
    const s = new ContextStore(path);
    s.checkpoint({ project: "p", branch: "main", agent: "claude-code", agentVerified: true, goal: "Kept" });
    s.close();
    // Make it look like a v6 database whose handoff row predates the new fields.
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE project_settings DROP COLUMN auto_capture; DROP TABLE hook_seen; PRAGMA user_version = 6;");
    const row = db.prepare("SELECT data FROM handoffs").get() as { data: string };
    const d = JSON.parse(row.data);
    delete d.requests;
    delete d.agentAt;
    delete d.autoAt;
    db.prepare("UPDATE handoffs SET data = ?").run(JSON.stringify(d));
    db.close();
    const again = new ContextStore(path);
    const h = again.getHandoff("p", "main")!;
    expect(SCHEMA_VERSION).toBe(8);
    expect(h.goal).toBe("Kept");
    expect(h.requests).toEqual([]);
    expect(again.isAutoCapture("p")).toBe(true);
    again.close();
  });
});
