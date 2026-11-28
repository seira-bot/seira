import type { Todo } from "../../../shared/todo";
import type { BoardCard } from "../../../shared/board";
import { t } from "@/lib/i18n";
import { todoWhenLabel } from "@/lib/todo-labels";
import type { Bot } from "@/state/store";
import { ordinal, todoGroupOf } from "./board-model";

export type TodoLineTone = "plain" | "alert" | "danger";
export interface TodoLine { text: string; tone: TodoLineTone }

export interface TodoLineContext {
  bots: readonly Bot[];
  picker: string | null;
  todos: ReadonlyMap<string, Todo>;
}

const titleOfIn = (todos: ReadonlyMap<string, Todo>) => (todoId: string) => todos.get(todoId)?.title;

/** The one line under a todo card's title, or null when the card's own state line says enough. */
export function todoLine(card: BoardCard, ctx: TodoLineContext): TodoLine | null {
  const todo = card.todoId ? ctx.todos.get(card.todoId) : undefined;
  const bot = ctx.bots.find((one) => one.id === card.botId);
  const pickerBot = ctx.picker ? ctx.bots.find((one) => one.id === ctx.picker) : undefined;
  if (card.state === "needs-input") return { text: card.question ?? todo?.question ?? t("board.state.needsInput"), tone: "alert" };
  if (card.state === "unassigned" || todo?.stuck === "unassigned") return { text: t("board.todo.unassigned"), tone: "alert" };
  if (todo?.stuck === "stopped") return { text: t("board.todo.stopped", { count: todo.attempts }), tone: "danger" };
  if (card.state === "open") return pickerBot ? { text: t("board.todo.picking", { bot: pickerBot.name }), tone: "plain" } : { text: t("board.todo.pickBot"), tone: "alert" };
  if (card.column !== "todo" || !todo) return null;
  const group = todoGroupOf(card);
  if (group === "scheduled") return { text: todoWhenLabel(todo, titleOfIn(ctx.todos)), tone: "plain" };
  if (todo.pickedBy) {
    const chooser = ctx.bots.find((one) => one.id === todo.pickedBy?.botId);
    return { text: t("board.todo.chose", { picker: chooser?.name ?? "", bot: bot?.name ?? "", reason: todo.pickedBy.reason }), tone: "plain" };
  }
  if (bot?.startsTodos === "manual") return { text: t("board.todo.startsWhenYouSay"), tone: "plain" };
  if (card.place) return { text: t("board.todo.upNextPlace", { place: ordinal(card.place) }), tone: "plain" };
  return null;
}

export function todoMap(todos: readonly Todo[]): Map<string, Todo> {
  return new Map(todos.map((todo) => [todo.id, todo]));
}
