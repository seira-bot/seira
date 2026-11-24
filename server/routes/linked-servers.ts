// The admin's routes for links to servers of other owners (server/host/linked-servers.ts): the list, a new invite, the
// use of another server's invite, what a link exposes and at which approval cap, and its removal. The linked servers'
// own requests reach the manager before sign-in and never come here.
//
// Security invariant: each route here answers an admin only.
import type { IncomingMessage } from "node:http";
import { z } from "zod";

import type { AdminActor } from "../admin-activity.ts";
import { LinkedServerError, type LinkedServers } from "../host/linked-servers.ts";
import { APPROVAL_CAPS, botIdSchema } from "../host/linked-servers-store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const BASE = "/api/linked-servers";
const INVITES = `${BASE}/invites`;
const JOIN = `${BASE}/join`;
const ONE = /^\/api\/linked-servers\/([0-9a-f]{16})$/u;

const ADMIN_ONLY = "Only an admin can manage links to another Seira.";
const NOT_HERE = "That link is not here.";

const joinBody = z.object({ invite: z.string().min(1).max(4_096) }).strict();
const updateBody = z.object({ exposed: z.array(botIdSchema).max(500).optional(), cap: z.enum(APPROVAL_CAPS).optional() }).strict();

export interface LinkedServerRouteDeps {
  manager: Pick<LinkedServers, "list" | "invite" | "join" | "update" | "remove">;
  /** Whether a bot of this server has this id. */
  knownBot(id: string): boolean;
  /** Who did it, for the activity record. */
  actor(auth: RequestAuth, req: IncomingMessage): AdminActor;
}

export function createLinkedServerRoutes(deps: LinkedServerRouteDeps): RouteHandler {
  const { manager } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const id = ONE.exec(path)?.[1];
    const known = (path === BASE && method === "GET") || ((path === INVITES || path === JOIN) && method === "POST") || (id !== undefined && (method === "PATCH" || method === "DELETE"));
    if (!known) return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) { req.resume(); return json(res, 403, { error: ADMIN_ONLY }); }
    const actor = deps.actor(auth, req);

    if (path === BASE) return json(res, 200, { servers: manager.list() });

    if (path === INVITES) {
      req.resume();
      const made = manager.invite(actor);
      if (!("error" in made)) return json(res, 200, made);
      return json(res, 409, { error: made.error === "full"
        ? "This Seira already has as many links as it can keep. Remove one first."
        : "Another Seira cannot reach this one. Give it a secure public address first." });
    }

    if (path === JOIN) {
      const body = joinBody.safeParse(await readBody(req, 16 * 1024));
      if (!body.success) return json(res, 400, { error: "Paste the whole invite from the other side." });
      try {
        return json(res, 200, { server: await manager.join(body.data.invite, actor) });
      } catch (error) {
        if (error instanceof LinkedServerError) return json(res, error.status, { error: error.message });
        throw error;
      }
    }

    if (!id) return PASS;
    if (method === "DELETE") {
      req.resume();
      return (await manager.remove(id, actor)) ? json(res, 200, { ok: true }) : json(res, 404, { error: NOT_HERE });
    }
    const body = updateBody.safeParse(await readBody(req, 64 * 1024));
    if (!body.success) return json(res, 400, { error: "Choose your own bots and one of the approval levels." });
    if (body.data.exposed?.some((bot) => !deps.knownBot(bot))) return json(res, 400, { error: "One of those bots is not here." });
    const updated = manager.update(id, { ...(body.data.exposed ? { exposed: body.data.exposed } : {}), ...(body.data.cap ? { cap: body.data.cap } : {}) }, actor);
    return updated ? json(res, 200, { server: updated }) : json(res, 404, { error: NOT_HERE });
  };
}
