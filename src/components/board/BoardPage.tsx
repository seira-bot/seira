import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardCard, BoardColumn as BoardColumnId } from "../../../shared/board";
import { clearBoardCardRequest, useBoardCardRequest } from "@/lib/board-focus";
import { t } from "@/lib/i18n";
import { ui } from "@/lib/ui-anchor";
import { useMediaQuery } from "@/lib/use-media-query";
import { loadBoard, setBoardFilter, useBoardFilter, useBoardView } from "@/state/board";
import { useStore } from "@/state/store";
import { useTodos } from "@/state/todos";
import { SeiraCharacter } from "../seira-character";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";
import { Segmented } from "../bot-panel/rows";
import { BoardColumn } from "./BoardColumn";
import { BoardPanel } from "./BoardPanel";
import { BoardTabs } from "./BoardTabs";
import { BotMenu } from "./BotMenu";
import { ByBotView } from "./ByBotView";
import { NewTodoForm } from "./NewTodoForm";
import { PickerMenu } from "./PickerMenu";
import { TodoBotMenu } from "./TodoBotMenu";
import { TodoPanel } from "./TodoPanel";
import { COLUMNS, cardsIn, closerName, isOpenTodo, isTodoCard, visibleCards } from "./board-model";
import { readBoardViewMode, writeBoardViewMode, type BoardViewMode } from "./board-view-mode";
import { moveTodoCard } from "./todo-actions";
import { todoLine, todoMap } from "./todo-line";
import { useBoardActions } from "./use-board-actions";

export const BOARD_NARROW = "(max-width: 760px)";

interface NewTodo { title: string; botId: string | null }

export function BoardPage() {
  const { state, dispatch } = useStore();
  const board = useBoardView();
  const filter = useBoardFilter();
  const todoState = useTodos();
  const request = useBoardCardRequest();
  const narrow = useMediaQuery(BOARD_NARROW);
  const actions = useBoardActions();
  const [adding, setAdding] = useState<NewTodo | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<BoardColumnId>("needs-you");
  const [mode, setMode] = useState<BoardViewMode>(readBoardViewMode);
  const opener = useRef<HTMLElement | null>(null);
  const asked = useRef<string | null>(null);

  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const todos = useMemo(() => todoMap(todoState.todos), [todoState.todos]);
  const cards = useMemo(() => visibleCards(board.cards, filter), [board.cards, filter]);
  const open = openId ? cards.find((card) => card.id === openId) : undefined;
  const filterBot = filter ? bots.find((bot) => bot.id === filter) : undefined;
  const botOf = (card: BoardCard) => state.bots.find((bot) => bot.id === card.botId);
  const picker = todoState.picker && bots.some((bot) => bot.id === todoState.picker) ? todoState.picker : null;
  const lineCtx = { bots, picker, todos };

  useEffect(() => { if (openId && !open && board.loaded) setOpenId(null); }, [openId, open, board.loaded]);
  useEffect(() => {
    if (!request || !board.loaded) return;
    const wanted = board.cards.find((card) => card.id === request);
    if (!wanted) {
      if (asked.current !== request) { asked.current = request; void loadBoard({ background: true }); } else { asked.current = null; clearBoardCardRequest(); }
      return;
    }
    asked.current = null;
    if (filter && visibleCards([wanted], filter).length === 0) setBoardFilter(null);
    setOpenId(wanted.id);
    clearBoardCardRequest();
  }, [request, board.loaded, board.cards, filter]);
  useEffect(() => {
    if (!actions.stopped) return;
    const timer = window.setTimeout(actions.clearStopped, 4000);
    return () => window.clearTimeout(timer);
  }, [actions.stopped, actions.clearStopped]);
  useEffect(() => {
    if (!actions.moved) return;
    const timer = window.setTimeout(actions.clearMoved, 4000);
    return () => window.clearTimeout(timer);
  }, [actions.moved, actions.clearMoved]);

  const openCard = (card: BoardCard) => { opener.current = document.activeElement as HTMLElement | null; setOpenId(card.id); };
  const closePanel = () => { setOpenId(null); opener.current?.focus(); };
  const startAdding = (draft: NewTodo = { title: "", botId: filterBot?.id ?? null }) => { setAdding(draft); setTab("todo"); };
  const chooseView = (next: BoardViewMode) => { setMode(next); writeBoardViewMode(next); };
  const counts = Object.fromEntries(COLUMNS.map((column) => [column.id, cardsIn(cards, column.id).length])) as Record<BoardColumnId, number>;
  const empty = board.loaded && cards.length === 0 && !adding;
  const newTodoButton = (
    <button type="button" data-ui={ui("board.new-todo")} aria-expanded={Boolean(adding)} onClick={() => startAdding()} className="ui-button ui-button-primary ui-button-pill">
      <Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t("board.newTodo")}
    </button>
  );
  const form = adding && <NewTodoForm key={`${adding.title}|${adding.botId}`} bots={bots} picker={picker} botId={adding.botId} title={adding.title} onClose={() => setAdding(null)} />;

  const chooseBot = (card: BoardCard) => isOpenTodo(card) && (card.state === "unassigned" || !picker) ? (
    <TodoBotMenu label={t("board.todo.chooseBot")} summary={t("board.todo.chooseBot")} bots={bots} current={null} allowAny={false} caret={false}
      className="self-start" triggerClass="h-7 text-[12px]" onChoose={(botId) => void moveTodoCard(card, { botId }, board.cards, bots)} />
  ) : null;

  const columns = narrow ? COLUMNS.filter((column) => column.id === tab) : COLUMNS;
  const body = !board.loaded && board.failed ? (
    <section role="alert" className="px-6 py-16 text-center">
      <p className="text-[14px] text-ink-secondary">{t("board.loadFailed")}</p>
      <button type="button" className="ui-button mt-4" onClick={() => void loadBoard()}>{t("board.retry")}</button>
    </section>
  ) : !board.loaded ? (
    <div aria-busy="true" className="grid flex-1 grid-cols-1 gap-4 px-4 sm:grid-cols-4 sm:px-6">
      {COLUMNS.map((column) => <div key={column.id} className="h-24 animate-pulse rounded-xl bg-inset motion-reduce:animate-none" />)}
    </div>
  ) : mode === "bybot" ? (
    <ByBotView cards={cards} allCards={board.cards} bots={bots} filter={filter} picker={picker} todos={todos} openId={openId} narrow={narrow} form={form} onOpen={openCard} />
  ) : empty ? (
    <section data-board-empty="" className="px-6 py-16 text-center">
      <SeiraCharacter state="sleep" size={96} className="mx-auto mb-2" />
      <p className="mx-auto max-w-sm text-[14px] leading-relaxed text-ink-secondary">{t("board.empty")}</p>
      <div className="mt-4 flex justify-center">{newTodoButton}</div>
    </section>
  ) : (
    <div id="board-tabpanel" role={narrow ? "tabpanel" : undefined} aria-labelledby={narrow ? `board-tab-${tab}` : undefined} className="flex min-h-0 flex-1 gap-4 px-4 sm:px-6">
      {columns.map((column) => (
        <BoardColumn key={column.id} id={column.id} label={column.label} cards={cardsIn(cards, column.id)} bots={state.bots} openId={openId} onOpen={openCard}
          lineOf={(card) => card.kind === "todo" ? todoLine(card, lineCtx) : null} actionOf={chooseBot} top={column.id === "todo" ? form : undefined} />
      ))}
    </div>
  );

  const openTodo = open && isTodoCard(open) ? todos.get(open.todoId!) : undefined;
  return (
    <ToolPage label={t("board.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })}>
        <h1 data-ui={ui("board.page")} className={TOOL_PAGE_TITLE}>{t("board.title")}</h1>
        <ToolPageActions>
          <div className="flex flex-wrap items-center justify-end gap-2">
          <PickerMenu bots={bots} picker={picker} />
          <BotMenu ui={ui("board.filter")} label={t("board.filter.label")} bots={bots} value={filter} onChange={setBoardFilter} allLabel={t("board.filter.all")}
            summary={<span className="min-w-0 truncate">{filterBot?.name ?? t("board.filter.all")}</span>} />
          <div data-ui={ui("board.view")} className="w-44">
            <Segmented attr="data-board-view" label={t("board.view.label")} value={mode} onChange={chooseView}
              options={[{ value: "columns", label: t("board.view.columns") }, { value: "bybot", label: t("board.view.byBot") }]} />
          </div>
          {!(empty && mode === "columns") && newTodoButton}
          </div>
        </ToolPageActions>
      </ToolPageHeader>
      <p role="status" aria-live="polite" className="px-4 text-[13px] text-ink-secondary empty:hidden sm:px-6">{actions.stopped ? t("board.stopped") : actions.moved ? t("board.movedToDone") : ""}</p>
      {narrow && mode === "columns" && board.loaded && !empty && <BoardTabs active={tab} counts={counts} onChange={setTab} />}
      <div className="flex min-h-0 flex-1 pb-2 pt-1">
        {!(narrow && open) && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>}
        {open && openTodo && (
          <TodoPanel card={open} todo={openTodo} bots={bots} picker={picker} todos={todos} cards={board.cards} onClose={closePanel} onOpenConversation={() => actions.openConversation(open)}
            onStop={() => actions.stop(open)} onFollowUp={(draft) => { setOpenId(null); startAdding(draft); }} />
        )}
        {open && !openTodo && (
          <BoardPanel card={open} bot={botOf(open)} closer={closerName(open, state.bots)} moveFailed={actions.moveFailed === open.id} onClose={closePanel}
            onOpen={() => actions.openConversation(open)} onStop={() => actions.stop(open)} onMove={() => void actions.moveToDone(open)} />
        )}
      </div>
    </ToolPage>
  );
}
