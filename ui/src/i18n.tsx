import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

export type Lang = "tr" | "en";

const en = {
  "nav.inbox": "Inbox",
  "nav.records": "Records",
  "nav.projects": "Projects",
  "nav.settings": "Settings",
  "project.all": "All projects",
  "project.label": "Project",

  "inbox.title": "Waiting for review",
  "inbox.subtitle": "Agents proposed these. Nothing reaches other agents until you approve it.",
  "inbox.empty.title": "Nothing to review",
  "inbox.empty.body":
    "When an agent proposes a decision, convention or warning, it shows up here. Agents in folders where you ran baglam init do this on their own.",
  "inbox.approveAll": "Approve all ({n})",
  "inbox.approveAllConfirm": "Approve all {n} proposals in this project?",
  "inbox.pickProject": "Choose a project to approve everything at once.",
  "keys.hint": "Shortcuts: j / k move · a approve · e edit · r reject",

  "action.approve": "Approve",
  "action.editApprove": "Edit & approve",
  "action.reject": "Reject",
  "action.save": "Save",
  "action.saveApprove": "Save & approve",
  "action.cancel": "Cancel",
  "action.saveAnyway": "Save anyway",
  "action.retire": "Retire",
  "action.edit": "Edit",
  "action.rename": "Rename",
  "action.archive": "Archive",
  "action.restore": "Restore",
  "action.delete": "Delete permanently",
  "action.add": "Add rule",
  "action.remove": "Remove",
  "action.details": "Details",
  "action.hide": "Hide",
  "action.loadMore": "Load more",

  "field.title": "Title",
  "field.body": "Content",
  "field.rationale": "Why",
  "field.kind": "Kind",
  "field.reason": "Reason (optional)",
  "field.search": "Search records…",
  "field.agent": "Agent",
  "field.status": "Status",
  "field.name": "Name",
  "field.anyKind": "Any kind",
  "field.anyAgent": "Any agent",
  "field.anyStatus": "Any status",

  "kind.decision": "Decision",
  "kind.convention": "Convention",
  "kind.preference": "Preference",
  "kind.fact": "Fact",
  "kind.warning": "Warning",

  "status.active": "Active",
  "status.proposed": "Pending",
  "status.approved": "Approved",
  "status.rejected": "Rejected",
  "status.superseded": "Replaced",
  "status.retired": "Retired",

  "card.from": "from {agent}",
  "card.why": "Why",
  "card.similar": "Looks similar to",
  "card.auto": "auto-approved",
  "card.replaces": "Replaces {id}",
  "card.onlyFor": "Only for {agents}",
  "card.expires": "Expires {when}",

  "secret.warning": "This looks like it contains a secret: {list}. Everything in Bağlam is shown to your AI agents.",

  "toast.approved": "Approved and shared with your agents",
  "toast.approvedAll": "{n} proposals approved",
  "toast.approvedSome": "{n} approved; {skipped} were already decided elsewhere",
  "toast.decidedElsewhere": "Already decided elsewhere; removed from the list.",
  "toast.rejected": "Rejected",
  "toast.saved": "Saved",
  "toast.retired": "Retired; agents no longer see it",
  "toast.error": "Something went wrong: {msg}",

  "records.title": "Records",
  "records.subtitle": "Everything Bağlam knows, with its history.",
  "records.empty": "No records match.",
  "records.count": "{n} records",
  "records.history": "History",

  "history.proposed": "proposed",
  "history.approved": "approved",
  "history.rejected": "rejected",
  "history.superseded": "replaced",
  "history.edited": "edited",
  "history.retired": "retired",
  "history.deleted": "deleted",
  "history.expired": "expired",
  "history.archived": "archived",
  "history.restored": "restored",
  "history.imported": "imported",

  "projects.title": "Projects",
  "projects.subtitle": "Each folder where agents work is a project.",
  "projects.empty": "No projects yet. Run baglam init in a project folder.",
  "projects.showArchived": "Show archived",
  "projects.archived": "Archived",
  "projects.counts": "{active} active · {pending} pending",
  "projects.lastActivity": "Last activity {when}",
  "projects.notInit": "Not initialised: run baglam init in its folder to rename or archive it.",
  "projects.deleteConfirm": "Type “{name}” to delete this project and all its records. History is kept.",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.trust.title": "Trust rules",
  "settings.trust.intro":
    "By default every proposal waits for you. A trust rule lets matching records skip review. Secrets are always blocked, and look-alikes or replacements still come to you.",
  "settings.trust.empty": "No trust rules. Every proposal waits for your review.",
  "settings.trust.scopeProject": "This project",
  "settings.trust.scopeAll": "All projects",
  "settings.trust.preview": "Auto-approve {what} from {who} in {where}.",
  "settings.trust.allRecords": "all records",
  "settings.trust.records": "{kind} records",
  "settings.trust.anyAgent": "any agent",
  "settings.trust.fromAgent": "{agent}",
  "settings.trust.whereProject": "this project",
  "settings.trust.whereAll": "all projects",
  "settings.trust.needOne": "Choose an agent or a kind.",
  "settings.trust.needProject": "Choose a project at the top to make a rule for it.",
  "settings.tools.title": "Connected tools",
  "settings.tools.connected": "Connected",
  "settings.tools.missing": "Not connected. Run baglam setup.",
  "settings.tools.none": "No AI tools found on this computer.",
  "settings.notify.title": "Desktop notifications",
  "settings.notify.body": "Get a notification when an agent proposes something while this page is open.",
  "settings.notify.enable": "Turn on notifications",
  "settings.notify.on": "Notifications are on.",
  "settings.notify.blocked": "Notifications are blocked for this page in your browser settings.",

  "time.justNow": "just now",
  "time.minutes": "{n} min ago",
  "time.hours": "{n} h ago",
  "time.days": "{n} d ago",
  "time.inDays": "in {n} d",

  "live.offline": "Connection lost. Retrying…",
  "notify.new": "{n} new proposal(s) to review",
  "session.expired": "Your panel session has expired. Run baglam ui in a terminal to sign in again.",
  "setting.unavailable": "Setting unavailable",
  "loading": "Loading…",
  "continue.title": "Continue from here",
  "continue.subtitle": "Work in progress, saved by your agents as they go. Any agent can pick it up.",
  "continue.by": "{agent} · {when}",
  "continue.branch": "branch {branch}",
  "continue.done": "Done",
  "continue.now": "Now",
  "continue.next": "Next",
  "continue.files": "Files",
  "continue.blockers": "Blocked by",
  "continue.notes": "Notes",
  "continue.blocked": "blocked",
  "continue.copy": "Copy resume prompt",
  "continue.copied": "Resume prompt copied. Paste it into any AI tool.",
  "continue.markDone": "Mark done",
  "continue.markedDone": "Task marked as done",
  "review.title": "Shared automatically",
  "review.subtitle": "Autonomous mode shared these at once. Keep them, or undo any you disagree with.",
  "review.keep": "Keep",
  "review.keepAll": "Keep all ({n})",
  "review.undo": "Undo",
  "review.kept": "Kept",
  "review.undone": "Undone; agents no longer see it",
  "review.restored": "Undone, and the record it replaced is back",
  "review.notRestored": "Undone; {note}.",
  "auto.title": "Autonomous mode",
  "auto.body": "On: records from agents connected by baglam setup are shared at once, and you review them afterwards in the Inbox. Secrets stay blocked, the proposal limit stays, and anything you rejected before still waits for you.",
  "auto.confirm": "Turn on autonomous mode for this project? Agents' records will be shared before you review them.",
  "auto.on": "On",
  "auto.off": "Off",
  "auto.pickProject": "Choose a project at the top to change its mode.",
  "auto.badge": "Autonomous",
  "capture.title": "Automatic saving",
  "capture.body": "Your requests, the files agents edit and their last reply are saved to the task in progress by each tool's own hooks, even when the agent forgets. Stored only on this computer; secrets are hidden.",
  "capture.on": "On: requests, edited files and the last reply are saved by themselves",
  "capture.off": "Off",
  "continue.asked": "Asked",
  "continue.auto": "Saved automatically",
  "continue.fullRequest": "Full request",
  "continue.history": "Recent checkpoints ({n})",
  "settings.tools.hooksOk": "auto-save active ({when})",
  "settings.tools.hooksReady": "auto-save installed",
  "settings.tools.hooksMissing": "auto-save not installed",
  "settings.tools.hooksProblem": "auto-save error",
  "projects.task": "In progress: {goal} ({agent})",
};

type Key = keyof typeof en;

const tr: Record<Key, string> = {
  "nav.inbox": "Gelen kutusu",
  "nav.records": "Kayıtlar",
  "nav.projects": "Projeler",
  "nav.settings": "Ayarlar",
  "project.all": "Tüm projeler",
  "project.label": "Proje",

  "inbox.title": "Onay bekleyenler",
  "inbox.subtitle": "Bunları ajanlar önerdi. Sen onaylamadan hiçbiri diğer ajanlara ulaşmaz.",
  "inbox.empty.title": "Onaylanacak bir şey yok",
  "inbox.empty.body":
    "Bir ajan karar, kural ya da uyarı önerdiğinde burada görünür. baglam init çalıştırdığın klasörlerdeki ajanlar bunu kendiliğinden yapar.",
  "inbox.approveAll": "Hepsini onayla ({n})",
  "inbox.approveAllConfirm": "Bu projedeki {n} önerinin hepsi onaylansın mı?",
  "inbox.pickProject": "Hepsini birden onaylamak için bir proje seç.",
  "keys.hint": "Kısayollar: j / k gezin · a onayla · e düzenle · r reddet",

  "action.approve": "Onayla",
  "action.editApprove": "Düzenle ve onayla",
  "action.reject": "Reddet",
  "action.save": "Kaydet",
  "action.saveApprove": "Kaydet ve onayla",
  "action.cancel": "Vazgeç",
  "action.saveAnyway": "Yine de kaydet",
  "action.retire": "Kaldır",
  "action.edit": "Düzenle",
  "action.rename": "Yeniden adlandır",
  "action.archive": "Arşivle",
  "action.restore": "Geri getir",
  "action.delete": "Kalıcı olarak sil",
  "action.add": "Kural ekle",
  "action.remove": "Kaldır",
  "action.details": "Ayrıntılar",
  "action.hide": "Gizle",
  "action.loadMore": "Daha fazla",

  "field.title": "Başlık",
  "field.body": "İçerik",
  "field.rationale": "Neden",
  "field.kind": "Tür",
  "field.reason": "Sebep (isteğe bağlı)",
  "field.search": "Kayıtlarda ara…",
  "field.agent": "Ajan",
  "field.status": "Durum",
  "field.name": "Ad",
  "field.anyKind": "Her tür",
  "field.anyAgent": "Her ajan",
  "field.anyStatus": "Her durum",

  "kind.decision": "Karar",
  "kind.convention": "Kural",
  "kind.preference": "Tercih",
  "kind.fact": "Bilgi",
  "kind.warning": "Uyarı",

  "status.active": "Geçerli",
  "status.proposed": "Bekliyor",
  "status.approved": "Onaylı",
  "status.rejected": "Reddedildi",
  "status.superseded": "Yerine yenisi geldi",
  "status.retired": "Kaldırıldı",

  "card.from": "{agent} önerdi",
  "card.why": "Neden",
  "card.similar": "Şuna benziyor",
  "card.auto": "otomatik onaylandı",
  "card.replaces": "{id} kaydının yerine geçer",
  "card.onlyFor": "Sadece {agents} görür",
  "card.expires": "{when} sona erer",

  "secret.warning": "Bu metin gizli bilgi içeriyor gibi görünüyor: {list}. Bağlam'daki her şey yapay zekâ ajanlarına gösterilir.",

  "toast.approved": "Onaylandı ve ajanlarla paylaşıldı",
  "toast.approvedAll": "{n} öneri onaylandı",
  "toast.approvedSome": "{n} öneri onaylandı; {skipped} tanesi için başka bir yerde karar verilmişti",
  "toast.decidedElsewhere": "Bu öneri için başka bir yerde karar verilmiş; listeden kaldırıldı.",
  "toast.rejected": "Reddedildi",
  "toast.saved": "Kaydedildi",
  "toast.retired": "Kaldırıldı; ajanlar artık görmüyor",
  "toast.error": "Bir şeyler ters gitti: {msg}",

  "records.title": "Kayıtlar",
  "records.subtitle": "Bağlam'ın bildiği her şey, geçmişiyle birlikte.",
  "records.empty": "Eşleşen kayıt yok.",
  "records.count": "{n} kayıt",
  "records.history": "Geçmiş",

  "history.proposed": "önerdi",
  "history.approved": "onayladı",
  "history.rejected": "reddetti",
  "history.superseded": "yenisiyle değiştirdi",
  "history.edited": "düzenledi",
  "history.retired": "kaldırdı",
  "history.deleted": "sildi",
  "history.expired": "süresi doldu",
  "history.archived": "arşivledi",
  "history.restored": "geri getirdi",
  "history.imported": "içe aktardı",

  "projects.title": "Projeler",
  "projects.subtitle": "Ajanların çalıştığı her klasör bir projedir.",
  "projects.empty": "Henüz proje yok. Bir proje klasöründe baglam init çalıştır.",
  "projects.showArchived": "Arşivdekileri göster",
  "projects.archived": "Arşivde",
  "projects.counts": "{active} geçerli · {pending} bekleyen",
  "projects.lastActivity": "Son hareket {when}",
  "projects.notInit": "Tanıtılmamış: yeniden adlandırmak ya da arşivlemek için klasöründe baglam init çalıştır.",
  "projects.deleteConfirm": "Bu projeyi ve tüm kayıtlarını silmek için “{name}” yaz. Geçmiş saklanır.",

  "settings.title": "Ayarlar",
  "settings.language": "Dil",
  "settings.trust.title": "Güven kuralları",
  "settings.trust.intro":
    "Varsayılan olarak her öneri senin onayını bekler. Güven kuralı, eşleşen kayıtların onay beklemeden paylaşılmasını sağlar. Gizli bilgiler her zaman engellenir; benzer kayıtlar ve bir kaydın yerine geçenler yine sana gelir.",
  "settings.trust.empty": "Güven kuralı yok. Her öneri senin onayını bekler.",
  "settings.trust.scopeProject": "Bu proje",
  "settings.trust.scopeAll": "Tüm projeler",
  "settings.trust.preview": "{where} içinde {who} gelen {what} otomatik onaylansın.",
  "settings.trust.allRecords": "tüm kayıtlar",
  "settings.trust.records": "{kind} kayıtları",
  "settings.trust.anyAgent": "herhangi bir ajandan",
  "settings.trust.fromAgent": "{agent} ajanından",
  "settings.trust.whereProject": "bu proje",
  "settings.trust.whereAll": "tüm projeler",
  "settings.trust.needOne": "Bir ajan ya da tür seç.",
  "settings.trust.needProject": "Projeye özel kural için yukarıdan bir proje seç.",
  "settings.tools.title": "Bağlı araçlar",
  "settings.tools.connected": "Bağlı",
  "settings.tools.missing": "Bağlı değil. baglam setup çalıştır.",
  "settings.tools.none": "Bu bilgisayarda yapay zekâ aracı bulunamadı.",
  "settings.notify.title": "Masaüstü bildirimleri",
  "settings.notify.body": "Bu sayfa açıkken bir ajan öneri yaptığında bildirim al.",
  "settings.notify.enable": "Bildirimleri aç",
  "settings.notify.on": "Bildirimler açık.",
  "settings.notify.blocked": "Bu sayfa için bildirimler tarayıcı ayarlarında engellenmiş.",

  "time.justNow": "az önce",
  "time.minutes": "{n} dk önce",
  "time.hours": "{n} sa önce",
  "time.days": "{n} gün önce",
  "time.inDays": "{n} gün içinde",

  "live.offline": "Bağlantı koptu. Yeniden deneniyor…",
  "notify.new": "Onay bekleyen {n} yeni öneri",
  "session.expired": "Panel oturumunuz sona erdi. Yeni bir oturum açmak için terminalde baglam ui çalıştırın.",
  "setting.unavailable": "Ayar okunamadı",
  "loading": "Yükleniyor…",
  "continue.title": "Buradan devam et",
  "continue.subtitle": "Ajanlarının çalışırken kaydettiği yarım işler. Herhangi bir ajan kaldığı yerden sürdürebilir.",
  "continue.by": "{agent} · {when}",
  "continue.branch": "{branch} dalı",
  "continue.done": "Bitenler",
  "continue.now": "Şu an",
  "continue.next": "Sıradaki",
  "continue.files": "Dosyalar",
  "continue.blockers": "Engel",
  "continue.notes": "Notlar",
  "continue.blocked": "engellendi",
  "continue.copy": "Devam metnini kopyala",
  "continue.copied": "Devam metni kopyalandı. Herhangi bir yapay zekâ aracına yapıştırabilirsin.",
  "continue.markDone": "Bitti olarak işaretle",
  "continue.markedDone": "Görev bitti olarak işaretlendi",
  "review.title": "Otomatik paylaşılanlar",
  "review.subtitle": "Otonom mod bunları hemen paylaştı. Tut ya da katılmadıklarını geri al.",
  "review.keep": "Tut",
  "review.keepAll": "Hepsini tut ({n})",
  "review.undo": "Geri al",
  "review.kept": "Tutuldu",
  "review.undone": "Geri alındı; ajanlar artık görmüyor",
  "review.restored": "Geri alındı ve yerine geçtiği kayıt geri geldi",
  "review.notRestored": "Geri alındı; yerine geçtiği kayıt sonradan değiştiği için geri getirilmedi.",
  "auto.title": "Otonom mod",
  "auto.body": "Açıkken baglam setup ile bağlanan ajanların kayıtları hemen paylaşılır, sen de onları sonradan Gelen kutusunda gözden geçirirsin. Gizli bilgi yine engellenir, öneri sınırı yine geçerlidir, daha önce reddettiğin şeyler yine sana gelir.",
  "auto.confirm": "Bu projede otonom mod açılsın mı? Ajanların kayıtları sen bakmadan paylaşılacak.",
  "auto.on": "Açık",
  "auto.off": "Kapalı",
  "auto.pickProject": "Modunu değiştirmek için yukarıdan bir proje seç.",
  "auto.badge": "Otonom",
  "capture.title": "Otomatik kayıt",
  "capture.body": "İsteklerin, ajanların değiştirdiği dosyalar ve son cevapları, her aracın kendi kancalarıyla devam eden göreve kaydedilir; ajan unutsa bile. Yalnızca bu bilgisayarda saklanır, gizli bilgiler gizlenir.",
  "capture.on": "Açık: istekler, değişen dosyalar ve son cevap kendiliğinden kaydedilir",
  "capture.off": "Kapalı",
  "continue.asked": "İstenen",
  "continue.auto": "Otomatik kaydedildi",
  "continue.fullRequest": "Tam istek",
  "continue.history": "Son kayıtlar ({n})",
  "settings.tools.hooksOk": "otomatik kayıt etkin ({when})",
  "settings.tools.hooksReady": "otomatik kayıt kurulu",
  "settings.tools.hooksMissing": "otomatik kayıt kurulu değil",
  "settings.tools.hooksProblem": "otomatik kayıt hatası",
  "projects.task": "Devam eden: {goal} ({agent})",
};

export const dict: Record<Lang, Record<Key, string>> = { en, tr };

export function pickLanguage(navigatorLanguage: string | undefined): Lang {
  return navigatorLanguage?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export function translator(lang: Lang): T {
  return (key, vars) => {
    let s = dict[lang]?.[key] ?? dict.en[key] ?? key;
    for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

/** The label for a history event; an event type the panel does not know yet shows as the plain word. */
export function historyLabel(t: T, type: string): string {
  const key = `history.${type}`;
  return key in en ? t(key as Key) : type;
}

const I18n = createContext<{ lang: Lang; t: T }>({ lang: "en", t: translator("en") });

export function I18nProvider(props: { lang: Lang; children: ComponentChildren }) {
  return <I18n.Provider value={{ lang: props.lang, t: translator(props.lang) }}>{props.children}</I18n.Provider>;
}

export function useI18n() {
  return useContext(I18n);
}

export function relativeTime(t: T, at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < 0) return t("time.inDays", { n: Math.max(1, Math.round(-diff / 86_400_000)) });
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutes", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hours", { n: h });
  return t("time.days", { n: Math.floor(h / 24) });
}
