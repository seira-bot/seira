// The admin's routes for links to servers of other owners (server/host/linked-servers.ts): the list, a new invite, the
// use of another server's invite, a new link to an A2A agent and a new token for it, what a link exposes and at which
// approval cap, and its removal. The linked servers' and A2A agents' own requests reach the manager before sign-in and
// never come here.
//
// Security invariant: each route here answers an admin only.
import type { IncomingMessage } from "node:http";
import { z } from "zod";

import type { AdminActor } from "../admin-activity.ts";
import { LinkedServerError, type LinkedServers } from "../host/linked-servers.ts";
import { URL_MAX } from "../host/a2a-peers-store.ts";
import { APPROVAL_CAPS, botIdSchema } from "../host/linked-servers-store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const BASE = "/api/linked-servers";
const INVITES = `${BASE}/invites`;
const JOIN = `${BASE}/join`;
const A2A = `${BASE}/a2a`;
const ONE = /^\/api\/linked-servers\/([0-9a-f]{16})$/u;
const TOKEN = /^\/api\/linked-servers\/([0-9a-f]{16})\/token$/u;

const ADMIN_ONLY = "Only an admin can manage links to another Seira.";
const NOT_HERE = "That link is not here.";
const NOT_A_BOT = "One of those bots is not here.";

const joinBody = z.object({ invite: z.string().min(1).max(4_096) }).strict();
const exposed = z.array(botIdSchema).max(500);
const name = z.string().max(1_000);
const url = z.string().max(URL_MAX);
const token = z.string().min(1).max(4_096);
const addBody = z.object({ name, url: url.optional(), token: token.optional(), inbound: z.boolean(), exposed: exposed.optional(), cap: z.enum(APPROVAL_CAPS).optional() }).strict();
const updateBody = z.object({
  exposed: exposed.optional(), cap: z.enum(APPROVAL_CAPS).optional(),
  name: name.optional(), url: url.nullable().optional(), token: token.nullable().optional(), inbound: z.literal(false).optional(),
}).strict();

export interface LinkedServerRouteDeps {
  manager: Pick<LinkedServers, "list" | "invite" | "join" | "update" | "remove" | "addA2a" | "rotateA2a">;
  /** Whether a bot of this server has this id. */
  knownBot(id: string): boolean;
  /** Who did it, for the activity record. */
  actor(auth: RequestAuth, req: IncomingMessage): AdminActor;
}

export function createLinkedServerRoutes(deps: LinkedServerRouteDeps): RouteHandler {
  const { manager } = deps;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const id = ONE.exec(path)?.[1];
    const tokenOf = TOKEN.exec(path)?.[1];
    const known = (path === BASE && method === "GET") || ((path === INVITES || path === JOIN || path === A2A) && method === "POST")
      || (id !== undefined && (method === "PATCH" || method === "DELETE")) || (tokenOf !== undefined && method === "POST");
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

    try {
      if (path === JOIN) {
        const body = joinBody.safeParse(await readBody(req, 16 * 1024));
        if (!body.success) return json(res, 400, { error: "Paste the whole invite from the other side." });
        return json(res, 200, { server: await manager.join(body.data.invite, actor) });
      }

      if (path === A2A) {
        const body = addBody.safeParse(await readBody(req, 64 * 1024));
        if (!body.success) return json(res, 400, { error: "Check the name, the address and the token of the A2A agent." });
        if (body.data.exposed?.some((bot) => !deps.knownBot(bot))) return json(res, 400, { error: NOT_A_BOT });
        return json(res, 200, manager.addA2a(body.data, actor));
      }

      if (tokenOf !== undefined) {
        req.resume();
        const made = manager.rotateA2a(tokenOf, actor);
        return made ? json(res, 200, made) : json(res, 404, { error: NOT_HERE });
      }

      if (!id) return PASS;
      if (method === "DELETE") {
        req.resume();
        return (await manager.remove(id, actor)) ? json(res, 200, { ok: true }) : json(res, 404, { error: NOT_HERE });
      }
      const body = updateBody.safeParse(await readBody(req, 64 * 1024));
      if (!body.success) return json(res, 400, { error: "Choose your own bots and one of the approval levels." });
      if (body.data.exposed?.some((bot) => !deps.knownBot(bot))) return json(res, 400, { error: NOT_A_BOT });
      const updated = manager.update(id, body.data, actor);
      return updated ? json(res, 200, { server: updated }) : json(res, 404, { error: NOT_HERE });
    } catch (error) {
      if (error instanceof LinkedServerError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
