import { useMemo } from "react";

import type { BoardCard } from "../../../shared/board";
import { t } from "@/lib/i18n";
import { requestBoardCard } from "@/lib/board-focus";
import { useBoardView } from "@/state/board";
import { useStore, type Bot } from "@/state/store";
import { useTodos } from "@/state/todos";
import { inLineOrder, todoGroupOf } from "../board/board-model";
import { todoLine, todoMap } from "../board/todo-line";
import { ColRow, RowText } from "./rows";

function Lane({ title, cards, onOpen }: { title: string; cards: BoardCard[]; onOpen: (card: BoardCard) => void }) {
  const { state } = useStore();
  const todos = useTodos();
  const map = useMemo(() => todoMap(todos.todos), [todos.todos]);
  const bots = state.bots;
  return (
    <section aria-label={title} data-bot-todos-lane={title} className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-[12px] font-medium text-ink-tertiary">{title}</h3>
      {cards.length === 0 ? (
        <span className="text-[13px] text-ink-tertiary">{t("botPanel.todos.none")}</span>
      ) : (
        cards.map((card) => {
          const line = todoLine(card, { bots, picker: todos.picker, todos: map });
          return (
            <button
              key={card.id}
              type="button"
              data-bot-todo={card.todoId}
              onClick={() => onOpen(card)}
              className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-ink/10 px-3 py-2 text-left hover:bg-ink/[0.03]"
            >
              <span dir="auto" className="line-clamp-2 text-[13px] text-ink">{card.title || t("task.untitledConversation")}</span>
              {line && <span dir="auto" className="line-clamp-1 text-[12px] text-ink-secondary">{line.text}</span>}
            </button>
          );
        })
      )}
    </section>
  );
}

export function BotTodos({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const board = useBoardView();
  const own = useMemo(() => board.cards.filter((card) => card.kind === "todo" && card.botId === bot.id), [board.cards, bot.id]);
  const todoCards = own.filter((card) => card.column === "todo");
  const now = own.filter((card) => card.column === "working" || card.column === "needs-you");
  const next = inLineOrder(todoCards.filter((card) => todoGroupOf(card) !== "scheduled"), state.bots);
  const later = todoCards.filter((card) => todoGroupOf(card) === "scheduled");
  const open = (card: BoardCard) => {
    requestBoardCard(card.id);
    dispatch({ type: "showBoard" });
  };
  return (
    <ColRow data-panel-row="bot-todos">
      <RowText title={t("botPanel.todos.title")} />
      <Lane title={t("board.byBot.now")} cards={now} onOpen={open} />
      <Lane title={t("board.group.next")} cards={next} onOpen={open} />
      <Lane title={t("board.byBot.later")} cards={later} onOpen={open} />
      <button
        type="button"
        data-panel-action="open-board"
        onClick={() => dispatch({ type: "showBoard" })}
        className="self-start text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
      >
        {t("botPanel.todos.openBoard")}
      </button>
    </ColRow>
  );
}
