// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/preact";
import { I18nProvider } from "../ui/src/i18n.js";
import { ContinueCard } from "../ui/src/components/ContinueCard.js";
import { ReviewList } from "../ui/src/components/ReviewList.js";
import { AutonomousSwitch } from "../ui/src/components/AutonomousSwitch.js";
import { AutoCaptureSwitch } from "../ui/src/components/AutoCaptureSwitch.js";
import type { Api } from "../ui/src/api.js";
import type { Entry, Handoff } from "../ui/src/types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  project: "p", branch: "main", dir: "c:/app", taskId: "t1", goal: "Stripe checkout", status: "in_progress",
  done: ["Form validation", "<b>price</b> calc"], now: "Webhook handler", next: ["Verify signature", "Tests"],
  files: ["src/payment/webhook.ts"], blockers: null, notes: null, agent: "claude-code",
  createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 120_000, expiresAt: Date.now() + 1e9, ...over,
});

let n = 0;
const entry = (over: Partial<Entry> = {}): Entry => ({
  id: `cauto${++n}`, project: "p", kind: "decision", title: `Auto ${n}`, body: "b", rationale: null, tags: [], audience: ["*"],
  status: "approved", sourceAgent: "codex", createdAt: Date.now(), decidedAt: Date.now(), decidedBy: "autonomous-mode",
  decisionNote: null, expiresAt: null, supersedes: null, supersededBy: null, editedAt: null, autoApproved: true,
  similarTo: [], reviewState: "unreviewed", ...over,
});

describe("ContinueCard", () => {
  it("continue card renders checklist as text", () => {
    const { container } = render(
      <I18nProvider lang="en">
        <ContinueCard handoff={handoff()} onCopy={() => {}} onDone={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText("Stripe checkout")).toBeTruthy();
    expect(container.querySelectorAll("li.done-item")).toHaveLength(2);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>price</b> calc");
    expect(container.textContent).toContain("Verify signature");
    expect(container.textContent).toContain("claude-code");
    expect(container.textContent).toContain("src/payment/webhook.ts");
  });

  it("copy and done buttons call back", () => {
    const onCopy = vi.fn();
    const onDone = vi.fn();
    render(
      <I18nProvider lang="en">
        <ContinueCard handoff={handoff()} onCopy={onCopy} onDone={onDone} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy resume prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));
    expect(onCopy).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the full multi-line request and recent checkpoint history when present", () => {
    const h = handoff({ request: "Line 1\nLine 2: details" });
    const history = [h, handoff({ agent: "codex", now: "Initial scaffolding", updatedAt: Date.now() - 600_000 })];
    const { container } = render(
      <I18nProvider lang="tr">
        <ContinueCard handoff={h} history={history} onCopy={() => {}} onDone={() => {}} />
      </I18nProvider>,
    );
    expect(container.textContent).toContain("Tam istek");
    expect(container.textContent).toContain("Line 2: details");
    expect(container.textContent).toContain("Son kayıtlar (2)");
    expect(container.textContent).toContain("Initial scaffolding");
  });
});

describe("ReviewList", () => {
  it("keep and undo call the api", async () => {
    const items = [entry(), entry()];
    const api = {
      review: vi.fn(async () => items),
      keep: vi.fn(async () => ({ kept: 1 })),
      undo: vi.fn(async (id: string) => ({ undone: { ...items.find((e) => e.id === id)!, status: "rejected" } })),
    } as unknown as Api;
    render(
      <I18nProvider lang="en">
        <ReviewList api={api} project={undefined} refresh={0} onChanged={() => {}} />
      </I18nProvider>,
    );
    await screen.findByText(items[0].title);
    fireEvent.click(screen.getAllByRole("button", { name: "Keep" })[0]);
    await waitFor(() => expect(api.keep).toHaveBeenCalledWith([items[0].id]));
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    await waitFor(() => expect(api.undo).toHaveBeenCalled());
  });

  it("renders nothing when nothing waits", async () => {
    const api = { review: vi.fn(async () => []) } as unknown as Api;
    const { container } = render(
      <I18nProvider lang="en">
        <ReviewList api={api} project={undefined} refresh={0} onChanged={() => {}} />
      </I18nProvider>,
    );
    await waitFor(() => expect(api.review).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("automatic saving in the panel", () => {
  it("the card shows the latest request and marks a task only the tool saved", () => {
    const { container } = render(
      <I18nProvider lang="tr">
        <ContinueCard handoff={handoff({ requests: ["Arama ekle", "devam et"], agentAt: null })} onCopy={() => {}} onDone={() => {}} />
      </I18nProvider>,
    );
    expect(container.textContent).toContain("İstenen");
    expect(container.textContent).toContain("devam et");
    expect(container.textContent).toContain("Otomatik kaydedildi");
  });

  it("an agent checkpoint removes the automatic mark", () => {
    const { container } = render(
      <I18nProvider lang="tr">
        <ContinueCard handoff={handoff({ requests: ["x"], agentAt: Date.now() })} onCopy={() => {}} onDone={() => {}} />
      </I18nProvider>,
    );
    expect(container.textContent).not.toContain("Otomatik kaydedildi");
  });

  it("the switch turns it off without asking", async () => {
    const api = { capture: vi.fn(async () => true), setCapture: vi.fn(async (_k: string, on: boolean) => on) } as unknown as Api;
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(
      <I18nProvider lang="en">
        <AutoCaptureSwitch api={api} projectKey="p" />
      </I18nProvider>,
    );
    const sw = await screen.findByRole("switch", { name: "Automatic saving" });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(sw);
    await waitFor(() => expect(api.setCapture).toHaveBeenCalledWith("p", false));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("no repeated request on the card", () => {
  it("İstenen is hidden when it equals the title", () => {
    const { container } = render(
      <I18nProvider lang="tr">
        <ContinueCard handoff={handoff({ goal: "Fatura PDF ekle", requests: ["Fatura PDF ekle"], agentAt: null })} onCopy={() => {}} onDone={() => {}} />
      </I18nProvider>,
    );
    expect(container.textContent).not.toContain("İstenen");
    expect(container.textContent).toContain("Otomatik kaydedildi");
  });
});

describe("project setting refresh", () => {
  it.each(["capture", "autonomous"] as const)("ignores stale %s replies and shows read failures", async (method) => {
    const read = vi.fn();
    const stale = Promise.withResolvers<boolean>();
    read.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline"));
    const api = { [method]: read } as unknown as Api;
    const Switch = method === "capture" ? AutoCaptureSwitch : AutonomousSwitch;
    const view = (refresh: number) => <I18nProvider lang="en"><Switch api={api} projectKey="p" refresh={refresh} /></I18nProvider>;
    const panel = render(view(0));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    panel.rerender(view(1));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    await act(async () => { stale.resolve(false); await stale.promise; });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    panel.rerender(view(2));
    await screen.findByText("Setting unavailable");
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AutonomousSwitch", () => {
  it("autonomous switch asks to confirm", async () => {
    const api = { autonomous: vi.fn(async () => false), setAutonomous: vi.fn(async (_k: string, on: boolean) => on) } as unknown as Api;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(
      <I18nProvider lang="en">
        <AutonomousSwitch api={api} projectKey="p" />
      </I18nProvider>,
    );
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    expect(confirm).toHaveBeenCalled();
    expect(api.setAutonomous).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setAutonomous).toHaveBeenCalledWith("p", true));
  });
});

describe("ReviewList undo note", () => {
  it("says when the replaced record could not be restored", async () => {
    const { ToastProvider } = await import("../ui/src/toast.js");
    const items = [entry({ supersedes: "cold" })];
    const api = {
      review: vi.fn(async () => items),
      undo: vi.fn(async () => ({ undone: { ...items[0], status: "rejected" }, note: "cold was not restored because it changed since it was replaced" })),
    } as unknown as Api;
    render(
      <I18nProvider lang="en">
        <ToastProvider>
          <ReviewList api={api} project={undefined} refresh={0} onChanged={() => {}} />
        </ToastProvider>
      </I18nProvider>,
    );
    await screen.findByText(items[0].title);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/was not restored because it changed/)).toBeTruthy();
  });
});
