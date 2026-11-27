import { useMemo } from "react";
import { ListTodo } from "lucide-react";

import type { Todo } from "../../../shared/todo";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { todoStatusLabel } from "@/lib/todo-labels";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import type { Bot } from "@/state/store";
import { useTodos } from "@/state/todos";
import { BotAvatar } from "../Avatar";
import { openTodoOnBoard } from "./todo-toast";

export const TODO_CHIPS_SHOWN = 2;

export interface TodoChipData {
  /** Newest first. */
  byMessage: ReadonlyMap<string, readonly Todo[]>;
  picker: string | null;
  statusOf: (todoId: string) => Todo["status"] | undefined;
  bots: readonly Bot[];
}

/** One read of the todos for a whole conversation view; each message row asks the result for its own chips. */
export function useTodoChips(): TodoChipData {
  const { todos, picker } = useTodos();
  const bots = useStoreSelector((state) => state.bots);
  return useMemo(() => {
    const byMessage = new Map<string, Todo[]>();
    for (const todo of [...todos].sort((a, b) => b.createdAt - a.createdAt)) {
      const id = todo.source?.messageId;
      if (id) byMessage.set(id, [...(byMessage.get(id) ?? []), todo]);
    }
    const status = new Map(todos.map((todo) => [todo.id, todo.status]));
    return { byMessage, picker, statusOf: (id: string) => status.get(id), bots };
  }, [todos, picker, bots]);
}

function Chips({ todos, chips, end }: { todos: readonly Todo[]; chips: TodoChipData; end: boolean }) {
  const dispatch = useStoreDispatch();
  const shown = todos.slice(0, TODO_CHIPS_SHOWN);
  const more = todos.length - shown.length;
  return (
    <div data-todo-chips="" className={cn("mt-1 flex flex-wrap items-center gap-1 px-1", end ? "justify-end" : "justify-start")}>
      {shown.map((todo) => {
        const bot = todo.botId ? chips.bots.find((one) => one.id === todo.botId) : undefined;
        const status = todoStatusLabel(todo, chips.picker, chips.statusOf);
        const label = bot ? t("chat.todo.chip", { status, bot: bot.name }) : t("chat.todo.chipNoBot", { status });
        return (
          <button key={todo.id} type="button" data-todo-chip={todo.id} title={t("chat.todo.chipOpen")} onClick={() => openTodoOnBoard(dispatch, todo.id)}
            className="ui-pill max-w-full gap-1.5 text-[12px] text-ink-secondary">
            {bot ? <BotAvatar bot={bot} size={14} animated={false} /> : <ListTodo size={13} aria-hidden="true" className="shrink-0" />}
            <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
          </button>
        );
      })}
      {more > 0 && <span data-todo-chips-more="" className="text-[12px] text-ink-tertiary">{t("chat.todo.more", { count: more })}</span>}
    </div>
  );
}

/** The todos made from one message, as chips under it: at most two, then "and N more". */
export function TodoChips({ messageId, chips, end = false }: { messageId: string; chips: TodoChipData; end?: boolean }) {
  const todos = chips.byMessage.get(messageId);
  return todos?.length ? <Chips todos={todos} chips={chips} end={end} /> : null;
}
