import { useState } from "react";

import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { draftFromFields, emptyTodoFields, TodoFields, type TodoFieldValues } from "../todo/TodoFields";
import { addTodoWithUndo } from "./todo-actions";

export function NewTodoForm({ bots, picker, botId, title = "", onClose }: {
  bots: readonly Bot[];
  picker: string | null;
  botId: string | null;
  /** Fills the title, for a follow-up todo. */
  title?: string;
  onClose: () => void;
}) {
  const [values, setValues] = useState<TodoFieldValues>(() => emptyTodoFields(botId, title));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const draft = draftFromFields(values);

  const submit = async () => {
    if (!draft || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await addTodoWithUndo(draft);
      onClose();
    } catch {
      setFailed(true);
      setSending(false);
    }
  };

  return (
    <form data-board-new-todo="" aria-label={t("board.newTodo")} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="mb-3 space-y-2 rounded-xl bg-card p-3 shadow-[inset_0_0_0_0.5px_var(--color-edge)]">
      <TodoFields values={values} onChange={setValues} bots={bots} picker={picker} autoFocus onSubmit={() => void submit()} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={!draft || sending} className="ui-button ui-button-primary ui-button-pill">{t("board.newTodo.add")}</button>
        <button type="button" onClick={onClose} className="ui-button ui-button-pill">{t("board.newTodo.cancel")}</button>
        <p role="alert" className="flex items-center gap-2 text-[13px] text-danger empty:hidden">
          {failed && <>{t("board.newTodo.failed")}<button type="button" className="font-medium underline" onClick={() => void submit()}>{t("board.retry")}</button></>}
        </p>
      </div>
    </form>
  );
}
