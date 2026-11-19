import { useEffect, useRef } from "react";
import type { HistoryItem } from "@/lib/announcement-history";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { localized, type AnnouncementAction, type AnnouncementPlace } from "../../../shared/announcements";
import { announcementPlaceAction, KIND_ICON, MARK } from "../AnnouncementCard";
import { PRIMARY_BUTTON } from "../NoticeCard";
import { SeiraCharacter } from "../seira-character";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { useAnnouncements } from "./use-announcements";

const QUIET_BUTTON = "ui-button min-h-9 gap-1.5 px-3 py-1.5";

/** A button opens what its card says, never anything else. */
export interface AnnouncementRun {
  url: (url: string) => void;
  place: (place: AnnouncementPlace) => void;
}

function run(action: AnnouncementAction, to: AnnouncementRun) {
  if ("open_url" in action) to.url(action.open_url);
  else to.place(action.open);
}

const dateText = (at: number, locale: string) => {
  try { return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at); } catch { return new Date(at).toISOString().slice(0, 10); }
};

function Mark({ item }: { item: HistoryItem }) {
  const Icon = item.card.image && "mark" in item.card.image ? MARK[item.card.image.mark] : KIND_ICON[item.card.kind];
  return <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/[0.05] text-ink-secondary"><Icon size={18} /></span>;
}

/** One announcement: its date, mark, title and line or two, and its own buttons. */
function Row({ item, locale, to }: { item: HistoryItem; locale: string; to: AnnouncementRun }) {
  const buttons = [item.card.primary, item.card.secondary].flatMap((button, index) => button ? [<button key={index} type="button" className={index === 0 ? PRIMARY_BUTTON : QUIET_BUTTON}
    onClick={() => run(button.action, to)}>{localized(button.label, locale)}</button>] : []);
  return <li data-announcement-item={item.id} className="flex items-start gap-3 px-3 py-3">
    <Mark item={item} />
    <div className="min-w-0 flex-1">
      <time dateTime={new Date(item.at).toISOString()} className="block text-[12px] leading-4 text-ink-tertiary">{dateText(item.at, locale)}</time>
      <span className="mt-0.5 block text-[14px] font-medium leading-5 text-ink">{localized(item.card.title, locale)}</span>
      <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[18px] text-ink-secondary">{localized(item.card.body, locale)}</span>
      {buttons.length > 0 && <div className="mt-2.5 flex flex-wrap items-center gap-2">{buttons}</div>}
    </div>
  </li>;
}

/** The list itself, as the page draws it: newest first. */
export function AnnouncementList({ items, locale = activeLocale(), to }: { items: readonly HistoryItem[]; locale?: string; to: AnnouncementRun }) {
  if (!items.length) {
    return <section aria-label={t("announcements.empty")} className="px-6 py-16 text-center">
      <SeiraCharacter state="sleep" size={96} className="mx-auto mb-2" />
      <p className="text-[14px] text-ink-secondary">{t("announcements.empty")}</p>
    </section>;
  }
  return <ul aria-label={t("announcements.title")} className="flex flex-col divide-y divide-hairline/40 rounded-2xl border border-hairline/50 bg-card/40">
    {items.map(item => <Row key={item.id} item={item} locale={locale} to={to} />)}
  </ul>;
}

/** Every announcement card for this person, newest first. Opening it clears the red dot (here and on their other pages). */
export function AnnouncementsPage() {
  const { dispatch } = useStore();
  const found = useAnnouncements();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (found.unread) found.markRead(); }, [found.unread]);
  const to: AnnouncementRun = {
    url: url => void openExternalLink(url).catch(() => undefined),
    place: place => dispatch(announcementPlaceAction(place)),
  };
  return (
    <ToolPage label={t("announcements.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("announcements.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-announcements={found.items.length}>
        <div className={cn("mx-auto w-full max-w-2xl p-4 sm:p-6")}>
          <AnnouncementList items={found.items} to={to} />
        </div>
      </div>
    </ToolPage>
  );
}
