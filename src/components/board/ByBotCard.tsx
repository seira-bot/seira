import { MoreHorizontal } from "lucide-react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import type { BoardCard } from "../../../shared/board";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { stateLine } from "./BoardCardButton";
import { TodoBotMenu } from "./TodoBotMenu";
import { canDragTodo, closerName } from "./board-model";
import type { TodoLine } from "./todo-line";

export const TODO_DRAG_TYPE = "application/x-seira-todo";

/** A card in the By bot view: a button that opens the panel, with a "Move to…" menu for a todo that may move. */
export function ByBotCard({ card, bots, line, selected, dragging, number, drop, onOpen, onDragStart, onDragEnd, onDragOver, onDrop, onMove, onStep, canStepUp, canStepDown, owner }: {
  card: BoardCard;
  bots: readonly Bot[];
  line: TodoLine | null;
  selected: boolean;
  dragging: boolean;
  /** The place in line, for an Up next card. */
  number?: number;
  /** A line shows above or below the card while a drag points there. */
  drop?: "before" | "after" | null;
  onOpen: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  onMove: (botId: string | null) => void;
  onStep?: (direction: -1 | 1) => void;
  canStepUp?: boolean;
  canStepDown?: boolean;
  /** The bot whose lane this is; absent in the Open band. */
  owner?: Bot;
}) {
  const movable = canDragTodo(card);
  const closer = closerName(card, bots);
  const alert = line ? line.tone !== "plain" : card.state === "failed" || card.state === "needs-input" || card.state === "waiting-on-you";
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!movable || !event.altKey || !onStep || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    onStep(event.key === "ArrowUp" ? -1 : 1);
  };
  const dot: ReactNode = number != null && (
    <span aria-hidden="true" className="mt-2.5 w-4 shrink-0 text-center text-[12px] tabular-nums text-ink-tertiary">{number}</span>
  );
  return (
    <div className="relative flex items-start gap-1.5" onDragOver={onDragOver} onDrop={onDrop}>
      {dot}
      {drop && <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent", drop === "before" ? "-top-[5px]" : "-bottom-[5px]")} />}
      <div draggable={movable} onDragStart={movable ? onDragStart : undefined} onDragEnd={onDragEnd}
        className={cn("relative min-w-0 flex-1 rounded-xl bg-card shadow-[inset_0_0_0_0.5px_var(--color-edge)] transition-colors duration-150 hover:bg-raised-hover motion-reduce:transition-none", selected && "bg-raised", dragging && "opacity-40")}>
        <button type="button" data-board-card={card.id} aria-current={selected || undefined} onClick={onOpen} onKeyDown={onKeyDown}
          aria-keyshortcuts={movable && onStep ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          className={cn("flex w-full flex-col gap-1 rounded-xl p-2.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", movable && "pe-9")}>
          <span dir="auto" className="line-clamp-2 text-[13px] font-medium text-ink">{card.title || t("task.untitledConversation")}</span>
          <span dir="auto" className={cn("text-[12px]", line?.tone === "danger" ? "font-medium text-danger" : alert ? "font-medium text-accent-text" : "text-ink-tertiary")}>
            {line ? line.text : stateLine(card, owner, closer)}
          </span>
        </button>
        {movable && (
          <TodoBotMenu label={t("board.todo.moveTo")} summary={<MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />} bots={bots} current={card.botId || null} allowAny={Boolean(card.botId)}
            onChoose={onMove} onStep={onStep} canStepUp={canStepUp} canStepDown={canStepDown} caret={false}
            className="absolute end-1 top-1" triggerClass="size-7 justify-center rounded-md bg-transparent px-0 hover:bg-ink/[0.06]" />
        )}
      </div>
    </div>
  );
}
