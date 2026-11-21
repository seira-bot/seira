import { routineRunVisible, type VisibleSet } from "../bot-visibility.ts";
import { boardView, type BoardSources, type BoardViewer } from "../board.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BoardRouteDeps {
  sources: () => BoardSources;
  visibleFor: (auth: RequestAuth) => VisibleSet;
  now?: () => number;
}

/** GET /api/board: every open or recently finished piece of work this viewer may see, as cards in four columns. */
export function createBoardRoutes(deps: BoardRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path !== "/api/board") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const visible = deps.visibleFor(auth);
    const viewer: BoardViewer = {
      thread: (threadId) => visible.thread(threadId),
      bot: (botId) => visible.bot(botId),
      routine: (run) => routineRunVisible(run, visible),
    };
    return json(res, 200, boardView(deps.sources(), viewer, deps.now?.() ?? Date.now()));
  };
}
