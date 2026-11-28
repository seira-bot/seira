import type { Dispatch } from "react";

import type { Todo } from "../../../shared/todo";
import { requestBoardCard } from "@/lib/board-focus";
import { intlLocale, t } from "@/lib/i18n";
import { showToast } from "@/lib/power";
import { weekdayNames } from "@/lib/todo-labels";
import { deleteTodo } from "@/state/todos";
import type { Action } from "@/state/store";

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

/** "tomorrow at 9:00", "every day at 8:30", or null when the todo starts as soon as its bot is free. */
export function todoWhenPhrase(todo: Pick<Todo, "start" | "repeat">, now = Date.now()): string | null {
  if (todo.repeat) {
    const [hours, minutes] = todo.repeat.time.split(":").map(Number);
    const time = clock(new Date(now).setHours(hours ?? 0, minutes ?? 0, 0, 0));
    const days = [...new Set(todo.repeat.weekdays)].sort((a, b) => a - b);
    if (days.length === 0 || days.length === 7) return t("chat.todo.when.daily", { time });
    if (days.length === WEEKDAYS.length && days.every((day, index) => day === WEEKDAYS[index])) return t("chat.todo.when.weekdays", { time });
    const names = weekdayNames();
    return t("chat.todo.when.days", { days: [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)].map((day) => names[day]).join(", "), time });
  }
  if (todo.start.kind !== "at") return null;
  const days = Math.round((dayStart(todo.start.at) - dayStart(now)) / DAY_MS);
  const time = clock(todo.start.at);
  if (days === 0) return t("chat.todo.when.today", { time });
  if (days === 1) return t("chat.todo.when.tomorrow", { time });
  return t("chat.todo.when.date", { date: new Date(todo.start.at).toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short" }), time });
}

export function openTodoOnBoard(dispatch: Dispatch<Action>, todoId: string): void {
  requestBoardCard(`todo:${todoId}`);
  dispatch({ type: "showBoard" });
}

/** "Todo added for Felix, tomorrow at 9:00." with Undo and Open board. */
export function announceTodosAdded(todos: readonly Todo[], botName: string | null, dispatch: Dispatch<Action>): void {
  const first = todos[0];
  if (!first) return;
  const when = todoWhenPhrase(first);
  const text = botName && when ? t("chat.todo.addedForWhen", { bot: botName, when })
    : botName ? t("chat.todo.addedFor", { bot: botName })
    : when ? t("chat.todo.addedWhen", { when })
    : t("chat.todo.added");
  showToast(text, {
    ok: true,
    ttl: 8000,
    actions: [
      { label: t("chat.todo.undo"), quiet: true, run: () => { void Promise.all(todos.map((todo) => deleteTodo(todo.id))).catch(() => showToast(t("chat.todo.undoFailed"))); } },
      { label: t("chat.todo.openBoard"), run: () => openTodoOnBoard(dispatch, first.id) },
    ],
  });
}
