import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";
import { createReactionRoutes, type ReactionRouteDeps } from "./reactions.ts";
import { dispatchRoutes } from "./table.ts";
import { GENERIC_PUBLIC_ERROR, PublicError } from "../public-error.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const MESSAGE: Message = { id: "m1", at: 1, role: "bot", kind: "text", text: "Shall I send it?" };

async function fixture(overrides: Partial<ReactionRouteDeps> = {}) {
  const calls: Array<Parameters<ReactionRouteDeps["react"]>[0]> = [];
  const deps: ReactionRouteDeps = {
    react: async (input) => {
      calls.push(input);
      return { message: { ...MESSAGE, reactions: [{ emoji: input.emoji, by: input.reactor.by }] }, delivery: "started" };
    },
    reactorFor: () => ({ by: "p_alice", name: "alice@example.test" }),
    cloudGuestSendRefusal: () => null,
    ...overrides,
  };
  const routes = [createReactionRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { from: "no route" });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (body: unknown, method = "POST", path = "/api/threads/t1/messages/m1/reactions") => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(base + path, init);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { calls, send };
}

describe("POST /api/threads/:threadId/messages/:messageId/reactions", () => {
  it("reacts as the signed-in person, never as whoever the body names", async () => {
    const { calls, send } = await fixture();
    const sent = await send({ emoji: "👍", by: "bot-123", on: true });
    expect(sent).toEqual({ status: 200, body: { message: { ...MESSAGE, reactions: [{ emoji: "👍", by: "p_alice" }] }, delivery: "started" } });
    expect(calls).toEqual([{ auth: expect.objectContaining({ kind: "loopback" }), threadId: "t1", messageId: "m1", emoji: "👍", reactor: { by: "p_alice", name: "alice@example.test" }, on: true }]);
  });

  it("takes a reaction however a client or channel spells it", async () => {
    const { calls, send } = await fixture();
    for (const emoji of ["👍🏽", "+1", ":heart:", "❤"]) expect((await send({ emoji })).status, emoji).toBe(200);
    expect(calls.map((call) => [call.emoji, call.on])).toEqual([["👍", undefined], ["👍", undefined], ["❤️", undefined], ["❤️", undefined]]);
  });

  it("refuses an emoji outside the set and an `on` that is not a boolean, and reacts with neither", async () => {
    const { calls, send } = await fixture();
    expect(await send({ emoji: "🔥" })).toEqual({ status: 400, body: { error: "emoji must be one of 👍 👎 ❤️ 😂 🎉 👀" } });
    expect(await send({})).toMatchObject({ status: 400 });
    expect(await send({ emoji: "👍", on: "yes" })).toEqual({ status: 400, body: { error: "on must be true or false" } });
    expect(calls).toEqual([]);
  });

  it("refuses a Cloud guest in a conversation they did not start", async () => {
    const { calls, send } = await fixture({ cloudGuestSendRefusal: () => "On this Cloud you can only write in conversations you started. Start a new conversation with this bot." });
    expect(await send({ emoji: "👍" })).toEqual({ status: 403, body: { error: "On this Cloud you can only write in conversations you started. Start a new conversation with this bot." } });
    expect(calls).toEqual([]);
  });

  it("answers a refused delivery with its status and code", async () => {
    const { send } = await fixture({ react: async () => { throw Object.assign(new PublicError("this workspace has reached its monthly spend limit", 409), { code: "spend_cap" }); } });
    expect(await send({ emoji: "👍" })).toEqual({ status: 409, body: { error: "this workspace has reached its monthly spend limit", code: "spend_cap" } });
  });

  it("keeps the status of an error that is not public, and replaces its text with the generic text", async () => {
    const secret = "ENOENT: no such file or directory, open '/srv/data/private.json'";
    const { send } = await fixture({ react: async () => { throw Object.assign(new Error(secret), { status: 409, code: "spend_cap", errorKey: "serverError.example" }); } });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      const reply = await send({ emoji: "👍" });
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({ error: GENERIC_PUBLIC_ERROR, code: "spend_cap" });
      expect(JSON.stringify(reply.body)).not.toContain("private.json");
      expect(logged.join("\n")).toContain("private.json");
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves every other path and method to the routes after it", async () => {
    const { calls, send } = await fixture();
    expect(await send(undefined, "GET")).toEqual({ status: 404, body: { from: "no route" } });
    expect(await send({ emoji: "👍" }, "POST", "/api/threads/t1/messages/m1/reaction")).toEqual({ status: 404, body: { from: "no route" } });
    expect(calls).toEqual([]);
  });
});
