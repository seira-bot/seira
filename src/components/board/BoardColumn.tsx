import type { BoardCard } from "../../../shared/board";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Bot } from "@/state/store";
import { BoardCardButton } from "./BoardCardButton";
import { closerName } from "./board-model";

export function BoardColumn({ id, label, cards, bots, openId, onOpen }: {
  id: string;
  label: LocaleKey;
  cards: readonly BoardCard[];
  bots: readonly Bot[];
  openId: string | null;
  onOpen: (card: BoardCard) => void;
}) {
  const botOf = (botId: string | undefined) => (botId ? bots.find((bot) => bot.id === botId) : undefined);
  return (
    <section id={`board-column-${id}`} data-board-column={id} aria-labelledby={`board-heading-${id}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h2 id={`board-heading-${id}`} className="flex items-center gap-2 px-1 pb-2 text-[13px] font-semibold text-ink">
        {t(label)}
        <span data-board-count="" className="text-[12px] font-medium text-ink-tertiary">{cards.length}</span>
      </h2>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {cards.map((card) => (
          <BoardCardButton key={card.id} card={card} bot={botOf(card.botId)} fromBot={botOf(card.fromBotId)} closer={closerName(card, bots)} selected={openId === card.id} onOpen={() => onOpen(card)} />
        ))}
      </ul>
    </section>
  );
}
