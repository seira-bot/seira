import { z } from "zod";
import { atLeast } from "../../shared/bot-access.ts";
import { BOARD_CLOSE_REASON_CHARS } from "../../shared/board.ts";
import { routineRunVisible, type VisibleSet } from "../bot-visibility.ts";
import { boardView, type BoardSources, type BoardViewer } from "../board.ts";
import type { BoardClosures } from "../board-closed.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BoardRouteDeps {
  sources: () => BoardSources;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  closures: BoardClosures;
  closerName: (auth: RequestAuth) => string;
  /** Moves a todo to Done by hand; the Board keeps no closure record for a todo card. */
  closeTodo?: (todoId: string, by: { kind: "person"; name: string }, reason?: string) => void;
  /** Why this person may not change a todo (on a Cloud a person changes only the todos they wrote); null when they may. */
  todoRefusal?: (auth: RequestAuth, todoId: string) => string | null;
  now?: () => number;
}

const closeBody = z.object({ cardId: z.string().min(1).max(200), reason: z.string().max(BOARD_CLOSE_REASON_CHARS).optional() });

/** GET /api/board: every open or recently finished piece of work this viewer may see, as cards in four columns.
 * POST /api/board/close: move one of the viewer's Needs you cards to Done. */
export function createBoardRoutes(deps: BoardRouteDeps): RouteHandler {
  const viewerOf = (visible: VisibleSet): BoardViewer => ({
    thread: (threadId) => visible.thread(threadId),
    bot: (botId) => visible.bot(botId),
    audience: (audience) => visible.shows(audience),
    routine: (run) => routineRunVisible(run, visible),
  });
  const view = (visible: VisibleSet) =>
    boardView({ ...deps.sources(), closed: (cardId) => deps.closures.get(cardId) }, viewerOf(visible), deps.now?.() ?? Date.now());
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/board/close") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = closeBody.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "cardId is required and reason is at most 200 characters" });
      const visible = deps.visibleFor(auth);
      const card = view(visible).cards.find((candidate) => candidate.id === parsed.data.cardId);
      if (!card) return json(res, 404, { error: "no such card" });
      if (card.column !== "needs-you") return json(res, 409, { error: "only a card in Needs you can be moved to Done" });
      if (!atLeast(visible.level(card.botId), "chat")) return json(res, 403, { error: "you cannot chat with this card's bot" });
      if (card.kind === "todo" && card.todoId) {
        const refusal = deps.todoRefusal?.(auth, card.todoId);
        if (refusal) return json(res, 403, { error: refusal });
      }
      const by = { kind: "person" as const, name: deps.closerName(auth) };
      if (card.kind === "todo" && card.todoId && deps.closeTodo) deps.closeTodo(card.todoId, by, parsed.data.reason);
      else deps.closures.close(card.id, by, parsed.data.reason);
      return json(res, 200, { ok: true });
    }
    if (path !== "/api/board") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    return json(res, 200, view(deps.visibleFor(auth)));
  };
}
