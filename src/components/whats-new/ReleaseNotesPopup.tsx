import { useEffect } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { releaseNoteKeys, releaseNotesUrl, type ReleaseNotesView } from "@/lib/release-notes";
import { CLOSE, PRIMARY, QUIET, SHEET } from "../cloud-buy/parts";
import { SeiraCharacter } from "../seira-character";

export const RELEASE_NOTES_POPUP = "[data-release-notes]";

const TITLE_ID = "release-notes-title";
const focusLost = (focus: Element | null) => !focus || focus === document.body || !focus.isConnected;
const controls = (popup: Element | null) => [...(popup?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];

export function ReleaseNotesPopup({ view, onDone, onAllChanges }: {
  view: ReleaseNotesView; onDone: (action: "continue" | "close") => void; onAllChanges: () => void;
}) {
  const end = (action: "continue" | "close") => onDone(action);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, mine = document.querySelector(RELEASE_NOTES_POPUP);
    mine?.querySelector<HTMLElement>("[data-release-notes-continue]")?.focus();
    return () => {
      const focus = document.activeElement;
      if ((focusLost(focus) || mine?.contains(focus)) && opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const popup = document.querySelector(RELEASE_NOTES_POPUP), focus = document.activeElement, inside = Boolean(focus && popup?.contains(focus));
      if (!inside && !(event.key === "Tab" && focusLost(focus)) && !(event.key === "Escape" && focusLost(focus))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); end("close"); return; }
      if (event.key !== "Tab") return;
      const list = controls(popup);
      if (!list.length) return;
      event.preventDefault();
      const index = list.indexOf(focus as HTMLElement), step = event.shiftKey ? -1 : 1;
      list[index === -1 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length]!.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const allChanges = () => {
    onAllChanges();
    void openExternalLink(releaseNotesUrl(view.version)).catch(() => {});
  };

  return <div className="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-4 max-sm:items-end max-sm:p-0 sm:p-6"
    onMouseDown={event => { if (event.target === event.currentTarget) end("close"); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} data-release-notes={view.version} tabIndex={-1}
      className={cn(SHEET, "animate-pop-in motion-reduce:animate-none relative flex max-h-full w-full max-w-[480px] flex-col overflow-hidden outline-none max-sm:max-w-none max-sm:rounded-b-none")}>
      <span aria-hidden="true" className="mx-auto mt-2 hidden h-1 w-9 shrink-0 rounded-full bg-ink/20 max-sm:block" />
      <button type="button" onClick={() => end("close")} aria-label={t("releaseNotes.close")} className={cn(CLOSE, "absolute end-3 top-3 max-sm:top-4 max-sm:size-10")}><X size={16} /></button>
      <div className="flex items-center gap-3 px-6 pt-6 pe-14">
        <SeiraCharacter state="happy" size={48} />
        <div className="flex flex-col gap-0.5">
          <h2 id={TITLE_ID} className="text-[20px] font-semibold leading-[26px] tracking-[-0.01em] text-ink max-sm:text-[17px] max-sm:leading-[22px]">{t("releaseNotes.title", { app: productName(), version: view.version })}</h2>
          {view.from && <p className="text-[12px] leading-4 text-ink-tertiary">{t("releaseNotes.updatedFrom", { version: view.from })}</p>}
        </div>
      </div>
      <ul className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pt-5">
        {view.items.map(({ id, icon: Icon }) => {
          const keys = releaseNoteKeys(id);
          return <li key={id} className="flex items-start gap-3">
            <Icon size={16} aria-hidden="true" className="mt-px shrink-0 text-ink-secondary" />
            <div className="flex flex-col gap-0.5">
              <p className="text-[13px] font-medium leading-[18px] text-ink">{t(keys.title)}</p>
              <p className="text-[13px] leading-[18px] text-ink-secondary">{t(keys.body)}</p>
            </div>
          </li>;
        })}
      </ul>
      <div className="mt-6 flex items-center justify-between gap-2 border-t-[0.5px] border-ink/10 px-4 py-3 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button type="button" onClick={allChanges} className={cn(QUIET, "gap-1 max-sm:h-11 max-sm:flex-1")}>
          {t("releaseNotes.allChanges")}<ArrowUpRight size={14} aria-hidden="true" className="rtl:-scale-x-100" />
        </button>
        <button data-release-notes-continue type="button" onClick={() => end("continue")} className={cn(PRIMARY, "max-sm:h-11 max-sm:flex-1")}>{t("releaseNotes.continue")}</button>
      </div>
    </div>
  </div>;
}
