import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { ownerReview } from "./owner-review.ts";
import { dispatchRoutes } from "./table.ts";
import { createUndoRoutes } from "./undo.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const client: RequestAuth = { kind: "session", scopes: ["client"] } as unknown as RequestAuth;
const admin: RequestAuth = { kind: "session", scopes: ["admin", "client"] } as unknown as RequestAuth;
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function start(auth: RequestAuth, state: { busy: boolean }, settingsCards: string[]) {
  const undo = vi.fn(async (_auth: RequestAuth, res: Parameters<typeof json>[0]) => { json(res, 200, { ok: true }); });
  const routes = [createUndoRoutes({
    refusal: () => null,
    ownerOnly: (_threadId, requestId) => settingsCards.includes(requestId),
    ownerReview: (who, req) => ownerReview(who, req, { desktopManaged: false, anyBotWorking: () => state.busy }),
    undo,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (requestId: string, headers: Record<string, string> = {}) => fetch(`${base}/api/threads/t1/undo`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ requestId }),
  });
  return { undo, post, base };
}

it("refuses the Undo of a settings card from a client-scope session and writes nothing", async () => {
  const { undo, post } = await start(client, { busy: false }, ["card"]);
  const response = await post("card");
  expect(response.status).toBe(403);
  expect(undo).not.toHaveBeenCalled();
});

it("lets an admin session undo a settings card", async () => {
  const { undo, post } = await start(admin, { busy: false }, ["card"]);
  expect((await post("card")).status).toBe(200);
  expect(undo).toHaveBeenCalledTimes(1);
});

it("refuses a local request without an Origin header, and one from a browser while a bot is busy", async () => {
  const state = { busy: false };
  const { undo, post, base } = await start(loopback, state, ["card"]);
  expect((await post("card")).status).toBe(403);
  state.busy = true;
  expect((await post("card", { origin: base })).status).toBe(403);
  expect(undo).not.toHaveBeenCalled();
  state.busy = false;
  expect((await post("card", { origin: base })).status).toBe(200);
});

it("keeps the answer-the-card rule only for a card that is no settings card", async () => {
  const { undo, post } = await start(client, { busy: false }, ["card"]);
  expect((await post("other")).status).toBe(200);
  expect(undo).toHaveBeenCalledTimes(1);
});
