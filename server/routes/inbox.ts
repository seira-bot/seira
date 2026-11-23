import { userError } from "../user-errors.ts";
import type { InboxView } from "../../shared/inbox.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const MAX_DONE_IDS = 500;

/** A boolean field a body may leave out; "bad" for a body or a field of any other kind. */
function optionalFlag(body: unknown, key: string): boolean | "bad" {
  if (body === undefined || body === null) return false;
  if (typeof body !== "object" || Array.isArray(body)) return "bad";
  const value = (body as Record<string, unknown>)[key];
  return value === undefined ? false : typeof value === "boolean" ? value : "bad";
}

export interface InboxRouteDeps {
  /** This viewer's inbox; null for someone on a team without one. */
  view(auth: RequestAuth): InboxView | null;
  /** How many of its lines wait on them; null for someone on a team without one. */
  count(auth: RequestAuth): number | null;
  markDone(auth: RequestAuth, id: string): "done" | "unknown" | "an ask";
  /** The named lines of news done, or with no ids all news that is no decision; asks stay open. Null for someone on a team without an inbox. */
  markDoneMany(auth: RequestAuth, ids?: string[]): number | null;
  markRead(auth: RequestAuth, id: string): boolean;
  /** The line's decision mark cleared; false for a line this viewer lacks, null for someone on a team. */
  notDecision(auth: RequestAuth, id: string): boolean | null;
  /** Every line of this viewer's inbox read, asks included but none answered; null for someone on a team without one. */
  markAllRead(auth: RequestAuth): number | null;
  /** The summary of this viewer's news, written now when enough is unread or when forced; null for someone on a team. */
  summarize(auth: RequestAuth, options: { force: boolean }): Promise<InboxView | null>;
  /** The summary hidden, counted as not useful when `wrong`; null for someone on a team. */
  hideSummary(auth: RequestAuth, wrong: boolean): InboxView | null;
  /** Who writes the summary, or null for nobody; null for someone on a team. */
  setSummarizer(auth: RequestAuth, botId: string | null): "ok" | "unknown" | "refused" | null;
}

/** GET /api/inbox: this viewer's inbox as its panel lists it. GET /api/inbox/count: how many of its lines wait on them. POST /api/inbox/read-all: all of its lines read, POST /api/inbox/done-all with optional `{ ids }` (at most 500): those lines, or all news, done, and POST /api/inbox/<line>/read and /done: one of its
 * lines read, or news they need nothing more from; POST /api/inbox/<line>/not-decision: a line the person says is no decision;
 * POST /api/inbox/summary with optional `{ force }`: the summary of the news, written now when enough is unread or when forced, and the call waits for it;
 * POST /api/inbox/summary/hide with optional `{ wrong }`: the summary hidden; POST /api/inbox/summarizer with `{ botId }` (null for none): who writes it; each answers with the inbox as it lists them now. */
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
    if (path === "/api/inbox/summary" || path === "/api/inbox/summary/hide") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const key = path === "/api/inbox/summary" ? "force" : "wrong";
      const body: unknown = await readBody(req);
      const flag = optionalFlag(body, key);
      if (flag === "bad") return json(res, 400, { ...userError("serverError.inbox.badSummary") });
      const view = key === "force" ? await deps.summarize(auth, { force: flag }) : deps.hideSummary(auth, flag);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    if (path === "/api/inbox/summarizer") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const body: unknown = await readBody(req);
      const botId = body && typeof body === "object" && !Array.isArray(body) ? (body as { botId?: unknown }).botId : undefined;
      if (botId === undefined || (botId !== null && (typeof botId !== "string" || botId.length < 1 || botId.length > 512))) {
        return json(res, 400, { ...userError("serverError.inbox.badSummarizer") });
      }
      const outcome = deps.setSummarizer(auth, botId as string | null);
      if (outcome === null) return json(res, 404, { ...userError("serverError.inbox.missing") });
      if (outcome === "refused") return json(res, 403, { ...userError("serverError.inbox.summaryOwnerOnly") });
      if (outcome === "unknown") return json(res, 400, { ...userError("serverError.inbox.badSummarizer") });
      const view = deps.view(auth);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    const m = /^\/api\/inbox\/([\w-]+)\/(read|done|not-decision)$/.exec(path);
    if (!m) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (m[2] === "not-decision") {
      const cleared = deps.notDecision(auth, m[1]!);
      if (cleared === null) return json(res, 404, { ...userError("serverError.inbox.missing") });
      if (!cleared) return json(res, 404, { ...userError("serverError.inbox.lineMissing") });
      const view = deps.view(auth);
      return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
    }
    const marked = m[2] === "read" ? (deps.markRead(auth, m[1]!) ? "done" : "unknown") : deps.markDone(auth, m[1]!);
    if (marked === "unknown") return json(res, 404, { ...userError("serverError.inbox.lineMissing") });
    if (marked === "an ask") return json(res, 409, { ...userError("serverError.inbox.answerRequired") });
    const view = deps.view(auth);
    return view ? json(res, 200, view) : json(res, 404, { ...userError("serverError.inbox.missing") });
  };
}
