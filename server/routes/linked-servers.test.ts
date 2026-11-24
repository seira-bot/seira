import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { linkedId, peerKey, type FileWay } from "../bot-link/protocol.ts";
import { createCoordinator, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { json, readBody } from "../harness/http.ts";
import type { PassedFile } from "../host/handoff-files.ts";
import { createLinkedServers, type LinkedServerView, type LinkedServers } from "../host/linked-servers.ts";
import { INVITE_TTL_MS, decodeInvite, encodeInvite, hashSecret } from "../host/linked-servers-store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createLinkedServerRoutes } from "./linked-servers.ts";
import { PASS } from "./table.ts";

type Bot = { id: string; name: string };
type Answer = { status: number; body: Record<string, unknown> };
const WRITER: Bot = { id: "writer", name: "Writer" }, ANALYST: Bot = { id: "analyst", name: "Analyst" }, SCOUT: Bot = { id: "scout", name: "Scout" };
const USED = "That invite is not valid any more. Ask for a new one.";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const until = async (what: () => boolean, label: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** One server: the manager, the admin routes, a coordinator over its links, and a stand-in for every other route. */
async function side(label: string, bots: Bot[], now?: () => number, more: Partial<Parameters<typeof createLinkedServers>[0]> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `linked-servers-${label}-`));
  const rows: Array<Omit<AdminActionRow, "at">> = [], runs: string[] = [], reached: string[] = [];
  const results: Array<{ name: string; status: string; result: string }> = [];
  const asked: Array<{ url: string; status: number }> = [];
  const threads = new Set<string>();
  const knobs: { run(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult> } = { run: async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` }) };
  let opened = 0, port = 0, turns = 0;
  let coordinator: Coordinator | undefined;
  const tick = () => { try { coordinator?.tick(); } catch { /* closed */ } };
  const ask = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetch(input, init);
    asked.push({ url: String(input), status: response.status });
    return response;
  }) as typeof fetch;

  const manager: LinkedServers = createLinkedServers({
    dataDir, coordinator: () => coordinator!, bots: () => bots, bot: (id) => bots.find((bot) => bot.id === id), level: () => "full",
    openThread: (bot) => { const id = `${bot.id}-work-${++opened}`; threads.add(id); return id; },
    hasThread: (_botId, threadId) => threads.has(threadId), personName: () => undefined, sentRow: () => {},
    resultRow: (_parent, child, name) => { results.push({ name, status: child.status, result: child.result }); },
    kick: () => { queueMicrotask(tick); },
    serverName: () => label, selfId: () => `${label}-environment`, publicOrigin: () => `http://127.0.0.1:${port}`,
    audit: (row) => { rows.push(row); }, attemptAllowed: () => true, fetch: ask, allowLoopback: true,
    timing: { holdMs: 250, firstRetryMs: 20, seenMs: 5_000, pace: { gapMs: 20, freshMs: 20 } },
    ...(now ? { now } : {}), ...more,
  });
  const inner: CoordinatorHost = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
    names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
    levelOf: () => ({ level: "full" }), chiefOf: () => false,
    run: (node, _resumed, signal) => { runs.push(node.botId); return knobs.run(node, signal); },
  };
  // Each link's own host wraps the one before it, as the server composes them; links come and go while it runs.
  const host = new Proxy(inner, { get: (_target, prop) => Reflect.get(manager.instances().reduce((outer, one) => one.link.host(outer), inner), prop) });
  coordinator = createCoordinator({ dataDir, host, log: () => {} });

  const routes = createLinkedServerRoutes({ manager, knownBot: (id) => bots.some((bot) => bot.id === id), actor: () => ({ kind: "loopback" }) });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET" };
    try {
      if (await manager.serve(ctx)) return;
      const auth: RequestAuth = { kind: "loopback", scopes: req.headers["x-test-member"] ? ["client"] : ["admin", "client"] };
      if (await routes({ ...ctx, auth, json, readBody }) !== PASS) return;
      reached.push(`${ctx.method} ${ctx.path}`);
      req.resume();
      json(res, 200, { ok: true });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (!res.headersSent) json(res, typeof status === "number" ? status : 500, { error: "The request failed." });
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const ticker = setInterval(tick, 15);
  cleanups.push(async () => {
    clearInterval(ticker);
    manager.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { coordinator?.close(); } catch { /* closed */ }
    await removeTempDir(dataDir);
  });

  const origin = `http://127.0.0.1:${port}`;
  return {
    label, origin, dataDir, manager, rows, runs, reached, results, asked, knobs,
    view: (): LinkedServerView | undefined => manager.list()[0],
    async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
      const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    /** One of this server's bots hands work to `target`, an address another server's bot has here. */
    async handOff(from: Bot, target: string, message: string) {
      const id = `${label}-turn-${++turns}`, address = { botId: from.id, threadId: `${from.id}-chat` };
      coordinator!.beginTurn({ id, address, brief: message, level: "full", origin: { kind: "user", request: message } });
      const owner = manager.instances().find((one) => one.link.claims(target));
      if (!owner) throw new Error(`no link claims ${target}`);
      const answer = await owner.link.coordinate({ botIds: [target], message, rework: false, thread: "new", reply: "resume", consult: false },
        { sender: from, address, generation: id, external: false, handed: () => {} }, async () => ({ status: 200, body: { receipts: [] } }));
      coordinator!.endTurn(id, { ok: true, text: "Handed on." });
      return answer;
    },
  };
}
type Side = Awaited<ReturnType<typeof side>>;

/** The inviter makes an invite and the joiner uses it, over their routes; both then wait to see the other online. */
async function link(inviter: Side, joiner: Side) {
  const made = await inviter.api("POST", "/api/linked-servers/invites");
  expect(made.status).toBe(200);
  const invite = String(made.body.invite);
  expect((await joiner.api("POST", "/api/linked-servers/join", { invite })).status).toBe(200);
  await until(() => inviter.view()?.state === "online" && joiner.view()?.state === "online", "both servers are online");
  const token = joiner.manager.instances()[0]!.link.dial()!.token;
  return { invite, code: decodeInvite(invite)!.code, token, inviterLink: inviter.view()!.id, joinerLink: joiner.view()!.id };
}

async function expose(inviter: Side, joiner: Side, bots: string[]) {
  const answer = await inviter.api("PATCH", `/api/linked-servers/${inviter.view()!.id}`, { exposed: bots });
  expect(answer.status).toBe(200);
  await until(() => joiner.view()?.bots.length === bots.length, "the joiner sees the exposed bots");
}

describe("two linked servers", () => {
  it("link by invite: each lists the other by name, and the joiner sees only the bots the inviter exposed", async () => {
    const a = await side("head", [WRITER, ANALYST]), b = await side("branch", [SCOUT]);
    const { token } = await link(a, b);
    expect(a.view()).toMatchObject({ name: "branch", role: "inviter", exposed: [], cap: "ask", bots: [] });
    expect(b.view()).toMatchObject({ name: "head", role: "joiner", exposed: [], cap: "ask", bots: [] });

    await expose(a, b, ["writer"]);
    expect(b.view()!.bots).toEqual([{ id: linkedId(peerKey(`guest:${b.view()!.id}`), "writer"), name: "Writer" }]);
    const listed = [await a.api("GET", "/api/linked-servers"), await b.api("GET", "/api/linked-servers")];
    expect((listed[0]!.body.servers as LinkedServerView[]).map((one) => one.name)).toEqual(["branch"]);
    expect((listed[1]!.body.servers as LinkedServerView[]).map((one) => one.name)).toEqual(["head"]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(hashSecret(token));
  }, 30_000);

  it("hand work to an exposed bot and bring its result back, refuse a bot that is not exposed, and apply a new exposed list at once", async () => {
    const a = await side("head", [WRITER, ANALYST]), b = await side("branch", [SCOUT]);
    const { invite, code, token, joinerLink } = await link(a, b);
    await expose(a, b, ["writer"]);
    const writer = b.view()!.bots[0]!.id;

    expect((await b.handOff(SCOUT, writer, "Draft the launch post")).status).toBe(200);
    await until(() => b.results.length === 1, "the writer's result is back");
    expect(b.results[0]).toMatchObject({ status: "completed", result: "writer did: Draft the launch post" });

    // The branch still lists a bot the head no longer offers, as after a list that has not come yet.
    const key = peerKey(`guest:${joinerLink}`);
    b.manager.instances()[0]!.link.receive(key, [{ t: "hello", place: { id: "head-environment", name: "head" }, bots: [WRITER, ANALYST] }]);
    await b.handOff(SCOUT, linkedId(key, "analyst"), "Check the numbers");
    await until(() => b.results.length === 2, "the refusal is back");
    expect(b.results[1]!.status).not.toBe("completed");
    expect(a.runs).toEqual(["writer"]);
    expect(a.rows.filter((row) => row.action === "linked-server.refused").map((row) => row.after)).toMatchObject([{ reason: "bot", bot: "analyst", farBot: "scout" }]);

    await expose(a, b, ["writer", "analyst"]);
    await b.handOff(SCOUT, linkedId(key, "analyst"), "Check the numbers");
    await until(() => b.results.length === 3, "the analyst's result is back");
    expect(b.results[2]).toMatchObject({ status: "completed", result: "analyst did: Check the numbers" });
    expect(a.runs).toEqual(["writer", "analyst"]);

    const rows = [...a.rows, ...b.rows];
    expect(new Set(rows.map((row) => row.action))).toEqual(new Set(["linked-server.invite", "linked-server.accept", "linked-server.join", "linked-server.update", "linked-server.handoff", "linked-server.refused"]));
    expect(b.rows.filter((row) => row.action === "linked-server.handoff").map((row) => row.after)).toContainEqual(expect.objectContaining({ direction: "result-received", farBot: "writer", state: "done", outcome: "done" }));
    expect(a.rows.filter((row) => row.action === "linked-server.handoff").map((row) => row.actor)).toContainEqual({ kind: "linked-server", linkId: a.view()!.id, name: "branch" });
    const recorded = JSON.stringify(rows);
    for (const secret of [invite, code, hashSecret(code), token, hashSecret(token), "lsk_", "seira-link:"]) expect(recorded).not.toContain(secret);
    expect(recorded).not.toMatch(/Draft|launch|numbers|did:/u);
  }, 30_000);

  it("take in a far bot's name, a hand-off's words and a result's words without an invisible or control character", async () => {
    const hidden = ["\u202e", "\u200b", "\u{e0041}", "\u3164", "\u0007"], all = hidden.join("");
    const a = await side("head", [{ id: "writer", name: `Wri${all}ter` }]), b = await side("branch", [SCOUT]);
    await link(a, b);
    await expose(a, b, ["writer"]);
    const briefs: string[] = [];
    a.knobs.run = async (node) => { briefs.push(node.text); return { ok: true, text: `Done${all} here` }; };
    const writer = b.view()!.bots[0]!;
    expect((await b.handOff(SCOUT, writer.id, `Draft${all} the post`)).status).toBe(200);
    await until(() => b.results.length === 1, "the result is back");
    const taken = [writer.name, ...briefs, b.results[0]!.result];
    expect(taken.map((text) => hidden.filter((one) => text.includes(one)))).toEqual([[], [], []]);
    expect(taken).toEqual(["Wri ter", expect.stringMatching(/Draft +the post/u), expect.stringMatching(/Done +here/u)]);
  }, 30_000);

  it("give a far image's name no control or zero width character, and still find its bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linked-servers-image-"));
    cleanups.push(() => removeTempDir(dir));
    writeFileSync(join(dir, "photo.png"), "x".repeat(5));
    const image: PassedFile = { kind: "image", path: join(dir, "photo.png"), name: "pho\u0007to\u200b.png", mime: "image/png", bytes: 5 };
    const stored: string[] = [];
    const files = (sent: PassedFile[]) => ({ files: {
      carried: (_id: string, way: FileWay) => (way === "sent" ? sent : []), crossed: () => {},
      store: async (got: ReadonlyArray<{ path: string; name: string }>) => got.map((one): PassedFile => { stored.push(one.name); return { ...image, path: one.path, name: one.name }; }),
    } });
    const a = await side("head", [WRITER], undefined, files([])), b = await side("branch", [SCOUT], undefined, files([image]));
    await link(a, b);
    await expose(a, b, ["writer"]);
    expect((await b.handOff(SCOUT, b.view()!.bots[0]!.id, "Look at the photo")).status).toBe(200);
    await until(() => b.results.length === 1, "the result is back");
    expect([stored, b.results[0]!.status]).toEqual([["pho to.png"], "completed"]);
  }, 30_000);

  it("refuse the thirty-first hand-off in a minute, with one activity row for the refusals", async () => {
    const a = await side("head", [WRITER]), b = await side("branch", [SCOUT]);
    await link(a, b);
    await expose(a, b, ["writer"]);
    const writer = b.view()!.bots[0]!.id;
    for (let index = 1; index <= 32; index++) {
      await b.handOff(SCOUT, writer, `Task ${index}`);
      await until(() => b.results.length === index, `hand-off ${index} is back`);
    }
    expect(b.results.slice(0, 30).every((one) => one.status === "completed")).toBe(true);
    expect(b.results.slice(30).map((one) => one.status)).not.toContain("completed");
    expect(a.runs).toHaveLength(30);
    expect(a.rows.filter((row) => row.action === "linked-server.refused").map((row) => row.after)).toEqual([{ reason: "limit", bot: "writer", farBot: "scout", handoff: expect.any(String), count: 1 }]);
  }, 60_000);

  it("remove on the inviter: the joiner's credential stops working, the joiner shows the link as ended, and its waiting work fails", async () => {
    const a = await side("head", [WRITER]), b = await side("branch", [SCOUT]);
    const { token, inviterLink } = await link(a, b);
    await expose(a, b, ["writer"]);
    let stopped = false;
    a.knobs.run = (_node, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { stopped = true; resolve({ ok: false, text: "stopped" }); }); });
    await b.handOff(SCOUT, b.view()!.bots[0]!.id, "Write the long report");
    await until(() => a.runs.length === 1, "the writer works");

    expect((await a.api("DELETE", `/api/linked-servers/${inviterLink}`)).status).toBe(200);
    expect(a.manager.list()).toEqual([]);
    expect(existsSync(join(a.dataDir, "linked-servers", inviterLink))).toBe(false);
    await until(() => stopped, "the writer's turn is stopped");
    await until(() => b.view()?.state === "ended", "the joiner shows the link as ended");
    await until(() => b.results.length === 1, "the waiting work fails");
    expect(b.results[0]!.status).not.toBe("completed");
    expect(b.results[0]!.result).toContain("another Seira");
    expect(b.asked.some((one) => one.url.endsWith("/api/linked-servers/sync") && (one.status === 401 || one.status === 403))).toBe(true);
    expect((await fetch(`${a.origin}/api/linked-servers/sync`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ack: 0, frames: [], wait: 0 }) })).status).toBe(401);
    expect(a.rows.filter((row) => row.action === "linked-server.remove")).toMatchObject([{ target: { kind: "linked-server", id: inviterLink, name: "branch" } }]);
  }, 30_000);

  it("remove on the joiner: the inviter stops the joiner's work at once and shows the link as ended", async () => {
    const a = await side("head", [WRITER]), b = await side("branch", [SCOUT]);
    const { joinerLink } = await link(a, b);
    await expose(a, b, ["writer"]);
    let stopped = false;
    a.knobs.run = (_node, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { stopped = true; resolve({ ok: false, text: "stopped" }); }); });
    await b.handOff(SCOUT, b.view()!.bots[0]!.id, "Write the long report");
    await until(() => a.runs.length === 1, "the writer works");

    expect((await b.api("DELETE", `/api/linked-servers/${joinerLink}`)).status).toBe(200);
    expect(b.manager.list()).toEqual([]);
    await until(() => stopped, "the writer's turn is stopped");
    await until(() => a.view()?.state === "ended", "the inviter shows the link as ended");
    expect(a.runs).toEqual(["writer"]);
  }, 30_000);

  it("refuse an invite used twice or expired, and an invite to an address that is not secure before anything is asked", async () => {
    let skew = 0;
    const a = await side("head", [WRITER], () => Date.now() + skew), b = await side("branch", [SCOUT]), c = await side("other", [SCOUT]);
    const { invite } = await link(a, b);
    expect(await c.api("POST", "/api/linked-servers/join", { invite })).toEqual({ status: 409, body: { error: USED } });

    const later = await a.api("POST", "/api/linked-servers/invites");
    skew += INVITE_TTL_MS + 1_000;
    expect(await c.api("POST", "/api/linked-servers/join", { invite: later.body.invite })).toEqual({ status: 409, body: { error: USED } });

    const insecure = encodeInvite({ origin: "http://lan-host.example:8123", name: "head", code: decodeInvite(String(later.body.invite))!.code });
    const asked = c.asked.length;
    expect(await c.api("POST", "/api/linked-servers/join", { invite: insecure })).toEqual({ status: 400, body: { error: "That invite points to an address that is not secure or not public, so it was not used." } });
    expect(c.asked).toHaveLength(asked);
    expect(c.asked.some((one) => one.url.includes("lan-host"))).toBe(false);
    expect(a.manager.list()).toHaveLength(1);
    expect(c.manager.list()).toEqual([]);
  }, 30_000);

  it("answer an admin only on each route, and refuse a link's credential on every other path", async () => {
    const a = await side("head", [WRITER]), b = await side("branch", [SCOUT]);
    const { token, inviterLink } = await link(a, b);
    const member = { "x-test-member": "1" };
    for (const [method, path, body] of [["GET", "/api/linked-servers", undefined], ["POST", "/api/linked-servers/invites", undefined], ["POST", "/api/linked-servers/join", { invite: "x" }],
      ["PATCH", `/api/linked-servers/${inviterLink}`, { cap: "auto" }], ["DELETE", `/api/linked-servers/${inviterLink}`, undefined]] as const) {
      expect(await a.api(method, path, body, member), `${method} ${path}`).toEqual({ status: 403, body: { error: "Only an admin can manage links to another Seira." } });
    }
    expect(a.view()).toMatchObject({ cap: "ask", state: "online" });

    for (const [method, path] of [["GET", "/api/bots"], ["POST", "/api/bot-link/sync"]] as const) {
      expect((await a.api(method, path, undefined, { authorization: `Bearer ${token}` })).status, path).toBe(403);
    }
    expect(a.reached).toEqual([]);
    expect((await a.api("GET", "/api/bots")).status).toBe(200);
    expect(a.reached).toEqual(["GET /api/bots"]);

    expect(await a.api("PATCH", `/api/linked-servers/${inviterLink}`, { exposed: ["ghost"] })).toEqual({ status: 400, body: { error: "One of those bots is not here." } });
    expect((await a.api("PATCH", `/api/linked-servers/${inviterLink}`, { exposed: ["writer"], extra: true })).status).toBe(400);
    expect((await a.api("PATCH", "/api/linked-servers/ffffffffffffffff", { cap: "auto" })).status).toBe(404);
    expect((await a.api("PATCH", `/api/linked-servers/${inviterLink}`, { cap: "edits" })).body.server).toMatchObject({ cap: "edits" });
  }, 30_000);
});

describe("the admin routes", () => {
  it("say in plain words why no invite was made", async () => {
    let made: ReturnType<LinkedServers["invite"]> = { error: "no_address" };
    const routes = createLinkedServerRoutes({
      manager: { list: () => [], invite: () => made, join: async () => { throw new Error("not used"); }, update: () => null, remove: async () => false },
      knownBot: () => true, actor: () => ({ kind: "loopback" }),
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const ask = async () => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/linked-servers/invites`, { method: "POST" });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await ask()).toEqual({ status: 409, body: { error: "Another Seira cannot reach this one. Give it a secure public address first." } });
    made = { error: "full" };
    expect(await ask()).toEqual({ status: 409, body: { error: "This Seira already has as many links as it can keep. Remove one first." } });
  });
});
