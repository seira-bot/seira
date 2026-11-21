import { Plus, Search, SquareKanban, Zap } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { openCommandPalette } from "./CommandPalette";
import { ShortcutHint } from "./ShortcutHint";
import { useAutomationsNeedYou } from "./SidebarFooterNav";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";

export const SIMPLE_NAV_ROW = cn(
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-start text-[13px] font-medium text-ink-secondary transition-colors duration-150 motion-reduce:transition-none touch:h-10",
  "hover:bg-ink/[0.05] hover:text-ink aria-[current=true]:bg-raised aria-[current=true]:text-ink", SIMPLE_ROW_FOCUS,
);

export const SIMPLE_NEW_BUTTON = "flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06] aria-expanded:text-ink motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export const SIMPLE_LABEL_ADD = "flex size-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary opacity-0 transition-opacity duration-150 hover:bg-ink/[0.06] hover:text-ink focus-visible:opacity-100 group-hover/label:opacity-100 group-focus-within/label:opacity-100 touch:opacity-100 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function SimpleSearchPill() {
  return (
    <div className="px-3 pb-1.5 pt-0.5">
      <button
        type="button"
        data-sidebar-search-pill=""
        onClick={openCommandPalette}
        aria-label={t("sidebar.searchAria")}
        title={t("sidebar.searchAria")}
        className={cn(
          "flex h-[34px] w-full items-center gap-2 rounded-lg bg-inset ps-2.5 pe-1.5 text-[13px] text-ink-tertiary shadow-[inset_0_0_0_0.5px_var(--color-edge)] transition-colors duration-150 hover:text-ink-secondary motion-reduce:transition-none touch:h-11",
          SIMPLE_ROW_FOCUS,
        )}
      >
        <Search size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-start">{t("sidebar.search")}</span>
        <ShortcutHint id="command-palette" />
      </button>
    </div>
  );
}

export function SimpleBoardRow() {
  const { state, dispatch } = useStore();
  const active = state.activeView === "board";
  return (
    <div className="px-3 pb-1">
      <button type="button" data-sidebar-board="" aria-current={active || undefined} onClick={() => dispatch({ type: "showBoard" })} className={SIMPLE_NAV_ROW}>
        <SquareKanban size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.nav.board")}</span>
      </button>
    </div>
  );
}

export function SimpleAutomationsRow() {
  const { state, dispatch } = useStore();
  const needYou = useAutomationsNeedYou();
  const active = state.activeView === "routines";
  return (
    <div className="px-3 pb-1">
      <button type="button" data-sidebar-automations="" aria-current={active || undefined} onClick={() => dispatch({ type: "showRoutines", view: "list" })} className={SIMPLE_NAV_ROW}>
        <Zap size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.nav.automations")}</span>
        {needYou && <span aria-hidden="true" data-automations-dot="" className="size-[7px] shrink-0 rounded-full bg-accent" />}
      </button>
    </div>
  );
}

export function SimpleSectionLabel({ name, addLabel, onAdd }: { name: string; addLabel?: string; onAdd?: () => void }) {
  return (
    <div data-sidebar-section-label="" className="group/label flex h-7 items-center ps-2 pe-1 text-[12px] font-medium text-ink-tertiary">
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {onAdd && addLabel && (
        <button type="button" onClick={onAdd} aria-label={addLabel} title={addLabel} className={SIMPLE_LABEL_ADD}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** The workspace button's slot in Simple's top row: its button drops the pill look for a 32px quiet one. */
export function SimpleTopSlot({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return (
    <div data-sidebar-top-slot className="@container/sidebar-top flex min-w-0 flex-1 items-center" style={style}>
      <div data-sidebar-top-switcher className="flex min-w-0 items-center [&_button]:h-8 [&_button]:rounded-lg [&_button]:bg-transparent [&_button]:ps-2 [&_button]:pe-1.5 [&_button]:hover:bg-ink/[0.06] [&_button]:aria-expanded:bg-ink/[0.06]">
        {children}
      </div>
    </div>
  );
}
