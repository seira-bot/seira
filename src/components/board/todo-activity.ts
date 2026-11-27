import type { BoardCard } from "../../../shared/board";
import type { Todo, TodoMaker } from "../../../shared/todo";
import { t } from "@/lib/i18n";
import { todoIsScheduled } from "@/lib/todo-labels";
import type { Bot } from "@/state/store";
import { ordinal } from "./board-model";

export interface ActivityItem { key: string; text: string; at?: number; botId?: string }

interface Context { bots: readonly Bot[]; todos: ReadonlyMap<string, Todo>; picker: string | null }

export function makerName(maker: TodoMaker, bots: readonly Bot[]): string {
  if (maker.kind === "bot") return bots.find((bot) => bot.id === maker.botId)?.name ?? "";
  return maker.name.trim() || t("board.todo.you");
}

/** "You, from your chat with Rhea". */
export function madeByLine(todo: Todo, bots: readonly Bot[]): string {
  const name = makerName(todo.madeBy, bots);
  const source = todo.source;
  if (!source) return name;
  const bot = source.botId ? bots.find((one) => one.id === source.botId) : undefined;
  return bot ? t("board.todo.madeFromChat", { name, bot: bot.name }) : t("board.todo.madeFromRoom", { name });
}

/** The line at the top of the panel: where the todo stands, in a few words. */
export function todoStatusLine(card: BoardCard, todo: Todo, ctx: Context): string {
  const status = (id: string) => ctx.todos.get(id)?.status;
  const bot = ctx.bots.find((one) => one.id === todo.botId);
  switch (todo.status) {
    case "open": return ctx.picker ? t("board.todoStatus.open") : t("board.todoStatus.pickBot");
    case "queued": {
      if (todoIsScheduled(todo, status)) {
        return todo.repeat || todo.routineId ? t("board.todoStatus.routine") : todo.start.kind === "after" ? t("board.todoStatus.afterTodo") : t("board.todoStatus.once");
      }
      if (bot?.startsTodos === "manual") return t("board.todoStatus.manual", { bot: bot.name });
      return card.place ? t("board.todoStatus.place", { place: ordinal(card.place) }) : t("board.todoStatus.upNext");
    }
    case "working": return t("board.todoStatus.working");
    case "needs-you":
      if (todo.question || card.question) return t("board.todoStatus.question");
      return todo.stuck === "unassigned" || !todo.botId ? t("board.todoStatus.pickBot") : t("board.todoStatus.problem");
    case "done": return t("board.todoStatus.done");
  }
}

/** What happened to the todo, oldest first, from the facts the todo carries. */
export function todoActivity(todo: Todo, ctx: Context): ActivityItem[] {
  const { bots } = ctx;
  const bot = bots.find((one) => one.id === todo.botId);
  const nameOf = (id: string | undefined) => bots.find((one) => one.id === id)?.name ?? "";
  const maker = makerName(todo.madeBy, bots);
  const items: ActivityItem[] = [{
    key: "made", at: todo.createdAt, botId: todo.madeBy.kind === "bot" ? todo.madeBy.botId : undefined,
    text: todo.source?.messageId ? t("board.activity.madeFromChat", { name: maker }) : t("board.activity.made", { name: maker }),
  }];
  if (todo.pickedBy) items.push({ key: "picked", botId: todo.pickedBy.botId, text: t("board.activity.picked", { picker: nameOf(todo.pickedBy.botId), bot: bot?.name ?? "", reason: todo.pickedBy.reason }) });
  if (todo.startedAt) items.push({ key: "started", at: todo.startedAt, botId: todo.botId, text: t("board.activity.started", { bot: bot?.name ?? "" }) });
  if (todo.stuck === "stopped") items.push({ key: "stopped", botId: todo.botId, text: t("board.todo.stopped", { count: todo.attempts }) });
  if (todo.stuck === "unassigned") items.push({ key: "unassigned", text: t("board.todo.unassigned") });
  if (todo.closedBy) items.push({ key: "closed", at: todo.finishedAt ?? todo.updatedAt, text: t("board.activity.closedBy", { name: makerName(todo.closedBy, bots) }) });
  else if (todo.finishedAt) items.push({ key: "finished", at: todo.finishedAt, botId: todo.botId, text: t("board.activity.finished", { bot: bot?.name ?? "" }) });
  return items;
}
