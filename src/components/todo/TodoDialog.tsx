import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { TODO_QUOTE_CHARS } from "../../../shared/todo";
import { formatTime } from "@/lib/clock-time";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { addTodos, useTodos } from "@/state/todos";
import { draftFromFields, emptyTodoFields, TodoFields } from "./TodoFields";
import { closeTodoDialog, useTodoDialogSeed, type TodoDialogSeed } from "./todo-dialog-state";
import { announceTodosAdded } from "./todo-toast";

const TITLE = "todo-dialog-title";
const PILL = "ui-button ui-button-pill min-w-[88px] border-transparent bg-ink text-app hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50";

function TodoDialog({ seed }: { seed: TodoDialogSeed }) {
  const dispatch = useStoreDispatch();
  const bots = useStoreSelector((state) => state.bots);
  const { picker } = useTodos();
  const visible = useMemo(() => bots.filter((bot) => !bot.hidden), [bots]);
  const [values, setValues] = useState(() => emptyTodoFields(seed.botId, seed.title, seed.note));
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, closeTodoDialog);
  const draft = draftFromFields(values);
  const quote = seed.source.quote?.slice(0, TODO_QUOTE_CHARS);
  const time = formatTime(seed.at);

  const submit = async () => {
    if (!draft || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const made = await addTodos([{ ...draft, source: { ...seed.source, ...(quote ? { quote } : {}) } }]);
      closeTodoDialog();
      announceTodosAdded(made, visible.find((bot) => bot.id === draft.botId)?.name ?? null, dispatch);
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <div className="ui-scrim ui-scrim-light fixed inset-0 z-50 flex items-center justify-center p-4 motion-reduce:animate-none"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeTodoDialog(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={TITLE} tabIndex={-1} data-todo-dialog=""
        className="ui-modal animate-pop-in relative flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 border-0 px-6 pb-5 pt-6 text-ink outline-none motion-reduce:animate-none">
        <h2 id={TITLE} className="pe-8 text-[17px] font-medium leading-6 tracking-[-0.008em]">{t("chat.todo.dialogTitle")}</h2>
        <button type="button" onClick={closeTodoDialog} aria-label={t("common.close")} className="ui-icon-button absolute end-3 top-3"><X size={16} /></button>
        <p data-todo-source="" dir="auto" className="min-w-0 truncate text-[12px] text-ink-tertiary">
          {quote ? t("chat.todo.source", { who: seed.who, time, quote }) : t("chat.todo.sourceNoQuote", { who: seed.who, time })}
        </p>
        <TodoFields values={values} onChange={setValues} bots={visible} picker={picker} autoFocus onSubmit={() => void submit()} />
        {failed && <p role="alert" className="text-[12px] text-danger">{t("chat.todo.failed")}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={closeTodoDialog} className="ui-button ui-button-pill">{t("common.cancel")}</button>
          <button type="button" data-primary="" disabled={!draft || pending} onClick={() => void submit()} className={PILL}>{t("chat.todo.add")}</button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once in the app; the message menu opens it. */
export function TodoDialogHost() {
  const seed = useTodoDialogSeed();
  return seed ? <TodoDialog key={seed.nonce} seed={seed} /> : null;
}
