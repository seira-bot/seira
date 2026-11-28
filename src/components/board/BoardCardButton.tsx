import { CircleDashed } from "lucide-react";
import type { ReactNode } from "react";

import type { BoardCard } from "../../../shared/board";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/relative-time";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { STATE_LABELS } from "./board-model";
import type { TodoLine } from "./todo-line";

export function stateLine(card: BoardCard, bot: Bot | undefined, closer?: string): string {
  if (closer) return t("board.state.closedBy", { name: closer });
  const time = localizedRelativeTime(card.updatedAt, activeLocale());
  return t(STATE_LABELS[card.state], { bot: bot?.name ?? "", time });
}

export function BoardCardButton({ card, bot, fromBot, closer, selected, onOpen, line, action }: {
  card: BoardCard;
  closer: string | undefined;
  bot: Bot | undefined;
  fromBot: Bot | undefined;
  selected: boolean;
  onOpen: () => void;
  /** A todo's own line; it replaces the state line. */
  line?: TodoLine | null;
  /** A control that sits under the card, such as "Choose a bot…". */
  action?: ReactNode;
}) {
  const alert = line ? line.tone !== "plain" : card.state === "failed" || card.state === "needs-input" || card.state === "waiting-on-you";
  const anyBot = card.kind === "todo" && !bot;
  return (
    <li className="flex flex-col gap-1">
      <button type="button" data-board-card={card.id} aria-current={selected || undefined} onClick={onOpen}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-xl bg-card p-3 text-start shadow-[inset_0_0_0_0.5px_var(--color-edge)] transition-colors duration-150 hover:bg-raised-hover motion-reduce:transition-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[current=true]:bg-raised",
        )}>
        <span dir="auto" className="line-clamp-2 text-[13px] font-medium text-ink">{card.title || t("task.untitledConversation")}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
          {bot && <BotAvatar bot={bot} size={16} label="" />}
          {anyBot && <CircleDashed size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
          <span className="min-w-0 truncate">{anyBot ? t("todo.fields.anyBot") : bot?.name}</span>
        </span>
        <span dir="auto" className={cn("text-[12px]", line?.tone === "danger" ? "font-medium text-danger" : alert ? "font-medium text-accent-text" : "text-ink-tertiary")}>{line ? line.text : stateLine(card, bot, closer)}</span>
        {card.kind === "handoff" && card.fromBotId && fromBot && <span className="truncate text-[12px] text-ink-tertiary">{t("board.card.from", { bot: fromBot.name })}</span>}
      </button>
      {action}
    </li>
  );
}
