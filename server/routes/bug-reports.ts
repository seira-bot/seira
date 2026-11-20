import { z } from "zod";

import type { DevsReports } from "../host/devs-reports.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const createSchema = z.object({ threadId: z.string().min(1).max(200), error: z.string().min(1).max(8_000) }).strict();

export interface BugReportRoutesDeps {
  reports: Pick<DevsReports, "draftThread" | "viewDraft" | "sendDraft" | "dismissDraft" | "fromError">;
  /** The reader's reaction key: a draft opens only for the person it is for. */
  person(auth: RequestAuth): string;
  /** Whether this reader may see the conversation. */
  sees(auth: RequestAuth, threadId: string): boolean;
}

const GONE = "That report is gone.";

/** A bug report draft is read, sent and put away here, only by the person it is for. "Send report" is the one way a draft
 * leaves this machine, and it is reachable only from a person's press: no bot tool calls it. */
export function createBugReportRoutes(deps: BugReportRoutesDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/bug-reports/drafts") {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const parsed = createSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "A report needs the conversation and the error." });
      if (!deps.sees(auth, parsed.data.threadId)) return json(res, 404, { error: GONE });
      const view = deps.reports.fromError(parsed.data.threadId, parsed.data.error, deps.person(auth));
      return view ? json(res, 200, view) : json(res, 422, { error: "This error is not one to report." });
    }
    const match = /^\/api\/bug-reports\/drafts\/([A-Za-z0-9_-]{8,64})(?:\/(send|dismiss))?$/.exec(path);
    if (!match) return PASS;
    const [, id, action] = match;
    const threadId = deps.reports.draftThread(id!);
    if (!threadId || !deps.sees(auth, threadId)) return json(res, 404, { error: GONE });
    const person = deps.person(auth);
    if (!action) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const view = deps.reports.viewDraft(id!, person);
      return view ? json(res, 200, view) : json(res, 404, { error: GONE });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (action === "dismiss") {
      const done = deps.reports.dismissDraft(id!, person);
      if (done === "gone") return json(res, 404, { error: GONE });
      if (done === "busy") return json(res, 409, { error: "This report is already on its way." });
      res.writeHead(204).end();
      return;
    }
    const sent = await deps.reports.sendDraft(id!, person);
    if (!("error" in sent)) return json(res, 200, sent);
    if (sent.error === "gone") return json(res, 404, { error: GONE });
    return json(res, 409, { error: "The report could not be sent. Try again later." });
  };
}
