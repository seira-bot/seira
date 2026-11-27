import { ListTodo } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStoreDispatch } from "@/state/store-select";
import { openTodoOnBoard } from "./todo-toast";

/** On the person's line that started a todo's work. A click opens that todo on the Board. */
export function FromTodoLabel({ todoId }: { todoId: string }) {
  const dispatch = useStoreDispatch();
  return (
    <button type="button" data-from-todo={todoId} title={t("chat.todo.chipOpen")} onClick={() => openTodoOnBoard(dispatch, todoId)}
      className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary hover:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
      <ListTodo aria-hidden="true" size={11} className="shrink-0" />
      {t("chat.todo.fromTodo")}
    </button>
  );
}
