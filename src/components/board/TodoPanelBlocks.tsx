import { MessageSquareQuote, Repeat } from "lucide-react";

import type { Todo } from "../../../shared/todo";
import { t } from "@/lib/i18n";
import { routineDateTime, routineRunTime, latestRoutineRun, routineRunLabel } from "@/lib/routine-display";
import type { Routine, RoutineRun } from "@/lib/routines";
import { todoTimeLabel } from "@/lib/todo-labels";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import type { ActivityItem } from "./todo-activity";

export const PANEL_ACTION = "ui-button ui-button-pill";

export function Block({ label, text, tone }: { label: string; text: string; tone?: "danger" }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[12px] font-medium text-ink-tertiary">{label}</h3>
      <p dir="auto" className={tone === "danger" ? "whitespace-pre-wrap break-words text-[13px] text-danger" : "whitespace-pre-wrap break-words text-[13px] text-ink"}>{text}</p>
    </section>
  );
}

export function SourceBlock({ who, todo, onOpen }: { who: string; todo: Todo; onOpen: () => void }) {
  const quote = todo.source?.quote;
  return (
    <figure data-todo-source="" className="space-y-1.5 rounded-lg bg-inset p-3">
      <figcaption className="flex items-center gap-2 text-[12px] text-ink-tertiary">
        <MessageSquareQuote size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{who} · {todoTimeLabel(todo.createdAt)}</span>
        {todo.source?.threadId && <button type="button" onClick={onOpen} className="shrink-0 font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{t("board.todo.openMessage")}</button>}
      </figcaption>
      {quote && <blockquote dir="auto" className="whitespace-pre-wrap break-words text-[13px] text-ink">{quote}</blockquote>}
    </figure>
  );
}

export function RoutineBlock({ routine, runs }: { routine: Routine | undefined; runs: readonly RoutineRun[] }) {
  const last = routine ? latestRoutineRun(routine.id, runs) : undefined;
  return (
    <div data-todo-routine="" className="space-y-0.5 rounded-lg bg-inset p-3 text-[13px]">
      <p className="flex items-center gap-2 font-medium text-ink"><Repeat size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" /><span className="min-w-0 truncate">{t("board.todo.routine", { name: routine?.name ?? "" })}</span></p>
      {routine?.nextRunAt != null && <p className="text-ink-secondary">{t("board.todo.routineNext", { time: routineDateTime(routine.nextRunAt) })}</p>}
      {last && <p className="text-ink-secondary">{t("board.todo.routineLast", { time: routineDateTime(routineRunTime(last)), status: routineRunLabel(last) })}</p>}
    </div>
  );
}

export function ActivityList({ items, bots }: { items: readonly ActivityItem[]; bots: readonly Bot[] }) {
  return (
    <section aria-label={t("board.todo.activity")} className="space-y-1.5">
      <h3 className="text-[12px] font-medium text-ink-tertiary">{t("board.todo.activity")}</h3>
      <ol className="space-y-2">
        {items.map((item) => {
          const bot = item.botId ? bots.find((one) => one.id === item.botId) : undefined;
          return (
            <li key={item.key} className="flex items-start gap-2 text-[13px]">
              <span className="mt-px flex size-[18px] shrink-0 items-center justify-center">{bot ? <BotAvatar bot={bot} size={18} label="" /> : <span aria-hidden="true" className="size-1.5 rounded-full bg-ink-tertiary" />}</span>
              <span dir="auto" className="min-w-0 flex-1 text-ink">{item.text}</span>
              {item.at != null && <time className="shrink-0 text-[12px] text-ink-tertiary" dateTime={new Date(item.at).toISOString()}>{todoTimeLabel(item.at)}</time>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
