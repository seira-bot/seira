import type { IncomingMessage } from "node:http";

import type { AdminActionRow } from "../admin-activity.ts";
import type { PeopleLimit } from "../people-limit.ts";
import type { RequestAuth } from "../request-auth.ts";
import { userError } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

const KEY_MAX_CHARS = 4096;

export interface PeoplePlanRouteDeps {
  people: PeopleLimit;
  /** Records an admin action. Receives the action without its actor. */
  audit?(auth: RequestAuth, req: IncomingMessage, row: Omit<AdminActionRow, "at" | "actor">): void;
}

export function createPeoplePlanRoutes({ people, audit }: PeoplePlanRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody, auth }) => {
    if (path === "/api/people/plan" && method === "GET") return json(res, 200, people.status());
    if (path === "/api/people/plan/key" && method === "PUT") {
      const body = await readBody(req);
      const key = body?.key;
      if (typeof key !== "string" || !key.trim() || key.length > KEY_MAX_CHARS) return json(res, 400, { error: "send the key as text", code: "key_invalid" });
      const saved = people.saveKey(key);
      if (!saved.ok) {
        if (saved.reason === "ended") return json(res, 400, { ...userError("serverError.premiumKey.ended"), code: "key_ended" });
        if (saved.reason === "environment") return json(res, 409, { ...userError("serverError.premiumKey.locked"), code: "key_locked" });
        return json(res, 400, { ...userError("serverError.premiumKey.invalid"), code: "key_invalid" });
      }
      const status = people.status();
      audit?.(auth, req, {
        category: "people", action: "people.key", target: { kind: "settings" }, changed: ["premiumKey"],
        after: { customer: status.key?.customer ?? null, endsOn: status.key?.endsOn ?? null },
      });
      return json(res, 200, status);
    }
    if (path === "/api/people/plan/remove" && method === "POST") {
      const body = await readBody(req);
      const email = body?.email;
      if (typeof email !== "string" || !email.trim()) return json(res, 400, { error: "send the address as text", code: "unknown" });
      const removed = people.removeJoined(email);
      if (removed === "listed") return json(res, 409, { error: "remove this address from the sign-in list instead", code: "listed" });
      if (removed === "unknown") return json(res, 404, { error: "nobody with that address holds a place", code: "unknown" });
      if (removed === "failed") return json(res, 500, { error: "the removal could not be saved, so nobody was removed; try again", code: "remove_failed" });
      audit?.(auth, req, { category: "people", action: "people.remove", target: { kind: "person", id: email.trim().toLowerCase() } });
      return json(res, 200, people.status());
    }
    return PASS;
  };
}
