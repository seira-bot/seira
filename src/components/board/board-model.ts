import type { BoardCard, BoardCardState, BoardColumn } from "../../../shared/board";
import type { LocaleKey } from "@/locales";

export const COLUMNS: ReadonlyArray<{ id: BoardColumn; label: LocaleKey }> = [
  { id: "todo", label: "board.column.todo" },
  { id: "working", label: "board.column.working" },
  { id: "needs-you", label: "board.column.needsYou" },
  { id: "done", label: "board.column.done" },
];

export const STATE_LABELS: Record<BoardCardState, LocaleKey> = {
  queued: "board.state.queued",
  running: "board.state.running",
  "waiting-teammate": "board.state.waitingTeammate",
  "needs-input": "board.state.needsInput",
  "waiting-on-you": "board.state.waitingOnYou",
  failed: "board.state.failed",
  completed: "board.state.completed",
  closed: "board.state.closed",
};

export function visibleCards(cards: readonly BoardCard[], botId: string | null): BoardCard[] {
  return botId ? cards.filter((card) => card.botId === botId) : [...cards];
}

export function cardsIn(cards: readonly BoardCard[], column: BoardColumn): BoardCard[] {
  return cards.filter((card) => card.column === column);
}

export const isStoppable = (card: BoardCard): boolean => card.column === "working" && (card.state === "running" || card.state === "waiting-teammate");
