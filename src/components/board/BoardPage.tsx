import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardCard, BoardColumn as BoardColumnId } from "../../../shared/board";
import { viewersDefaultBot } from "../../../shared/default-bot";
import { t } from "@/lib/i18n";
import { useViewerEmail } from "@/lib/default-bot";
import { useMediaQuery } from "@/lib/use-media-query";
import { loadBoard, setBoardFilter, useBoardFilter, useBoardView } from "@/state/board";
import { useStore } from "@/state/store";
import { SeiraCharacter } from "../seira-character";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";
import { BoardColumn } from "./BoardColumn";
import { BoardPanel } from "./BoardPanel";
import { BoardTabs } from "./BoardTabs";
import { BotMenu } from "./BotMenu";
import { NewTaskForm } from "./NewTaskForm";
import { COLUMNS, cardsIn, closerName, visibleCards } from "./board-model";
import { useBoardActions } from "./use-board-actions";

export const BOARD_NARROW = "(max-width: 760px)";

export function BoardPage() {
  const { state, dispatch } = useStore();
  const board = useBoardView();
  const filter = useBoardFilter();
  const email = useViewerEmail();
  const narrow = useMediaQuery(BOARD_NARROW);
  const actions = useBoardActions();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<BoardColumnId>("needs-you");
  const opener = useRef<HTMLElement | null>(null);

  const cards = useMemo(() => visibleCards(board.cards, filter), [board.cards, filter]);
  const open = openId ? cards.find((card) => card.id === openId) : undefined;
  const filterBot = filter ? state.bots.find((bot) => bot.id === filter) : undefined;
  const defaultBotId = filterBot?.id ?? viewersDefaultBot(state.bots, email)?.id ?? state.bots[0]?.id ?? null;
  const botOf = (card: BoardCard) => state.bots.find((bot) => bot.id === card.botId);

  useEffect(() => { if (openId && !open && board.loaded) setOpenId(null); }, [openId, open, board.loaded]);
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
  const counts = Object.fromEntries(COLUMNS.map((column) => [column.id, cardsIn(cards, column.id).length])) as Record<BoardColumnId, number>;
  const empty = board.loaded && cards.length === 0;
  const newTaskButton = (
    <button type="button" aria-expanded={adding} onClick={() => setAdding(true)}
      className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-ink transition-colors duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
      <Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t("board.newTask")}
    </button>
  );

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
  ) : empty ? (
    <section data-board-empty="" className="px-6 py-16 text-center">
      <SeiraCharacter state="sleep" size={96} className="mx-auto mb-2" />
      <p className="mx-auto max-w-sm text-[14px] leading-relaxed text-ink-secondary">{t("board.empty")}</p>
      <div className="mt-4 flex justify-center">{newTaskButton}</div>
    </section>
  ) : (
    <div id="board-tabpanel" role={narrow ? "tabpanel" : undefined} aria-labelledby={narrow ? `board-tab-${tab}` : undefined} className="flex min-h-0 flex-1 gap-4 px-4 sm:px-6">
      {columns.map((column) => (
        <BoardColumn key={column.id} id={column.id} label={column.label} cards={cardsIn(cards, column.id)} bots={state.bots} openId={openId} onOpen={openCard} />
      ))}
    </div>
  );

  return (
    <ToolPage label={t("board.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })}>
        <h1 className={TOOL_PAGE_TITLE}>{t("board.title")}</h1>
        <ToolPageActions>
          <BotMenu label={t("board.filter.label")} bots={state.bots} value={filter} onChange={setBoardFilter} allLabel={t("board.filter.all")}
            summary={<span className="min-w-0 truncate">{filterBot?.name ?? t("board.filter.all")}</span>} />
          {!empty && newTaskButton}
        </ToolPageActions>
      </ToolPageHeader>
      {adding && <NewTaskForm bots={state.bots} defaultBotId={defaultBotId} />}
      <p role="status" aria-live="polite" className="px-4 text-[13px] text-ink-secondary empty:hidden sm:px-6">{actions.stopped ? t("board.stopped") : actions.moved ? t("board.movedToDone") : ""}</p>
      {narrow && board.loaded && !empty && <BoardTabs active={tab} counts={counts} onChange={setTab} />}
      <div className="flex min-h-0 flex-1 pb-2 pt-1">
        {!(narrow && open) && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>}
        {open && (
          <BoardPanel card={open} bot={botOf(open)} closer={closerName(open, state.bots)} moveFailed={actions.moveFailed === open.id} onClose={closePanel}
            onOpen={() => actions.openConversation(open)} onStop={() => actions.stop(open)} onMove={() => void actions.moveToDone(open)} />
        )}
      </div>
    </ToolPage>
  );
}
