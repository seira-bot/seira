import { type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { PANEL_TABS, TAB_LABEL, type PanelTab } from "./page-registry";
import { SlidingThumb } from "./SlidingThumb";

export function PanelTabs({ tab, onSelect }: { tab: PanelTab; onSelect: (tab: PanelTab) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = PANEL_TABS.length - 1;
    const at = PANEL_TABS.indexOf(tab);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    const next = event.key === forward ? Math.min(at + 1, last) : event.key === backward ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    if (next !== at) onSelect(PANEL_TABS[next]!);
    event.currentTarget.querySelector<HTMLElement>(`[data-panel-tab="${PANEL_TABS[next]}"]`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t("botSettings.simple.tabs")}
      onKeyDown={onKeyDown}
      className="sticky top-0 z-[1] -mx-4 mt-3.5 bg-app px-4 pb-2.5 pt-1 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-app after:to-transparent"
    >
      <div className="relative grid grid-flow-col auto-cols-fr rounded-full bg-ink/[0.05] p-[3px]">
        <SlidingThumb index={PANEL_TABS.indexOf(tab)} count={PANEL_TABS.length} />
        {PANEL_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            data-panel-tab={id}
            onClick={() => onSelect(id)}
            className={cn(
              "relative h-[26px] min-w-0 truncate rounded-full px-3 text-[13px] leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              tab === id ? "font-medium text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>
    </div>
  );
}
