import { useState } from "react";
import { ListTodo } from "lucide-react";

import type { Todo } from "../../../shared/todo";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { todoWhenLabel } from "@/lib/todo-labels";
import type { Message } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { deleteTodo, restoreTodo, useTodos } from "@/state/todos";
import { BotAvatar } from "../Avatar";
import { ASK_QUIET_BUTTON } from "../AskCard";
import { openTodoOnBoard } from "./todo-toast";

/** What Undo removed, by card: a card that scrolls away and back still offers "Bring them back". */
const removedByMessage = new Map<string, string[]>();
/** The last todo seen for each id, so a removed row still names its todo. */
const lastSeen = new Map<string, Todo>();

const heading = (count: number) => count === 1 ? t("chat.todo.batchOne") : t("chat.todo.batchMany", { count });

/** The "Added N todos" card on a bot line: what the bot put on the Board, with Undo and Open board. */
export function TodoBatchCard({ message }: { message: Message }) {
  const ids = message.todoBatch?.todoIds ?? [];
  const dispatch = useStoreDispatch();
  const bots = useStoreSelector((state) => state.bots);
  const { todos } = useTodos();
  const [removed, setRemoved] = useState<string[]>(() => removedByMessage.get(message.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (ids.length === 0) return null;

  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  for (const todo of todos) lastSeen.set(todo.id, todo);
  const keep = (next: string[]) => {
    if (next.length) removedByMessage.set(message.id, next); else removedByMessage.delete(message.id);
    setRemoved(next);
  };
  const undone = removed.length > 0 && removed.every((id) => !byId.has(id));
  const shown = undone ? ids.filter((id) => !removed.includes(id)) : ids;
  const present = ids.filter((id) => byId.has(id));
  const removable = ids.filter((id) => { const status = byId.get(id)?.status; return status === "open" || status === "queued"; });

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const done: string[] = [];
    for (const id of removable) {
      try { await deleteTodo(id); done.push(id); } catch { setFailed(true); }
    }
    if (done.length) keep([...removed, ...done]);
    setBusy(false);
  };
  const bringBack = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const left: string[] = [];
    for (const id of removed) {
      try { await restoreTodo(id); } catch { left.push(id); setFailed(true); }
    }
    keep(left);
    setBusy(false);
  };

  return (
    <div data-todo-batch="" className="max-w-[600px] text-[15px] leading-relaxed text-ink">
      {undone ? (
        <p data-todo-batch-undone="" dir="auto" className="mb-1 text-ink-secondary">
          {removed.length === 1 ? t("chat.todo.batchUndoneOne") : t("chat.todo.batchUndoneMany", { count: removed.length })}
        </p>
      ) : (
        <p dir="auto" className="mb-1 font-medium">{heading(ids.length)}</p>
      )}
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {shown.map((id) => {
            const todo = byId.get(id) ?? lastSeen.get(id);
            if (!todo) return <li key={id} data-todo-row={id} data-state="removed" className="text-[13px] text-ink-tertiary">{t("chat.todo.batchRemoved")}</li>;
            const gone = !byId.has(id);
            const bot = todo.botId ? bots.find((one) => one.id === todo.botId) : undefined;
            const who = bot?.name ?? t("todo.fields.anyBot");
            const second = todo.pickedBy?.reason ? `${who} · ${todo.pickedBy.reason}` : who;
            return (
              <li key={id} data-todo-row={id} data-state={gone ? "removed" : undefined} className={cn("flex items-start gap-2", gone && "text-ink-tertiary")}>
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                  {bot ? <BotAvatar bot={bot} size={20} animated={false} /> : <ListTodo size={16} aria-hidden="true" className="text-ink-secondary" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p dir="auto" className={cn("font-medium", gone && "line-through")}>{todo.title}</p>
                  <p dir="auto" className="text-[13px] text-ink-secondary">{second}</p>
                  <p className="text-[12px] text-ink-tertiary">
                    {gone ? t("chat.todo.batchRemoved") : todoWhenLabel(todo, (todoId) => byId.get(todoId)?.title)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {undone ? (
          <button type="button" data-todo-bring-back="" disabled={busy} onClick={() => void bringBack()} className={cn(ASK_QUIET_BUTTON, "my-0 -ms-2")}>
            {removed.length === 1 ? t("chat.todo.batchRestoreOne") : t("chat.todo.batchRestoreMany")}
          </button>
        ) : removable.length > 0 && (
          <button type="button" data-todo-undo="" disabled={busy} onClick={() => void undo()} className={cn(ASK_QUIET_BUTTON, "my-0 -ms-2")}>{t("chat.todo.undo")}</button>
        )}
        {present.length > 0 && (
          <button type="button" data-todo-open-board="" onClick={() => openTodoOnBoard(dispatch, present[0]!)} className={cn(ASK_QUIET_BUTTON, "my-0")}>{t("chat.todo.openBoard")}</button>
        )}
      </div>
      {failed && <p role="alert" className="mt-1 text-[12px] text-danger">{t("chat.todo.batchFailed")}</p>}
    </div>
  );
}
