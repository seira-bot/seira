import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotMessageRoutes, type BotMessageRouteDeps } from "./bot-messages.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const admin = { kind: "session", scopes: ["admin", "client"] } as unknown as RequestAuth;
const client = { kind: "session", scopes: ["client"] } as unknown as RequestAuth;

async function start(auth: RequestAuth, refusal: string | null = null) {
  const reviewAppSetting = vi.fn((args: { threadId: string; requestId: string }, ownerReview: boolean) => {
    if (args.requestId === "unknown") return null;
    return ownerReview ? { status: 200, body: { before: "old", after: "new" } } : { status: 403, body: { error: "Only the owner sees this." } };
  });
  const deps = { store: { bots: [] }, routines: () => null, cardAnswerRefusal: () => refusal, reviewAppSetting, activeGroupTurnForBot: () => null, desktopManaged: false } as unknown as BotMessageRouteDeps;
  const routes = [createBotMessageRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (requestId: string) => {
    const response = await fetch(`${base}/api/threads/t1/app-settings/${requestId}/review`, { method: "POST" });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { get, reviewAppSetting };
}

it("gives the owner both values of a waiting settings card", async () => {
  const { get } = await start(admin);
  expect(await get("card")).toEqual({ status: 200, body: { before: "old", after: "new" } });
});

it("refuses a session that is not the owner", async () => {
  const { get } = await start(client);
  expect((await get("card")).status).toBe(403);
});

it("answers 404 for a card that is no settings card", async () => {
  const { get } = await start(admin);
  expect((await get("unknown")).status).toBe(404);
});

it("does not ask for the values when the session may not see the thread", async () => {
  const { get, reviewAppSetting } = await start(admin, "no such conversation");
  expect((await get("card")).status).toBe(403);
  expect(reviewAppSetting).not.toHaveBeenCalled();
});
