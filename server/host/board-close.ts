import { BOARD_CLOSE_REASON_CHARS, type BoardCard } from "../../shared/board.ts";
import type { BoardClosures } from "../board-closed.ts";
import { boardView, botMayClose, type BoardSources } from "../board.ts";

export interface BoardCloseDeps {
  sources: () => BoardSources;
  closures: BoardClosures;
  bot: { id: string; chiefOfStaff?: boolean; section?: string };
  botOf: (botId: string) => { name?: string; section?: string } | undefined;
  teamCloud: boolean;
  /** Whether the calling turn may read this card: a card it may not read looks like a missing one. */
  readable: (card: BoardCard) => boolean;
  /** Moves a todo to Done as closed by a bot. */
  closeTodo?: (todoId: string, botId: string, reason: string) => void;
}

const EVERYTHING = { thread: () => true, bot: () => true, audience: () => true, routine: () => true };

/** What a bot's board_close call gets: with no body, the Needs you cards that bot may close; with one, the close itself. */
export function boardCloseAnswer(deps: BoardCloseDeps, body: Record<string, unknown> | null): { status: number; body: Record<string, unknown> } {
  const cards = boardView({ ...deps.sources(), closed: (cardId) => deps.closures.get(cardId) }, EVERYTHING).cards.filter((card) => card.column === "needs-you" && deps.readable(card));
  const mayClose = (card: (typeof cards)[number]) => botMayClose(card, deps.bot, deps.botOf(card.botId), deps.teamCloud);
  const botName = (botId: string) => deps.botOf(botId)?.name ?? botId;
  if (!body) {
    return { status: 200, body: { cards: cards.filter(mayClose).map((card) => ({ id: card.id, title: card.title, state: card.state, botName: botName(card.botId) })) } };
  }
  const cardId = typeof body.cardId === "string" ? body.cardId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!cardId || !reason || reason.length > BOARD_CLOSE_REASON_CHARS) {
    return { status: 400, body: { error: `cardId and a reason of at most ${BOARD_CLOSE_REASON_CHARS} characters are required` } };
  }
  const card = cards.find((candidate) => candidate.id === cardId);
  if (!card) return { status: 409, body: { error: "that card is not in Needs you, so it cannot be moved to Done" } };
  if (!mayClose(card)) return { status: 403, body: { error: "you can close only cards of your own work, work you handed over, or (as Chief of Staff) your team's" } };
  if (card.kind === "todo" && card.todoId && deps.closeTodo) deps.closeTodo(card.todoId, deps.bot.id, reason);
  else deps.closures.close(card.id, { kind: "bot", botId: deps.bot.id }, reason);
  return { status: 200, body: { ok: true, title: card.title, botName: botName(card.botId) } };
}
