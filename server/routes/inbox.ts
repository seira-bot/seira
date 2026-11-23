import { userError } from "../user-errors.ts";
import type { InboxView } from "../../shared/inbox.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const MAX_DONE_IDS = 500;

export interface InboxRouteDeps {
  /** This viewer's inbox; null for someone on a team without one. */
  view(auth: RequestAuth): InboxView | null;
  /** How many of its lines wait on them; null for someone on a team without one. */
  count(auth: RequestAuth): number | null;
  markDone(auth: RequestAuth, id: string): "done" | "unknown" | "an ask";
  /** The named lines of news done, or with no ids all news that is no decision; asks stay open. Null for someone on a team without an inbox. */
  markDoneMany(auth: RequestAuth, ids?: string[]): number | null;
  markRead(auth: RequestAuth, id: string): boolean;
  /** Every line of this viewer's inbox read, asks included but none answered; null for someone on a team without one. */
  markAllRead(auth: RequestAuth): number | null;
}

/** GET /api/inbox: this viewer's inbox as its panel lists it. GET /api/inbox/count: how many of its lines wait on them. POST /api/inbox/read-all: all of its lines read, POST /api/inbox/done-all with optional `{ ids }` (at most 500): those lines, or all news, done, and POST /api/inbox/<line>/read and /done: one of its
 * lines read, or news they need nothing more from; each answers with the inbox as it lists them now. */
export function createInboxRoutes(deps: InboxRouteDeps): RouteHandler {
  return async ({ req, res, readBody, path, method, auth, json }) => {
    if (path === "/api/inbox") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const view = deps.view(auth);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    if (path === "/api/inbox/count") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const count = deps.count(auth);
      return count === null ? json(res, 404, { error: "There is no inbox here." }) : json(res, 200, { count });
    }
    if (path === "/api/inbox/read-all") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (deps.markAllRead(auth) === null) return json(res, 404, { ...userError("serverError.inbox.missing") });
      const view = deps.view(auth);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    if (path === "/api/inbox/done-all") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body: unknown = await readBody(req);
      const ids = body && typeof body === "object" && !Array.isArray(body) ? (body as { ids?: unknown }).ids : null;
      if (ids === null || (ids !== undefined && !(Array.isArray(ids) && ids.length <= MAX_DONE_IDS && ids.every((one) => typeof one === "string" && one.length >= 1 && one.length <= 512)))) {
        return json(res, 400, { ...userError("serverError.inbox.badIds") });
      }
      if (deps.markDoneMany(auth, ids as string[] | undefined) === null) return json(res, 404, { ...userError("serverError.inbox.missing") });
      const view = deps.view(auth);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    const m = /^\/api\/inbox\/([\w-]+)\/(read|done)$/.exec(path);
    if (!m) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const marked = m[2] === "read" ? (deps.markRead(auth, m[1]!) ? "done" : "unknown") : deps.markDone(auth, m[1]!);
    if (marked === "unknown") return json(res, 404, { ...userError("serverError.inbox.lineMissing") });
    if (marked === "an ask") return json(res, 409, { ...userError("serverError.inbox.answerRequired") });
    const view = deps.view(auth);
    return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
  };
}
