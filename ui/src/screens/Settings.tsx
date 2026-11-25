import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api";
import { KINDS, KNOWN_AGENTS, type Kind, type Tool, type TrustRule } from "../types";
import { relativeTime, useI18n, type Lang } from "../i18n";
import { useToast } from "../toast";
import { AutonomousSwitch } from "../components/AutonomousSwitch";
import { AutoCaptureSwitch } from "../components/AutoCaptureSwitch";

export function Settings(props: {
  api: Api;
  project: string | undefined;
  projectName: (key: string) => string;
  tools: Tool[];
  lang: Lang;
  onLang: (lang: Lang) => void;
  onChanged?: () => void;
  refresh: number;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [rules, setRules] = useState<TrustRule[]>([]);
  const [scope, setScope] = useState<"project" | "all">(props.project ? "project" : "all");
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [perm, setPerm] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  const load = () =>
    props.api
      .trust(props.project)
      .then(setRules)
      .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"));
  useEffect(() => {
    setScope(props.project ? "project" : "all");
    void load();
  }, [props.project, props.refresh]);

  const describe = (r: { agent: string | null; kind: Kind | null; projectId: string | null }) =>
    t("settings.trust.preview", {
      what: r.kind ? t("settings.trust.records", { kind: t(`kind.${r.kind}`).toLocaleLowerCase(props.lang) }) : t("settings.trust.allRecords"),
      who: r.agent ? t("settings.trust.fromAgent", { agent: r.agent }) : t("settings.trust.anyAgent"),
      where: r.projectId ? `${t("settings.trust.whereProject")} (${props.projectName(r.projectId)})` : t("settings.trust.whereAll"),
    });

  const draft = { agent: agent || null, kind: kind || null, projectId: scope === "project" ? (props.project ?? null) : null };
  const canAdd = (agent || kind) && (scope === "all" || props.project);

  return (
    <section class="settings">
      <div class="screen-head">
        <h1>{t("settings.title")}</h1>
      </div>

      <div class="panel">
        <h2>{t("capture.title")}</h2>
        <p class="muted">{t("capture.body")}</p>
        {props.project ? (
          <AutoCaptureSwitch key={props.project} api={props.api} refresh={props.refresh} projectKey={props.project} />
        ) : (
          <p class="muted small">{t("auto.pickProject")}</p>
        )}
      </div>

      <div class="panel">
        <h2>{t("auto.title")}</h2>
        <p class="muted">{t("auto.body")}</p>
        {props.project ? (
          <AutonomousSwitch onChanged={props.onChanged} key={props.project} api={props.api} refresh={props.refresh} projectKey={props.project} />
        ) : (
          <p class="muted small">{t("auto.pickProject")}</p>
        )}
      </div>

      <div class="panel">
        <h2>{t("settings.trust.title")}</h2>
        <p class="muted">{t("settings.trust.intro")}</p>
        {rules.length === 0 ? (
          <p class="muted small">{t("settings.trust.empty")}</p>
        ) : (
          <ul class="rules">
            {rules.map((r) => (
              <li key={r.id}>
                <span>{describe(r)}</span>
                <button
                  class="btn btn-quiet"
                  onClick={() =>
                    props.api
                      .removeTrust(r.id)
                      .then(load)
                      .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"))
                  }
                >
                  {t("action.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          class="rule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAdd) return;
            props.api
              .addTrust({ projectId: draft.projectId, agent: agent || undefined, kind: kind || undefined })
              .then(() => {
                setAgent("");
                setKind("");
                toast(t("toast.saved"));
                return load();
              })
              .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"));
          }}
        >
          <div class="row wrap">
            <label class="field">
              <span>{t("field.agent")}</span>
              <select value={agent} onChange={(e) => setAgent(e.currentTarget.value)}>
                <option value="">{t("field.anyAgent")}</option>
                {KNOWN_AGENTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>{t("field.kind")}</span>
              <select value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind | "")}>
                <option value="">{t("field.anyKind")}</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>{t("project.label")}</span>
              <select value={scope} onChange={(e) => setScope(e.currentTarget.value as "project" | "all")}>
                <option value="project" disabled={!props.project}>
                  {t("settings.trust.scopeProject")}
                </option>
                <option value="all">{t("settings.trust.scopeAll")}</option>
              </select>
            </label>
          </div>
          <p class="preview">{agent || kind ? describe(draft) : t("settings.trust.needOne")}</p>
          {scope === "project" && !props.project && <p class="muted small">{t("settings.trust.needProject")}</p>}
          <button class="btn btn-primary" type="submit" disabled={!canAdd}>
            {t("action.add")}
          </button>
        </form>
      </div>

      <div class="panel">
        <h2>{t("settings.tools.title")}</h2>
        {props.tools.length === 0 ? (
          <p class="muted small">{t("settings.tools.none")}</p>
        ) : (
          <ul class="tools">
            {props.tools.map((tool) => {
              const hookLabel = !tool.autoSave
                ? null
                : tool.autoSave.problem
                  ? t("settings.tools.hooksProblem")
                  : !tool.autoSave.installed
                    ? t("settings.tools.hooksMissing")
                    : tool.autoSave.lastSeen
                      ? t("settings.tools.hooksOk", { when: relativeTime(t, tool.autoSave.lastSeen) })
                      : t("settings.tools.hooksReady");
              return (
                <li key={tool.id}>
                  <span class={`dot ${tool.registered ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
                  <strong>{tool.label}</strong>
                  <span class="muted small">
                    {tool.registered ? t("settings.tools.connected") : t("settings.tools.missing")}
                    {hookLabel ? ` · ${hookLabel}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div class="panel">
        <h2>{t("settings.notify.title")}</h2>
        <p class="muted">{t("settings.notify.body")}</p>
        {perm === "granted" ? (
          <p class="small">{t("settings.notify.on")}</p>
        ) : perm === "denied" ? (
          <p class="small">{t("settings.notify.blocked")}</p>
        ) : perm === "default" ? (
          <button class="btn" onClick={() => Notification.requestPermission().then(setPerm)}>
            {t("settings.notify.enable")}
          </button>
        ) : null}
      </div>

      <div class="panel">
        <h2>{t("settings.language")}</h2>
        <div class="segmented" role="radiogroup" aria-label={t("settings.language")}>
          {(["tr", "en"] as Lang[]).map((l) => (
            <button key={l} role="radio" aria-checked={props.lang === l} class={props.lang === l ? "on" : ""} onClick={() => props.onLang(l)}>
              {l === "tr" ? "Türkçe" : "English"}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
