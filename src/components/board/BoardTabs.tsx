import type { KeyboardEvent } from "react";

import type { BoardColumn } from "../../../shared/board";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { COLUMNS } from "./board-model";

export function BoardTabs({ active, counts, onChange }: {
  active: BoardColumn;
  counts: Record<BoardColumn, number>;
  onChange: (column: BoardColumn) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = event.currentTarget;
    const rtl = getComputedStyle(list).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    if (!step) return;
    event.preventDefault();
    const at = COLUMNS.findIndex((column) => column.id === active);
    const next = COLUMNS[(at + step + COLUMNS.length) % COLUMNS.length]!;
    onChange(next.id);
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`#board-tab-${next.id}`)?.focus());
  };
  return (
    <div role="tablist" aria-label={t("board.columns")} onKeyDown={move} className="flex gap-1 px-4 pb-2">
      {COLUMNS.map((column) => (
        <button key={column.id} id={`board-tab-${column.id}`} type="button" role="tab" aria-selected={column.id === active} aria-controls="board-tabpanel"
          tabIndex={column.id === active ? 0 : -1} onClick={() => onChange(column.id)}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
            column.id === active ? "bg-raised text-ink" : "text-ink-secondary hover:bg-ink/[0.05]",
          )}>
          <span className="truncate">{t(column.label)}</span>
          <span className="text-[12px] text-ink-tertiary">{counts[column.id]}</span>
        </button>
      ))}
    </div>
  );
}
