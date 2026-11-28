import { CircleDashed, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BoardCard } from "../../../shared/board";
import type { Todo } from "../../../shared/todo";
import { TODO_TITLE_CHARS } from "../../../shared/todo";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/power";
import { landOnSearchHit } from "@/lib/focus-message";
import { useShowThreads } from "@/lib/thread-preferences";
import { todoWhenLabel } from "@/lib/todo-labels";
import { loadBoard } from "@/state/board";
import { useStore, type Bot } from "@/state/store";
import { patchTodo, startTodo } from "@/state/todos";
import { BotAvatar } from "../Avatar";
import { TodoWhenFields, startFromWhen, type TodoWhen } from "../todo/TodoFields";
import { TodoBotMenu } from "./TodoBotMenu";
import { ActivityList, Block, PANEL_ACTION, RoutineBlock, SourceBlock } from "./TodoPanelBlocks";
import { isStoppable } from "./board-model";
import { deleteTodoWithUndo, moveTodoCard } from "./todo-actions";
import { madeByLine, makerName, todoActivity, todoStatusLine } from "./todo-activity";

const PRIMARY_MENU = "bg-ink text-app hover:bg-ink/90 font-medium";

function localInputValue(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function whenOf(todo: Todo): TodoWhen {
  return todo.start.kind === "at" ? { kind: "at", at: localInputValue(todo.start.at) } : { kind: "free" };
}

export function TodoPanel({ card, todo, bots, picker, todos, cards, onClose, onOpenConversation, onStop, onFollowUp }: {
  card: BoardCard;
  todo: Todo;
  bots: readonly Bot[];
  picker: string | null;
  todos: ReadonlyMap<string, Todo>;
  cards: readonly BoardCard[];
  onClose: () => void;
  onOpenConversation: () => void;
  onStop: () => void;
  onFollowUp: (draft: { title: string; botId: string | null }) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const close = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [when, setWhen] = useState<TodoWhen | null>(null);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, [card.id]);
  useEffect(() => { setTitle(null); setWhen(null); setFailed(false); }, [todo.id]);

  const bot = bots.find((one) => one.id === todo.botId);
  const pickerBot = picker ? bots.find((one) => one.id === picker) : undefined;
  const ctx = { bots, todos, picker };
  const done = todo.status === "done";
  const working = todo.status === "working";
  const settled = done || working;
  const maker = makerName(todo.madeBy, bots);
  const question = todo.status === "needs-you" ? todo.question ?? card.question : undefined;
  const routine = todo.routineId ? state.routines.find((one) => one.id === todo.routineId) : undefined;
  const startRule = when ? startFromWhen(when) : null;
  const canEditWhen = !settled && !todo.repeat && !todo.routineId;
  const waitsForPick = !todo.botId && (todo.status === "needs-you" || (todo.status === "open" && !picker));

  const run = async (work: () => Promise<unknown>) => {
    setFailed(false);
    try {
      await work();
      void loadBoard({ background: true });
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };
  const saveTitle = async () => {
    const next = (title ?? "").replace(/\s+/g, " ").trim();
    if (!next || next === todo.title) { setTitle(null); return; }
    if (await run(() => patchTodo(todo.id, { title: next }))) setTitle(null);
  };
  const saveWhen = async () => {
    if (startRule && await run(() => patchTodo(todo.id, { start: startRule }))) setWhen(null);
  };
  const openMessage = () => {
    const source = todo.source;
    if (!source) return;
    const hit = { botId: source.botId, groupId: source.groupId, name: "", threadId: source.threadId, messageId: source.messageId ?? "", role: "", kind: "", at: todo.createdAt, snippet: "", matchStart: 0, matchLength: 0, onActivePath: true };
    if (!source.messageId) { onOpenConversation(); return; }
    landOnSearchHit(hit, state, dispatch, showThreads).catch(() => showToast(t("chat.conversationGone")));
  };
  const remove = async () => { if (await deleteTodoWithUndo(todo.id)) onClose(); };
  const chooseBot = (botId: string | null) => void moveTodoCard(card, { botId }, cards, bots);

  const primaryKind = todo.routineId ? "automations" : todo.status === "queued" ? "start" : done ? "followUp" : waitsForPick ? "choose" : card.threadId ? "open" : null;
  const PRIMARY = "ui-button ui-button-primary ui-button-pill";
  const primary = primaryKind === "automations" ? <button type="button" className={PRIMARY} onClick={() => dispatch({ type: "showRoutines", routineId: todo.routineId })}>{t("board.todo.openAutomations")}</button>
    : primaryKind === "start" ? <button type="button" className={PRIMARY} onClick={() => void run(() => startTodo(todo.id))}>{t("board.todo.startNow")}</button>
    : primaryKind === "followUp" ? <button type="button" className={PRIMARY} onClick={() => onFollowUp({ title: t("board.todo.followUpTitle", { title: todo.title }), botId: todo.botId ?? null })}>{t("board.todo.followUp")}</button>
    : primaryKind === "choose" ? <TodoBotMenu label={t("board.todo.chooseBot")} summary={t("board.todo.chooseBot")} bots={bots} current={null} allowAny={false} caret={false} triggerClass={PRIMARY_MENU} onChoose={chooseBot} />
    : primaryKind === "open" ? <button type="button" className={PRIMARY} onClick={onOpenConversation}>{t("board.panel.open")}</button>
    : null;
  const openIsPrimary = primaryKind === "open";

  return (
    <aside aria-label={todo.title} data-board-panel="" data-todo-panel={todo.id} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="flex w-[344px] max-w-full shrink-0 flex-col gap-4 overflow-y-auto border-s border-hairline bg-panel p-4">
      <header className="flex items-start gap-2">
        <p data-todo-status="" className="min-w-0 flex-1 pt-1 text-[12px] font-medium text-ink-secondary">{todoStatusLine(card, todo, ctx)}</p>
        <button ref={close} type="button" aria-label={t("board.panel.close")} title={t("board.panel.close")} onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          <X size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      {title === null ? (
        <h2 dir="auto" className="break-words text-[15px] font-semibold text-ink">
          {done ? todo.title : (
            <button type="button" data-todo-title="" title={t("board.todo.editTitle")} onClick={() => setTitle(todo.title)} className="w-full rounded-md text-start hover:bg-ink/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{todo.title}</button>
          )}
        </h2>
      ) : (
        <input type="text" dir="auto" autoFocus value={title} maxLength={TODO_TITLE_CHARS} aria-label={t("todo.fields.title")} onChange={(event) => setTitle(event.target.value)} onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveTitle(); }
            if (event.key === "Escape") { event.stopPropagation(); setTitle(null); }
          }}
          className="h-9 w-full rounded-lg bg-inset px-3 text-[14px] font-semibold text-ink shadow-[inset_0_0_0_0.5px_var(--color-edge)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" />
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-ink-tertiary">{t("todo.fields.for")}</dt>
        <dd className="min-w-0">
          <TodoBotMenu label={t("board.todo.moveTo")} bots={bots} current={todo.botId ?? null} allowAny={!working} disabled={settled} onChoose={chooseBot}
            triggerClass="h-7 rounded-md bg-transparent px-1.5 font-normal hover:bg-ink/[0.06]" caret={!settled}
            summary={bot
              ? <><BotAvatar bot={bot} size={18} label="" /><span className="min-w-0 truncate">{bot.name}</span></>
              : <><CircleDashed size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" /><span className="min-w-0 truncate">{pickerBot ? t("board.todo.anyBotPicks", { bot: pickerBot.name }) : t("board.todo.anyBotYouPick")}</span></>} />
        </dd>
        <dt className="text-ink-tertiary">{t("todo.fields.when")}</dt>
        <dd className="min-w-0">
          {canEditWhen && when === null
            ? <button type="button" data-todo-when-edit="" onClick={() => setWhen(whenOf(todo))} className="h-7 w-full truncate rounded-md px-1.5 text-start text-ink hover:bg-ink/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{todoWhenLabel(todo, (id) => todos.get(id)?.title)}</button>
            : when === null ? <span className="px-1.5 text-ink">{todoWhenLabel(todo, (id) => todos.get(id)?.title)}</span> : null}
        </dd>
        <dt className="text-ink-tertiary">{t("board.todo.madeBy")}</dt>
        <dd dir="auto" className="min-w-0 px-1.5 text-ink">{madeByLine(todo, bots)}</dd>
      </dl>
      {when !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <TodoWhenFields when={when} onChange={setWhen} allowRepeat={false} />
          <button type="button" disabled={!startRule} onClick={() => void saveWhen()} className={PANEL_ACTION}>{t("board.todo.save")}</button>
          <button type="button" onClick={() => setWhen(null)} className={PANEL_ACTION}>{t("board.newTodo.cancel")}</button>
        </div>
      )}
      {todo.source?.messageId && <SourceBlock who={maker} todo={todo} onOpen={openMessage} />}
      {todo.routineId && <RoutineBlock routine={routine} runs={state.routineRuns} />}
      {todo.note && <Block label={t("todo.fields.note")} text={todo.note} />}
      {question && <Block label={t("board.panel.asked")} text={question} />}
      {todo.stuck === "stopped" && <Block label={t("board.panel.problem")} text={t("board.todo.stopped", { count: todo.attempts })} tone="danger" />}
      {todo.stuck === "unassigned" && <Block label={t("board.panel.problem")} text={t("board.todo.unassigned")} />}
      {card.error && <Block label={t("board.panel.problem")} text={card.error} tone="danger" />}
      {done && (todo.result ?? card.result) && <Block label={t("board.panel.result")} text={(todo.result ?? card.result)!} />}
      <ActivityList items={todoActivity(todo, ctx)} bots={bots} />
      <div className="mt-auto flex flex-wrap gap-2">
        {primary}
        {!openIsPrimary && card.threadId && (done || todo.status === "needs-you" || working) && <button type="button" className={PANEL_ACTION} onClick={onOpenConversation}>{t("board.panel.open")}</button>}
        {todo.routineId && <button type="button" className={PANEL_ACTION} onClick={() => dispatch({ type: "runRoutine", routineId: todo.routineId!, onError: () => showToast(t("board.todo.runFailed")) })}>{t("board.todo.runNow")}</button>}
        {isStoppable(card) && <button type="button" className={PANEL_ACTION} onClick={onStop}>{t("board.action.stop")}</button>}
        {todo.status === "needs-you" && todo.botId && <button type="button" className={PANEL_ACTION} onClick={() => void run(() => patchTodo(todo.id, { status: "queued" }))}>{t("board.todo.backToUpNext")}</button>}
        {!settled && <button type="button" className={PANEL_ACTION} onClick={() => void run(() => patchTodo(todo.id, { status: "done" }))}>{t("board.action.moveToDone")}</button>}
        <button type="button" className={cn(PANEL_ACTION, "text-danger")} onClick={() => void remove()}><Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />{t("board.todo.delete")}</button>
      </div>
      {failed && <p role="alert" className="text-[13px] text-ink-secondary">{t("board.todo.saveFailed")}</p>}
    </aside>
  );
}
