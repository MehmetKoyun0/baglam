import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api";
import { useI18n } from "../i18n";
import { useToast } from "../toast";

/** Per-project autonomous mode. Turning it on always asks first; turning it off never needs to. */
export function AutonomousSwitch(props: { api: Api; projectKey: string; refresh?: number; onChanged?: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);

  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setOn(null);
    setFailed(false);
    props.api.autonomous(props.projectKey).then((value) => {
      if (live) setOn(value);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [props.api, props.projectKey, props.refresh]);

  const toggle = () => {
    if (on === null) return;
    const next = !on;
    if (next && !confirm(t("auto.confirm"))) return;
    props.api
      .setAutonomous(props.projectKey, next)
      .then((v) => {
        setOn(v);
        props.onChanged?.();
      })
      .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"));
  };

  return (
    <div class="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={on === true}
        aria-label={t("auto.title")}
        class={`switch${on ? " on" : ""}`}
        disabled={on === null}
        onClick={toggle}
      >
        <span class="knob" />
      </button>
      <span>{failed ? t("setting.unavailable") : on === null ? t("loading") : on ? t("auto.on") : t("auto.off")}</span>
    </div>
  );
}
