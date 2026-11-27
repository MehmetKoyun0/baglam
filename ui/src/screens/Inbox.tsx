import { useEffect, useRef, useState } from "preact/hooks";
import type { Api } from "../api";
import { ApiError } from "../api";
import type { EntryPatch, PendingEntry, SecretFinding } from "../types";
import { useI18n } from "../i18n";
import { useToast } from "../toast";
import { EntryCard } from "../components/EntryCard";
import { EditForm } from "../components/EditForm";
import { FlowMark } from "../components/FlowMark";

type Mode = { kind: "idle" } | { kind: "edit"; secrets?: SecretFinding[] } | { kind: "reject"; id: string; note: string };

const typingIn = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

export function Inbox(props: { api: Api; project: string | undefined; refresh: number; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [items, setItems] = useState<PendingEntry[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let live = true;
    props.api
      .pending(props.project)
      .then((list) => {
        if (!live) return;
        setItems(list);
        setSelected((s) => Math.min(s, Math.max(0, list.length - 1)));
      })
      .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"));
    return () => {
      live = false;
    };
  }, [props.project, props.refresh]);

  const current = items?.[selected];

  useEffect(() => {
    if (mode.kind === "reject" && current?.id !== mode.id) setMode({ kind: "idle" });
  }, [current?.id, mode]);

  async function act(fn: () => Promise<unknown>, done: string, id = current?.id) {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setMode({ kind: "idle" });
      setItems((list) => list?.filter((e) => e.id !== id) ?? null);
      props.onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.data.secrets)) {
        setMode({ kind: "edit", secrets: err.data.secrets as SecretFinding[] });
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // The CLI, another panel or an agent's trust rule got there first.
        toast(t("toast.decidedElsewhere"));
        setMode({ kind: "idle" });
        setItems((list) => list?.filter((e) => e.id !== id) ?? null);
        props.onChanged();
      } else {
        toast(t("toast.error", { msg: (err as Error).message }), "error");
      }
    } finally {
      setBusy(false);
    }
  }

  const reject = () => current && mode.kind === "reject" && mode.id === current.id && act(() => props.api.reject(current.id, mode.note.trim() || undefined), t("toast.rejected"));
  const saveEdit = (patch: EntryPatch, force: boolean) =>
    current && act(() => props.api.edit(current.id, patch, force ? { approve: true, force: true } : { approve: true }), t("toast.approved"));

  // Keys can arrive faster than re-renders, so the handler reads live state from a ref
  // (a stale closure would approve the wrong card).
  const live = useRef({ items, selected, mode, busy, act, t });
  live.current = { items, selected, mode, busy, act, t };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const s = live.current;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || s.busy) return;
      if (s.mode.kind !== "idle") {
        if (ev.key === "Escape") setMode({ kind: "idle" });
        return;
      }
      if (typingIn(ev.target)) return;
      const list = s.items;
      if (!list?.length) return;
      const move = (to: number) => {
        selectedRef.current = Math.max(0, Math.min(to, list.length - 1));
        setSelected(selectedRef.current);
      };
      if (ev.key === "j" || ev.key === "ArrowDown") move(selectedRef.current + 1);
      else if (ev.key === "k" || ev.key === "ArrowUp") move(selectedRef.current - 1);
      else if (ev.key === "a") {
        const target = list[selectedRef.current];
        if (target) s.act(() => props.api.approve(target.id, undefined), s.t("toast.approved"), target.id);
      } else if (ev.key === "e") setMode({ kind: "edit" });
      else if (ev.key === "r") setMode({ kind: "reject", id: list[selectedRef.current].id, note: "" });
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.api]);

  useEffect(() => {
    cardRefs.current[selected]?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  if (items === null) return <p class="muted">{t("loading")}</p>;

  return (
    <section>
      <div class="screen-head">
        <div>
          <h1>{t("inbox.title")}</h1>
          <p class="muted">{t("inbox.subtitle")}</p>
        </div>
        {items.length > 1 &&
          (props.project ? (
            <button
              class="btn"
              disabled={busy}
              onClick={() => {
                if (!confirm(t("inbox.approveAllConfirm", { n: items.length }))) return;
                setBusy(true);
                props.api
                  .approveAll(items.map((e) => e.id))
                  .then((r) => {
                    toast(r.skipped ? t("toast.approvedSome", { n: r.approved, skipped: r.skipped }) : t("toast.approvedAll", { n: r.approved }));
                    setItems([]);
                    props.onChanged();
                  })
                  .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"))
                  .finally(() => setBusy(false));
              }}
            >
              {t("inbox.approveAll", { n: items.length })}
            </button>
          ) : (
            <span class="muted small">{t("inbox.pickProject")}</span>
          ))}
      </div>

      {items.length === 0 ? (
        <div class="empty">
          <FlowMark />
          <h2>{t("inbox.empty.title")}</h2>
          <p class="muted">{t("inbox.empty.body")}</p>
        </div>
      ) : (
        <>
          <p class="muted small keys">{t("keys.hint")}</p>
          <div class="list">
            {items.map((e, i) => (
              <div key={e.id} ref={(el) => {
                  cardRefs.current[i] = el;
                }}>
                <EntryCard
                  entry={e}
                  selected={i === selected}
                  onSelect={() => {
                    if (i !== selected) {
                      setSelected(i);
                      setMode({ kind: "idle" });
                    }
                  }}
                >
                  {i === selected && mode.kind === "edit" ? (
                    <EditForm
                      entry={e}
                      busy={busy}
                      secrets={mode.secrets}
                      submitLabel={t("action.saveApprove")}
                      onSubmit={saveEdit}
                      onCancel={() => setMode({ kind: "idle" })}
                    />
                  ) : i === selected && mode.kind === "reject" && mode.id === e.id ? (
                    <form
                      class="reject"
                      onClick={(ev) => ev.stopPropagation()}
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        reject();
                      }}
                    >
                      <label class="field">
                        <span>{t("field.reason")}</span>
                        <input value={mode.note} autoFocus onInput={(ev) => setMode({ ...mode, note: ev.currentTarget.value })} />
                      </label>
                      <div class="actions">
                        <button type="submit" class="btn btn-danger" disabled={busy}>
                          {t("action.reject")}
                        </button>
                        <button type="button" class="btn" onClick={() => setMode({ kind: "idle" })}>
                          {t("action.cancel")}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div class="actions" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        class="btn btn-primary"
                        disabled={busy}
                        onClick={() => {
                          setSelected(i);
                          act(() => props.api.approve(e.id, undefined), t("toast.approved"), e.id);
                        }}
                      >
                        {t("action.approve")}
                      </button>
                      <button
                        class="btn"
                        onClick={() => {
                          setSelected(i);
                          setMode({ kind: "edit" });
                        }}
                      >
                        {t("action.editApprove")}
                      </button>
                      <button
                        class="btn btn-quiet"
                        onClick={() => {
                          setSelected(i);
                          setMode({ kind: "reject", id: e.id, note: "" });
                        }}
                      >
                        {t("action.reject")}
                      </button>
                    </div>
                  )}
                </EntryCard>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
