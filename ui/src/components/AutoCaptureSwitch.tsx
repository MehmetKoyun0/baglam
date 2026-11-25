import { useEffect, useState } from "preact/hooks";
import type { Api } from "../api";
import { useI18n } from "../i18n";
import { useToast } from "../toast";

/** Per-project automatic saving from tool hooks. On by default; switching needs no confirmation. */
export function AutoCaptureSwitch(props: { api: Api; projectKey: string; refresh?: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);

  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setOn(null);
    setFailed(false);
    props.api.capture(props.projectKey).then((value) => {
      if (live) setOn(value);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [props.api, props.projectKey, props.refresh]);

  const toggle = () => {
    if (on === null) return;
    props.api
      .setCapture(props.projectKey, !on)
      .then(setOn)
      .catch((err: Error) => toast(t("toast.error", { msg: err.message }), "error"));
  };

  return (
    <div class="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={on === true}
        aria-label={t("capture.title")}
        class={`switch${on ? " on" : ""}`}
        disabled={on === null}
        onClick={toggle}
      >
        <span class="knob" />
      </button>
      <span>{failed ? t("setting.unavailable") : on === null ? t("loading") : on ? t("capture.on") : t("capture.off")}</span>
    </div>
  );
}
