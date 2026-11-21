import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { BoardCard } from "../../../shared/board";
import { t } from "@/lib/i18n";
import { refreshInbox, useInboxView } from "@/state/inbox";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { InboxAnswer } from "../inbox/InboxAnswer";
import { answerKindOf } from "../inbox/inbox-answer";
import { isStoppable } from "./board-model";
import { stateLine } from "./BoardCardButton";

const ACTION = "inline-flex h-8 items-center rounded-lg bg-control px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

function Block({ label, text }: { label: string; text: string }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[12px] font-medium text-ink-tertiary">{label}</h3>
      <p dir="auto" className="whitespace-pre-wrap break-words text-[13px] text-ink">{text}</p>
    </section>
  );
}

export function BoardPanel({ card, bot, onClose, onOpen, onStop }: {
  card: BoardCard;
  bot: Bot | undefined;
  onClose: () => void;
  onOpen: () => void;
  onStop: () => void;
}) {
  const inbox = useInboxView();
  const close = useRef<HTMLButtonElement>(null);
  const waits = card.column === "needs-you";
  useEffect(() => { if (waits && !inbox) void refreshInbox(); }, [waits, inbox]);
  useEffect(() => { close.current?.focus({ preventScroll: true }); }, [card.id]);

  const row = waits && inbox && card.threadId
    ? inbox.rows.find((one) => one.origin?.threadId === card.threadId && answerKindOf(one) !== "none" && one.tab === "needs-you")
    : undefined;
  const asked = card.question ?? card.brief;

  return (
    <aside aria-label={card.title || t("task.untitledConversation")} data-board-panel="" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      className="flex w-[344px] max-w-full shrink-0 flex-col gap-4 overflow-y-auto border-s border-hairline bg-panel p-4">
      <header className="flex items-start gap-2">
        <h2 dir="auto" className="min-w-0 flex-1 break-words text-[15px] font-semibold text-ink">{card.title || t("task.untitledConversation")}</h2>
        <button ref={close} type="button" aria-label={t("board.panel.close")} title={t("board.panel.close")} onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          <X size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
        {bot && <BotAvatar bot={bot} size={20} label="" />}
        <span className="min-w-0 truncate">{bot?.name}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate">{stateLine(card, bot)}</span>
      </div>
      {asked && <Block label={t("board.panel.asked")} text={asked} />}
      {card.error && <Block label={t("board.panel.problem")} text={card.error} />}
      {card.result && <Block label={t("board.panel.result")} text={card.result} />}
      {row && inbox && <InboxAnswer kind={answerKindOf(row)} view={inbox} row={row} asker={bot} />}
      <div className="flex flex-wrap gap-2">
        {card.threadId && <button type="button" onClick={onOpen} className={ACTION}>{t("board.panel.open")}</button>}
        {isStoppable(card) && <button type="button" onClick={onStop} className={ACTION}>{t("board.action.stop")}</button>}
      </div>
    </aside>
  );
}
