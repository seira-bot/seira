import type { BoardCard, BoardCardState, BoardColumn, BoardTodoGroup } from "../../../shared/board";
import { intlLocale } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Bot } from "@/state/store";

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
  open: "board.state.open",
  scheduled: "board.state.scheduled",
  unassigned: "board.state.unassigned",
};

export function visibleCards(cards: readonly BoardCard[], botId: string | null): BoardCard[] {
  return botId ? cards.filter((card) => card.botId === botId || (card.kind === "todo" && !card.botId)) : [...cards];
}

export function cardsIn(cards: readonly BoardCard[], column: BoardColumn): BoardCard[] {
  return cards.filter((card) => card.column === column);
}

export const isStoppable = (card: BoardCard): boolean => card.column === "working" && (card.state === "running" || card.state === "waiting-teammate");

export function closerName(card: BoardCard, bots: readonly Bot[]): string | undefined {
  if (!card.closedBy) return undefined;
  const name = card.closedBy.kind === "person" ? card.closedBy.name : bots.find((bot) => bot.id === (card.closedBy as { botId: string }).botId)?.name;
  return name || undefined;
}

export const canMoveToDone = (card: BoardCard, bot: Bot | undefined): boolean => card.column === "needs-you" && bot?.yourAccess !== "view";

export const isTodoCard = (card: BoardCard): boolean => card.kind === "todo" && Boolean(card.todoId);

/** A todo that has no bot yet, whether the bot picker works on it or it waits in Needs you. */
export const isOpenTodo = (card: BoardCard): boolean => isTodoCard(card) && !card.botId && (card.state === "open" || card.state === "unassigned");

/** Only a todo that is not running and not finished can move to another bot. */
export const canDragTodo = (card: BoardCard): boolean => isTodoCard(card) && card.column !== "working" && card.column !== "done";

export const todoGroupOf = (card: BoardCard): BoardTodoGroup => card.group ?? "next";

function botRank(bots: readonly Bot[], botId: string): number {
  const at = bots.findIndex((bot) => bot.id === botId);
  return at < 0 ? bots.length : at;
}

/** Up next cards in line order: by bot as the sidebar lists them, then by place. */
export function inLineOrder(cards: readonly BoardCard[], bots: readonly Bot[]): BoardCard[] {
  return [...cards].sort((a, b) => botRank(bots, a.botId) - botRank(bots, b.botId) || (a.place ?? Infinity) - (b.place ?? Infinity));
}

export function todoGroups(cards: readonly BoardCard[], bots: readonly Bot[]): Array<{ id: BoardTodoGroup; cards: BoardCard[] }> {
  const pick = (id: BoardTodoGroup) => cards.filter((card) => todoGroupOf(card) === id);
  return [
    { id: "open" as const, cards: pick("open") },
    { id: "next" as const, cards: inLineOrder(pick("next"), bots) },
    { id: "scheduled" as const, cards: pick("scheduled") },
  ].filter((group) => group.cards.length > 0);
}

/** 1st, 2nd, 3rd in English; the plain number in other languages. */
export function ordinal(place: number): string {
  const locale = intlLocale();
  if (!locale.toLowerCase().startsWith("en")) return String(place);
  const rule = new Intl.PluralRules(locale, { type: "ordinal" }).select(place);
  return `${place}${rule === "one" ? "st" : rule === "two" ? "nd" : rule === "few" ? "rd" : "th"}`;
}
