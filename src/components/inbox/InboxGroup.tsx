import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { InboxRow } from "../../../shared/inbox";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { doneInboxRows } from "@/state/inbox";
import { threadUpdatedLabel } from "../SidebarThreadRow";
import { InboxRowItem } from "./InboxRow";
import { textOf, type QuickAction } from "./inbox-view";

/** Updates of one bot in one conversation, shown as the newest with a count; Done settles every one of them. */
export function InboxGroup({ rows, now, onOpen, onAction }: {
  /** Newest first. */
  rows: InboxRow[];
  now: number;
  onOpen(row: InboxRow): void;
  onAction(row: InboxRow, action: QuickAction, failed?: () => void): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const newest = rows[0]!;
  const count = rows.length;
  const act = (row: InboxRow, action: QuickAction, failed?: () => void) => {
    if (action === "done") doneInboxRows(rows);
    else onAction(row, action, failed);
  };
  return (
    <div data-inbox-group={newest.id} data-inbox-group-count={count} className="space-y-1">
      <InboxRowItem row={newest} now={now} onOpen={onOpen} onAction={act} />
      <div className="flex items-center gap-2 px-3">
        <span data-inbox-group-chip className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] tabular-nums text-ink-secondary">{t("inbox.group.count", { count })}</span>
        <button type="button" data-inbox-group-toggle aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {t(expanded ? "inbox.group.collapse" : "inbox.group.expand", { count })}
          <ChevronDown size={12} aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
      </div>
      {expanded && (
        <ul data-inbox-group-rows className="space-y-px px-1">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" data-inbox-group-row={row.id} onClick={() => onOpen(row)}
                className={cn("flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                  row.unread ? "font-semibold text-ink" : "font-normal text-ink-secondary")}>
                <span className="w-9 shrink-0 text-[11px] font-normal tabular-nums text-ink-tertiary">{threadUpdatedLabel(row.at, now)}</span>
                <span className="min-w-0 flex-1 truncate">{textOf(row).replace(/\s+/g, " ").trim()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
