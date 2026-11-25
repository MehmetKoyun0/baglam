import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api";
import type { Overview } from "./types";
import { I18nProvider, pickLanguage, translator, type Lang } from "./i18n";
import { ToastProvider } from "./toast";
import { Inbox } from "./screens/Inbox";
import { Records } from "./screens/Records";
import { Projects } from "./screens/Projects";
import { Settings } from "./screens/Settings";
import { ContinueSection } from "./components/ContinueSection";
import { ReviewList } from "./components/ReviewList";

type Screen = "inbox" | "records" | "projects" | "settings";
const SCREENS: Screen[] = ["inbox", "records", "projects", "settings"];

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: preferences just are not remembered */
    }
  },
};

const screenFromPath = (): Screen => {
  const s = location.pathname.replace(/^\//, "") as Screen;
  return SCREENS.includes(s) ? s : "inbox";
};

const ICONS: Record<Screen, string> = {
  inbox: "M4 13h4l2 3h4l2-3h4M5 5h14l1 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z",
  records: "M6 4h9l4 4v12H6zM14 4v5h5M9 13h7M9 17h7",
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
};

export function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = store.get("baglam.lang");
    return saved === "en" || saved === "tr" ? saved : pickLanguage(navigator.language);
  });
  const [screen, setScreen] = useState<Screen>(screenFromPath);
  const [project, setProject] = useState<string | undefined>(() => store.get("baglam.project") ?? undefined);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [expired, setExpired] = useState(false);
  const [offline, setOffline] = useState(false);
  const lastPending = useRef<number | null>(null);
  const t = translator(lang);

  useEffect(() => {
    document.documentElement.lang = lang;
    store.set("baglam.lang", lang);
  }, [lang]);

  useEffect(() => store.set("baglam.project", project ?? null), [project]);

  useEffect(() => {
    const onPop = () => setScreen(screenFromPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const expire = () => setExpired(true);
    window.addEventListener("baglam:unauthorized", expire);
    return () => window.removeEventListener("baglam:unauthorized", expire);
  }, []);

  useEffect(() => {
    api
      .overview()
      .then((o) => {
        setOverview(o);
        if (project && !o.projects.some((p) => p.key === project)) setProject(undefined);
        const prev = lastPending.current;
        if (prev !== null && o.pendingTotal > prev && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("Bağlam", { body: t("notify.new", { n: o.pendingTotal - prev }) });
        }
        lastPending.current = o.pendingTotal;
      })
      .catch(() => {});
  }, [refresh]);

  // Live updates: the server pushes "change" whenever anything is written (agents, CLI, other tabs).
  useEffect(() => {
    if (expired) return;
    const es = new EventSource("/api/events");
    es.addEventListener("change", () => setRefresh((n) => n + 1));
    let disconnected = false;
    es.onopen = () => {
      setOffline(false);
      if (disconnected) setRefresh((n) => n + 1);
      disconnected = false;
    };
    es.onerror = () => {
      disconnected = true;
      setOffline(true);
      void api.ping().catch(() => {});
    };
    return () => es.close();
  }, [expired]);

  const go = (s: Screen) => {
    if (s === screen) return;
    history.pushState(null, "", `/${s === "inbox" ? "" : s}`);
    setScreen(s);
  };
  const changed = () => setRefresh((n) => n + 1);
  const projects = overview?.projects ?? [];
  const pendingHere = project ? (projects.find((p) => p.key === project)?.pending ?? 0) : (overview?.pendingTotal ?? 0);
  const projectName = (key: string) => projects.find((p) => p.key === key)?.name ?? key.slice(0, 8);

  useEffect(() => {
    document.title = pendingHere ? `(${pendingHere}) Bağlam` : "Bağlam";
  }, [pendingHere]);

  if (expired) return <main><p role="alert">{t("session.expired")}</p></main>;

  return (
    <I18nProvider lang={lang}>
      <ToastProvider>
        <div class="shell">
          <aside class="rail">
            <div class="brand">
              <span class="logo" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="26" height="26" fill="none">
                  <defs>
                    <linearGradient id="baglam-lens" x1="12" y1="9" x2="20" y2="23" gradientUnits="userSpaceOnUse">
                      <stop stop-color="#958fff" />
                      <stop offset="1" stop-color="#3fd0c9" />
                    </linearGradient>
                  </defs>
                  <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="#111214" stroke="rgb(255 255 255 / 0.14)" />
                  <circle cx="12.5" cy="16" r="7" stroke="#f7f8f8" stroke-width="1.7" />
                  <circle cx="19.5" cy="16" r="7" stroke="#f7f8f8" stroke-width="1.7" />
                  <path d="M16 9.94 A7 7 0 0 1 16 22.06 A7 7 0 0 1 16 9.94 Z" fill="url(#baglam-lens)" />
                </svg>
              </span>
              <span>Bağlam</span>
            </div>
            <nav aria-label="Bağlam">
              {SCREENS.map((s) => (
                <a
                  key={s}
                  href={`/${s === "inbox" ? "" : s}`}
                  class={screen === s ? "active" : ""}
                  aria-current={screen === s ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    go(s);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path d={ICONS[s]} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
                  </svg>
                  <span>{t(`nav.${s}`)}</span>
                  {s === "inbox" && pendingHere > 0 && <span class="count">{pendingHere}</span>}
                </a>
              ))}
            </nav>
            {overview && <div class="user muted small">{overview.user}</div>}
          </aside>

          <main class="content">
            <div class="topbar">
              <label class="project-switch">
                <span class="muted small">{t("project.label")}</span>
                <select value={project ?? ""} onChange={(e) => setProject(e.currentTarget.value || undefined)}>
                  <option value="">{t("project.all")}</option>
                  {projects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                      {p.pending ? ` (${p.pending})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              {offline && <span class="offline">{t("live.offline")}</span>}
            </div>

            {screen === "inbox" && (
              <>
                <ContinueSection api={api} project={project} projectName={projectName} refresh={refresh} onChanged={changed} />
                <ReviewList api={api} project={project} refresh={refresh} onChanged={changed} />
                <Inbox api={api} project={project} refresh={refresh} onChanged={changed} />
              </>
            )}
            {screen === "records" && <Records api={api} project={project} refresh={refresh} onChanged={changed} />}
            {screen === "projects" && <Projects api={api} refresh={refresh} onChanged={changed} />}
            {screen === "settings" && (
              <Settings
                api={api}
                project={project}
                projectName={projectName}
                tools={overview?.tools ?? []}
                lang={lang}
                onLang={setLang}
                onChanged={changed}
                refresh={refresh}
              />
            )}
          </main>
        </div>
      </ToastProvider>
    </I18nProvider>
  );
}
