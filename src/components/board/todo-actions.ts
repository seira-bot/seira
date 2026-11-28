import type { BoardCard } from "../../../shared/board";
import type { Todo, TodoDraft, TodoPatch } from "../../../shared/todo";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/power";
import { loadBoard } from "@/state/board";
import type { Bot } from "@/state/store";
import { addTodos, deleteTodo, patchTodo, restoreTodo } from "@/state/todos";
import { inLineOrder, isTodoCard, todoGroupOf } from "./board-model";

const UNDO_TTL_MS = 8000;

const reload = () => void loadBoard({ background: true });

export interface TodoMove {
  /** null makes the todo open again. */
  botId: string | null;
  /** In front of this todo; null puts it last in Up next; absent lets the server choose. */
  beforeId?: string | null;
}

/** The card that follows this one in its bot's Up next, as a todo id; null when it is last or not in Up next. */
export function nextTodoId(cards: readonly BoardCard[], bots: readonly Bot[], card: BoardCard): string | null {
  if (!card.botId) return null;
  const line = inLineOrder(cards.filter((one) => isTodoCard(one) && one.botId === card.botId && todoGroupOf(one) === "next" && one.column === "todo"), bots);
  const at = line.findIndex((one) => one.id === card.id);
  return at < 0 ? null : line[at + 1]?.todoId ?? null;
}

/** Moves a todo to a bot or a place in a bot's Up next, then offers Undo. */
export async function moveTodoCard(card: BoardCard, move: TodoMove, cards: readonly BoardCard[], bots: readonly Bot[]): Promise<boolean> {
  const id = card.todoId;
  if (!id) return false;
  const back: TodoPatch = card.botId ? { botId: card.botId, beforeId: nextTodoId(cards, bots, card) } : { botId: null };
  const patch: TodoPatch = { botId: move.botId, ...(move.beforeId !== undefined ? { beforeId: move.beforeId } : {}) };
  try {
    await patchTodo(id, patch);
  } catch {
    showToast(t("board.todo.moveFailed"));
    return false;
  }
  reload();
  const title = card.title || t("task.untitledConversation");
  const bot = move.botId ? bots.find((one) => one.id === move.botId) : undefined;
  const text = !move.botId ? t("board.todo.movedOpen", { title }) : move.botId === card.botId ? t("board.todo.reordered", { title }) : t("board.todo.gaveTo", { bot: bot?.name ?? "", title });
  showToast(text, {
    ttl: UNDO_TTL_MS,
    actions: [{ label: t("board.undo"), run: () => { patchTodo(id, back).then(reload, () => showToast(t("board.todo.moveFailed"))); } }],
  });
  return true;
}

/** Adds one todo, then offers Undo. Throws when the todo cannot be added, so the form can say so. */
export async function addTodoWithUndo(draft: TodoDraft): Promise<Todo | undefined> {
  const [made] = await addTodos([draft]);
  reload();
  showToast(t("board.todo.added"), {
    ttl: UNDO_TTL_MS,
    actions: made ? [{ label: t("board.undo"), run: () => { deleteTodo(made.id).then(reload, () => showToast(t("board.todo.undoFailed"))); } }] : [],
  });
  return made;
}

export async function deleteTodoWithUndo(todoId: string): Promise<boolean> {
  try {
    await deleteTodo(todoId);
  } catch {
    showToast(t("board.todo.deleteFailed"));
    return false;
  }
  reload();
  showToast(t("board.todo.deleted"), {
    ttl: UNDO_TTL_MS,
    actions: [{ label: t("board.undo"), run: () => { restoreTodo(todoId).then(reload, () => showToast(t("board.todo.undoFailed"))); } }],
  });
  return true;
}
