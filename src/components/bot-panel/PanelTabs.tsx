import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ui } from "@/lib/ui-anchor";
import { PANEL_TABS, TAB_LABEL, type PanelTab } from "./page-registry";

const TAB_UI = {
  activity: ui("panel.tab-activity"),
  details: ui("panel.tab-details"),
  library: ui("panel.tab-library"),
  computer: ui("panel.tab-computer"),
} as const satisfies Record<PanelTab, string>;

function TabThumb({ tab }: { tab: PanelTab }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const measure = () => {
      const selected = row.querySelector<HTMLElement>(`[data-panel-tab="${tab}"]`);
      if (!selected) return;
      const next = { left: selected.offsetLeft, width: selected.offsetWidth };
      setBox((prev) => (prev.left === next.left && prev.width === next.width ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [tab]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-segment-thumb=""
      data-tab={tab}
      style={{ width: box.width, transform: `translateX(${box.left}px)` }}
      className="pointer-events-none absolute inset-y-[3px] left-0 rounded-full bg-ink/[0.1] transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
    />
  );
}

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
      <div className="relative flex rounded-full bg-ink/[0.05] p-[3px]">
        <TabThumb tab={tab} />
        {PANEL_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            data-panel-tab={id}
            data-ui={TAB_UI[id]}
            onClick={() => onSelect(id)}
            className={cn(
              "relative h-[26px] min-w-0 flex-auto truncate rounded-full px-2.5 text-[13px] leading-[18px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
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
