import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Api, RecordQuery } from "../api";
import { ApiError } from "../api";
import { KINDS, KNOWN_AGENTS, type Entry, type EntryPatch, type HistoryEvent, type SecretFinding } from "../types";
import { historyLabel, relativeTime, useI18n } from "../i18n";
import { useToast } from "../toast";
import { EntryCard } from "../components/EntryCard";
import { EditForm } from "../components/EditForm";
import { FlowMark } from "../components/FlowMark";

const PAGE = 30;
const STATUS_FILTERS = ["active", "proposed", "rejected", "superseded", "retired"] as const;

export function Records(props: { api: Api; project: string | undefined; refresh: number; onChanged: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<RecordQuery["kind"]>("");
  const [status, setStatus] = useState<RecordQuery["status"]>("active");
  const [agent, setAgent] = useState("");
  const [items, setItems] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<{ id: string; events: HistoryEvent[] } | null>(null);
  const latest = useRef(0);
  const [editing, setEditing] = useState<{ id: string; secrets?: SecretFinding[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (offset = 0) => {
    const request = ++latest.current;
    return props.api
      .records({ project: props.project, q, kind, status, agent, limit: PAGE, offset })
      .then((r) => {
        if (request !== latest.current) return;
        setItems((prev) => (offset ? [...(prev ?? []), ...r.items] : r.items));
        setTotal(r.total);
      })
      .catch((err: Error) => {
        if (request === latest.current) toast(t("toast.error", { msg: err.message }), "error");
      });
  };

  useLayoutEffect(() => {
    setItems(null);
    const timer = setTimeout(() => load(0), q ? 200 : 0);
    return () => { clearTimeout(timer); latest.current++; };
  }, [props.project, props.refresh, q, kind, status, agent]);

  useLayoutEffect(() => {
    let current = true;
    setHistory(null);
    if (!open) return;
    props.api.entry(open).then((d) => {
      if (current) setHistory({ id: open, events: d.history });
    }).catch(() => {});
    return () => { current = false; };
  }, [open, props.project, props.refresh]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setEditing(null);
      props.onChanged();

    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && Array.isArray(err.data.secrets) && editing) {
        setEditing({ id: editing.id, secrets: err.data.secrets as SecretFinding[] });
      } else toast(t("toast.error", { msg: (err as Error).message }), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div class="screen-head">
        <div>
          <h1>{t("records.title")}</h1>
          <p class="muted">{t("records.subtitle")}</p>
        </div>
      </div>
      <div class="filters">
        <input
          class="search"
          type="search"
          placeholder={t("field.search")}
          aria-label={t("field.search")}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <select aria-label={t("field.status")} value={status} onChange={(e) => setStatus(e.currentTarget.value as RecordQuery["status"])}>
          <option value="">{t("field.anyStatus")}</option>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </select>
        <select aria-label={t("field.kind")} value={kind} onChange={(e) => setKind(e.currentTarget.value as RecordQuery["kind"])}>
          <option value="">{t("field.anyKind")}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
        <select aria-label={t("field.agent")} value={agent} onChange={(e) => setAgent(e.currentTarget.value)}>
          <option value="">{t("field.anyAgent")}</option>
          {KNOWN_AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {items === null ? (
        <p class="muted">{t("loading")}</p>
      ) : items.length === 0 ? (
        <div class="empty small-empty">
          <FlowMark />
          <p class="muted">{t("records.empty")}</p>
        </div>
      ) : (
        <>
          <p class="muted small">{t("records.count", { n: total })}</p>
          <div class="list">
            {items.map((e) => (
              <EntryCard key={e.id} entry={e}>
                {editing?.id === e.id ? (
                  <EditForm
                    entry={e}
                    busy={busy}
                    secrets={editing.secrets}
                    submitLabel={t("action.save")}
                    onSubmit={(patch: EntryPatch, force) => run(() => props.api.edit(e.id, patch, { force }), t("toast.saved"))}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div class="actions">
                    <button class="btn btn-quiet" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      {open === e.id ? t("action.hide") : t("action.details")}
                    </button>
                    {(e.status === "approved" || e.status === "proposed") && (
                      <button class="btn btn-quiet" onClick={() => setEditing({ id: e.id })}>
                        {t("action.edit")}
                      </button>
                    )}
                    {e.status === "approved" && (
                      <button class="btn btn-quiet" disabled={busy} onClick={() => run(() => props.api.retire(e.id), t("toast.retired"))}>
                        {t("action.retire")}
                      </button>
                    )}
                    <code class="id">{e.id}</code>
                  </div>
                )}
                {open === e.id && (
                  <ol class="history" aria-label={t("records.history")}>
                    {(history?.id === open ? history?.events ?? [] : []).map((h, i) => (
                      <li key={i}>
                        <span class="history-actor">{h.actor}</span> {historyLabel(t, h.type)}
                        {h.detail ? <span class="muted"> · {h.detail}</span> : null}
                        <span class="muted"> · {relativeTime(t, h.at)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </EntryCard>
            ))}
          </div>
          {items.length < total && (
            <button class="btn more" onClick={() => load(items.length)}>
              {t("action.loadMore")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
