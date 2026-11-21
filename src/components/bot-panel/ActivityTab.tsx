import { useMemo } from "react";
import { Bell, Check, Loader2, Wrench, X } from "lucide-react";

import { activityApp, activityLabel, formatActivityTime, groupActivityByDay, outcomeChip, type ActivityOutcome, type ActivityRow } from "@/lib/activity";
import { t } from "@/lib/i18n";
import { useBotActivity } from "@/lib/use-bot-activity";
import { useStore, type Bot } from "@/state/store";
import { CardLabel } from "./rows";

const LIMIT = 100;

function EndMark({ outcome }: { outcome: ActivityOutcome }) {
  const label = outcomeChip(outcome).text;
  if (outcome === "running") return <Loader2 size={14} role="img" aria-label={label} className="shrink-0 animate-spin text-ink-tertiary motion-reduce:animate-none" />;
  if (outcome === "waiting") return <Bell size={14} role="img" aria-label={label} className="shrink-0 text-warning" />;
  if (outcome === "failed" || outcome === "denied") return <X size={14} role="img" aria-label={label} className="shrink-0 text-danger" />;
  return <Check size={14} role="img" aria-label={label} className="shrink-0 text-success" />;
}

export function ActivityTab({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const { rows, error, threadIds } = useBotActivity(bot, LIMIT);
  const days = useMemo(() => (rows ? groupActivityByDay(rows, new Date()) : []), [rows]);

  const open = (row: ActivityRow) => {
    if (row.threadId !== bot.threadId && threadIds.has(row.threadId)) {
      dispatch({ type: "switchTask", botId: bot.id, threadId: row.threadId });
    }
  };

  return (
    <div data-panel-tabpanel="activity">
      {error && <p className="mx-3.5 mt-5 text-[13px] text-danger">{t("activity.panel.error", { message: error })}</p>}
      {!rows && !error && <p className="mx-3.5 mt-5 text-[13px] text-ink-secondary">{t("activity.panel.loading")}</p>}
      {rows && rows.length === 0 && !error && <p className="mx-3.5 mt-5 text-[13px] text-ink-secondary">{t("activity.panel.empty", { name: bot.name })}</p>}
      {days.map((day) => (
        <section key={day.key} data-activity-day={day.key}>
          <CardLabel>{day.label}</CardLabel>
          <ul className="flex flex-col">
            {day.rows.map((row) => {
              const app = activityApp(row);
              return (
                <li key={`${row.threadId}:${row.at}:${row.tool}:${row.requestId ?? ""}`}>
                  <button
                    type="button"
                    data-activity-item
                    data-activity-outcome={row.outcome}
                    onClick={() => open(row)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-[8px] px-3.5 py-1.5 text-start transition-colors hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink/[0.05] text-ink-secondary">
                      <Wrench size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">{activityLabel(row)}</span>
                      <span className="block truncate text-[12px] text-ink-tertiary">{app ? `${app} · ` : ""}{formatActivityTime(row.at)}</span>
                    </span>
                    <EndMark outcome={row.outcome} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
