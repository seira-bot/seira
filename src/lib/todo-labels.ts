import type { Todo, TodoRepeat } from "../../shared/todo";
import { intlLocale, t } from "@/lib/i18n";

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = [1, 2, 3, 4, 5];

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
}

function dayStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "Today, 9:00", "Tomorrow, 9:00", or "Fri 28 Nov, 9:00". */
export function todoTimeLabel(at: number, now = Date.now()): string {
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS);
  if (days === 0) return t("todo.time.today", { time: clock(at) });
  if (days === 1) return t("todo.time.tomorrow", { time: clock(at) });
  const date = new Date(at).toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short" });
  return t("todo.time.date", { date, time: clock(at) });
}

function repeatClock(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date();
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return clock(at.getTime());
}

/** Weekday names in the reader's language, Sunday first, as `TodoRepeat.weekdays` counts them. */
export function weekdayNames(style: "short" | "narrow" = "short"): string[] {
  const sunday = new Date(2026, 10, 22);
  return Array.from({ length: 7 }, (_, day) => new Date(sunday.getTime() + day * DAY_MS).toLocaleDateString(intlLocale(), { weekday: style }));
}

export function todoRepeatLabel(repeat: TodoRepeat): string {
  const time = repeatClock(repeat.time);
  const days = [...new Set(repeat.weekdays)].sort((a, b) => a - b);
  if (days.length === 0 || days.length === 7) return t("todo.repeat.daily", { time });
  if (days.length === WEEKDAYS.length && days.every((day, index) => day === WEEKDAYS[index])) return t("todo.repeat.weekdays", { time });
  const names = weekdayNames();
  const ordered = [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)];
  return t("todo.repeat.days", { days: ordered.map((day) => names[day]).join(", "), time });
}

/** When the todo may start, in a few words: "When free", "After: Pick a banner", "Tomorrow, 9:00", "Every Mon, 9:00". */
export function todoWhenLabel(todo: Pick<Todo, "start" | "repeat">, titleOf: (todoId: string) => string | undefined, now = Date.now()): string {
  if (todo.repeat) return todoRepeatLabel(todo.repeat);
  if (todo.start.kind === "at") return todoTimeLabel(todo.start.at, now);
  if (todo.start.kind === "after") {
    const title = titleOf(todo.start.todoId);
    return title ? t("todo.when.after", { title }) : t("todo.when.free");
  }
  return t("todo.when.free");
}

/** A queued todo that may not start yet: it repeats, waits for a time, or waits for another todo that is not done. */
export function todoIsScheduled(todo: Pick<Todo, "status" | "start" | "repeat" | "routineId">, statusOf: (todoId: string) => Todo["status"] | undefined, now = Date.now()): boolean {
  if (todo.status !== "queued") return false;
  if (todo.repeat || todo.routineId) return true;
  if (todo.start.kind === "at") return todo.start.at > now;
  if (todo.start.kind === "after") {
    const status = statusOf(todo.start.todoId);
    return status !== undefined && status !== "done";
  }
  return false;
}

/** The todo's place in a few words, as the chip under a chat message and the bot panel show it. */
export function todoStatusLabel(todo: Pick<Todo, "status" | "start" | "repeat" | "routineId">, picker: string | null, statusOf: (todoId: string) => Todo["status"] | undefined, now = Date.now()): string {
  switch (todo.status) {
    case "open": return picker ? t("todo.status.open") : t("todo.status.needsYou");
    case "queued": return todoIsScheduled(todo, statusOf, now) ? t("todo.status.scheduled") : t("todo.status.upNext");
    case "working": return t("todo.status.working");
    case "needs-you": return t("todo.status.needsYou");
    case "done": return t("todo.status.done");
  }
}
