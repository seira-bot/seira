import type { ReactNode } from "react";

import type { BoardCard, BoardTodoGroup } from "../../../shared/board";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Bot } from "@/state/store";
import { BoardCardButton } from "./BoardCardButton";
import { closerName, todoGroups } from "./board-model";
import type { TodoLine } from "./todo-line";

const GROUP_LABELS: Record<BoardTodoGroup, LocaleKey> = {
  open: "board.group.open",
  next: "board.group.next",
  scheduled: "board.group.scheduled",
};

export function BoardColumn({ id, label, cards, bots, openId, onOpen, lineOf, actionOf, top }: {
  id: string;
  label: LocaleKey;
  cards: readonly BoardCard[];
  bots: readonly Bot[];
  openId: string | null;
  onOpen: (card: BoardCard) => void;
  lineOf: (card: BoardCard) => TodoLine | null;
  actionOf: (card: BoardCard) => ReactNode;
  /** Sits above the cards: the new todo form in To do. */
  top?: ReactNode;
}) {
  const botOf = (botId: string | undefined) => (botId ? bots.find((bot) => bot.id === botId) : undefined);
  const row = (card: BoardCard) => (
    <BoardCardButton key={card.id} card={card} bot={botOf(card.botId)} fromBot={botOf(card.fromBotId)} closer={closerName(card, bots)} selected={openId === card.id}
      onOpen={() => onOpen(card)} line={lineOf(card)} action={actionOf(card)} />
  );
  return (
    <section id={`board-column-${id}`} data-board-column={id} aria-labelledby={`board-heading-${id}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h2 id={`board-heading-${id}`} className="px-1 pb-2 text-[13px] font-semibold text-ink">{t(label)}</h2>
      {top}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {id === "todo"
          ? todoGroups(cards, bots).map((group) => (
            <section key={group.id} data-board-group={group.id} aria-labelledby={`board-group-${group.id}`} className="flex flex-col gap-2">
              <h3 id={`board-group-${group.id}`} className="px-1 pt-1 text-[12px] font-medium text-ink-tertiary">{t(GROUP_LABELS[group.id])}</h3>
              <ul className="flex flex-col gap-2">{group.cards.map(row)}</ul>
            </section>
          ))
          : <ul className="flex flex-col gap-2">{cards.map(row)}</ul>}
      </div>
    </section>
  );
}
