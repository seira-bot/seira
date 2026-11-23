import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBotLink, type LinkEvent } from "../bot-link/link.ts";
import { linkRoot, linkedId, peerKey, type HandoffFrame } from "../bot-link/protocol.ts";
import { createCoordinator, type BeginTurnRequest, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { newA2aToken, peerByToken, type A2aPeersFile } from "../host/a2a-peers-store.ts";
import { BUSY_TEXT, createFrameBudget } from "../host/linked-servers-admit.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CALLER_ID, ROOT_CARD_PATH, createA2aInbound, serveA2a, type A2aGate, type A2aInbound } from "./inbound.ts";
import { CONTEXTS_MAX, INBOUND_BODY_MAX, TEXT_MAX } from "./protocol.ts";
import { createTaskIndex, frameId, threadKey, type TaskIndex } from "./tasks.ts";
import { createA2aTransport } from "./transport.ts";

const FAIL = "The work failed on the other side.";
const WORDS = { handedTo: "Handed to the A2A agent.", otherSide: "the A2A agent" };
const HERE = { id: "here-environment", name: "Here" };
const NO_AGENT = { error: "There is no such agent here." };
const NOT_VALID = { error: "The token is not valid." };
const UNSEEN_TEXT = "a‮b​c\u{e0041}dㅤe\u0007f \u{1f469}‍\u{1f4bb}\nline two\tend";
const SEEN_TEXT = "a bcde f \u{1f469}\u{1f4bb}\nline two\tend";

type Bot = { id: string; name: string; title?: string; description?: string; hidden?: boolean; movedTo?: string };
type Run = (node: HandoffView, signal: AbortSignal) => Promise<HostTurnResult>;
type Json = Record<string, any>;

const BOTS: Bot[] = [
  { id: "writer", name: "Writer", title: "Copywriter", description: "Writes the copy" },
  { id: "analyst", name: "Analyst" },
  { id: "secret", name: "Secret", hidden: true },
  { id: "mover", name: "Mover", movedTo: "elsewhere" },
];

const until = async (what: () => boolean | Promise<boolean>, label: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!await what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const hexId = (n: number) => n.toString(16).padStart(16, "0");

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0).reverse()) await close(); });

interface PeerSpec { label: string; name?: string; exposed?: string[]; holdMs?: number; limits?: { requests?: number; holds?: number }; frames?: number; chars?: number }

async function world(specs: PeerSpec[]) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-inbound-"));
  const threads = new Set<string>(), titles: string[] = [], begun: BeginTurnRequest[] = [], failedTries: string[] = [];
  const runs: Array<{ botId: string; text: string; origin: unknown }> = [];
  const knobs: { run: Run; limit: string | null; tries: number } = { run: async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` }), limit: null, tries: 1_000 };
  let real!: Coordinator;
  const watched = new Proxy({} as Coordinator, {
    get(_target, prop) {
      if (prop === "beginTurn") return (input: BeginTurnRequest) => { begun.push(input); return real.beginTurn(input); };
      const value: unknown = Reflect.get(real, prop);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  const links = specs.map((spec) => {
    const key = peerKey(`a2a:${spec.label}`), dataDir = join(dir, spec.label), events: LinkEvent[] = [];
    const exposed = new Set(spec.exposed ?? ["writer", "secret", "mover"]);
    mkdirSync(dataDir, { recursive: true });
    const link = createBotLink({
      dataDir, coordinator: () => watched, bots: () => BOTS, bot: (id) => BOTS.find((bot) => bot.id === id), level: () => "full",
      openThread: (bot, title) => { titles.push(title); const id = `${bot.id}-work-${threads.size + 1}`; threads.add(id); return id; },
      hasThread: (_botId, threadId) => threads.has(threadId), personName: () => undefined, sentRow: () => {}, resultRow: () => {},
      kick: () => { queueMicrotask(() => { try { real.tick(); } catch { /* closed */ } }); },
      policy: { key, exposed: (id) => exposed.has(id), admit: () => knobs.limit, failText: () => FAIL, words: WORDS, record: (event) => { events.push(event); } },
    });
    return { spec, key, dataDir, events, exposed, link };
  });
  const inner: CoordinatorHost = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
    names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
    levelOf: () => ({ level: "full" }), chiefOf: () => false,
    run: (node, _resumed, signal) => { runs.push({ botId: node.botId, text: node.text, origin: node.origin }); return knobs.run(node, signal); },
  };
  real = createCoordinator({ dataDir: dir, host: links.reduceRight((host, one) => one.link.host(host), inner), log: () => {} });
  const ticker = setInterval(() => real.tick(), 15);

  const peers = links.map((one) => {
    const name = one.spec.name ?? "Partner agent";
    one.link.turnOn({ self: HERE, origin: `a2a:${one.spec.label}`, token: "a2a", peer: { id: `a2a:${one.spec.label}`, name } });
    const tasks = createTaskIndex(one.dataDir, Date.now);
    const budget = createFrameBudget(Date.now, one.spec.frames ?? 1_000);
    const charMax = one.spec.chars ?? 10_000_000, chars = createFrameBudget(Date.now, charMax);
    const priced = (count: number) => Math.min(count, charMax);
    const inbound = createA2aInbound({
      link: one.link, key: one.key, peerName: () => name, exposed: (id) => one.exposed.has(id), bot: (id) => BOTS.find((bot) => bot.id === id),
      endpoint: (botId) => `https://seira.example/api/a2a/${botId}`, coordinator: () => real, tasks,
      frames: { left: () => budget.left(one.key), spend: (count) => budget.spend(one.key, count) },
      cleaning: { fits: (count) => chars.left(one.key) >= priced(count), spend: (count) => { chars.spend(one.key, priced(count)); } },
      failText: FAIL, holdMs: one.spec.holdMs ?? 2_000, limits: { requests: 100_000, ...one.spec.limits },
    });
    const sent: HandoffFrame[] = [], cancelled: string[] = [];
    const transport = createA2aTransport({ link: one.link, key: one.key, inbound, outbound: { send: (frame) => { sent.push(frame); }, cancel: (id) => { cancelled.push(id); }, close: () => {} } });
    transport.start();
    const { token, hash } = newA2aToken();
    return { ...one, name, tasks, inbound, transport, token, hash, sent, cancelled };
  });

  const file: A2aPeersFile = { v: 1, peers: peers.map((one, n) => ({ id: hexId(n + 1), name: one.name, tokenHash: one.hash, exposed: [...one.exposed], cap: "ask", createdAt: 1 })) };
  const gate: A2aGate = {
    peerFor: (token) => { const found = peerByToken(file, token); return found ? peers[Number.parseInt(found.id, 16) - 1]?.inbound : undefined; },
    attemptAllowed: (source) => failedTries.filter((one) => one === source).length < knobs.tries,
    attemptFailed: (source) => { failedTries.push(source); },
  };
  const server = await listen(gate);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  open.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    clearInterval(ticker);
    for (const one of peers) { one.transport.close(); one.link.close(); }
    try { real.close(); } catch { /* closed */ }
    await removeTempDir(dir);
  });
  return { peers, base, begun, runs, titles, knobs, failedTries, coordinator: () => real };
}
type World = Awaited<ReturnType<typeof world>>;
type Peer = World["peers"][number];

async function listen(gate: A2aGate): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    serveA2a({ req, res, path: url.pathname, method: req.method ?? "GET" }, gate).then((handled) => {
      if (!handled) { req.resume(); res.writeHead(418).end(); }
    }, () => { if (!res.headersSent) res.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  return server;
}

async function call(base: string, path: string, init: { method?: string; token?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers };
  const res = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers,
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}), ...(init.signal ? { signal: init.signal } : {}) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as Json };
}
const rpc = (w: World, peer: Peer, body: unknown, botId = "writer", headers: Record<string, string> = {}, signal?: AbortSignal) =>
  call(w.base, `/api/a2a/${botId}`, { token: peer.token, body, headers, ...(signal ? { signal } : {}) });

const sendMessage = (messageId: string, more: { text?: string; parts?: unknown[]; contextId?: string; taskId?: string; blocking?: boolean; configuration?: Json; role?: string } = {}) => ({
  jsonrpc: "2.0", id: `send-${messageId}`, method: "SendMessage",
  params: {
    message: { messageId, role: more.role ?? "ROLE_USER", parts: more.parts ?? [{ text: more.text ?? `Do ${messageId}` }],
      ...(more.contextId !== undefined ? { contextId: more.contextId } : {}), ...(more.taskId !== undefined ? { taskId: more.taskId } : {}) },
    configuration: { returnImmediately: !more.blocking, ...more.configuration },
  },
});
const getTask = (id: string) => ({ jsonrpc: "2.0", id: "get", method: "GetTask", params: { id } });
const cancelTask = (id: string) => ({ jsonrpc: "2.0", id: "cancel", method: "CancelTask", params: { id } });
const stateOf = async (w: World, peer: Peer, id: string) => ((await rpc(w, peer, getTask(id))).body.result?.status?.state as string | undefined);
const workKeys = (peer: Peer): string[] => Object.keys((JSON.parse(readFileSync(join(peer.dataDir, "bot-link.json"), "utf8")) as { work: Json }).work);
const gated = (w: World) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  w.knobs.run = async (node, signal) => {
    await Promise.race([gate, new Promise((resolve) => { signal.addEventListener("abort", resolve, { once: true }); })]);
    return signal.aborted ? { ok: false, text: "stopped" } : { ok: true, text: `${node.botId} did: ${node.text}` };
  };
  return () => release();
};

describe("signing in (AC-07, AC-08, AC-11, AC-12)", () => {
  it("answers 401 with a Bearer challenge to no token, an unknown token or a linked server's token, and starts nothing", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (const authorization of [undefined, `Bearer lsa_${"x".repeat(43)}`, `Bearer lsk_${peer.token.slice(4)}`, `Basic ${peer.token}`, peer.token]) {
      const res = await call(w.base, "/api/a2a/writer", { body: sendMessage("m1"), headers: authorization ? { authorization } : {} });
      expect([res.status, res.headers.get("www-authenticate"), res.body]).toEqual([401, "Bearer", NOT_VALID]);
    }
    expect(w.failedTries).toHaveLength(5);
    expect(w.failedTries.every((source) => source.startsWith("linked-server:"))).toBe(true);
    expect([w.begun, peer.tasks.get(frameId(peer.key, "m1")), workKeys(peer)]).toEqual([[], null, []]);
  });

  it("throttles a source after wrong tokens, and still takes a right token from it", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    w.knobs.tries = 2;
    expect((await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: "lsa_wrong" })).status).toBe(401);
    expect((await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: "lsa_wrong" })).status).toBe(401);
    const throttled = await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: "lsa_wrong" });
    expect([throttled.status, throttled.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(w.failedTries).toHaveLength(2);
    expect((await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token })).status).toBe(200);
  });

  it("answers 404 at the root card path with or without a token, and leaves other paths alone", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (const token of [undefined, peer.token]) {
      const res = await call(w.base, ROOT_CARD_PATH, token ? { token } : {});
      expect([res.status, res.body]).toEqual([404, NO_AGENT]);
    }
    expect((await call(w.base, "/api/other", { token: peer.token })).status).toBe(418);
    expect(w.failedTries).toEqual([]);
  });

  it("answers 401 at once, with no failed try, once the peer's link is off", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    peer.link.turnOff(true);
    const res = await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token });
    expect([res.status, res.body]).toEqual([401, NOT_VALID]);
    expect(w.failedTries).toEqual([]);
  });
});

describe("cards (AC-09, AC-13)", () => {
  it("lists only that bot, text modes only, with no streaming, push or extended card", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const res = await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([res.status, res.body]).toEqual([200, {
      name: "Writer", description: "Writes the copy", version: "1",
      supportedInterfaces: [{ url: "https://seira.example/api/a2a/writer", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: "A token from the owner of this server." } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      skills: [{ id: "writer", name: "Writer", description: "Writes the copy", tags: [] }],
    }]);
  });

  it("answers a missing, unexposed, hidden or moved bot, and an unknown path, with the same 404", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (const botId of ["ghost", "analyst", "secret", "mover"]) {
      const card = await call(w.base, `/api/a2a/${botId}/.well-known/agent-card.json`, { token: peer.token });
      const address = await rpc(w, peer, sendMessage(`m-${botId}`), botId);
      expect([card.status, card.body, address.status, address.body]).toEqual([404, NO_AGENT, 404, NO_AGENT]);
    }
    for (const path of ["/api/a2a/writer/extra", "/api/a2a/", "/api/a2a/bad.id"]) {
      const res = await call(w.base, path, { token: peer.token });
      expect([res.status, res.body]).toEqual([404, NO_AGENT]);
    }
    expect([w.begun, workKeys(peer)]).toEqual([[], []]);
  });

  it("reads the exposed list at every request", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const card = () => call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token });
    peer.exposed.delete("writer");
    expect((await card()).status).toBe(404);
    peer.exposed.add("writer");
    expect((await card()).status).toBe(200);
  });

  it("answers 405 to a card that is not got and to an address that is not posted to, and 415 to a body that is not JSON", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    expect((await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token, body: {} })).status).toBe(405);
    expect((await call(w.base, "/api/a2a/writer", { token: peer.token })).status).toBe(405);
    expect((await rpc(w, peer, sendMessage("m1"), "writer", { "content-type": "text/plain" })).status).toBe(415);
    expect((await rpc(w, peer, sendMessage("m2"), "writer", { "content-type": "application/a2a+json" })).status).toBe(200);
  });
});

describe("SendMessage (AC-14 to AC-20, AC-25 to AC-27)", () => {
  it("starts one hand-off as outside work, with the admin's name for the peer and no person's name (AC-14)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const res = await rpc(w, peer, sendMessage("m1", { text: "Draft the launch post", blocking: true }));
    const id = frameId(peer.key, "m1"), thread = threadKey("writer", "seira-writer");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: "send-m1", result: { task: {
      id, contextId: "seira-writer", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "result", parts: [{ text: "writer did: Draft the launch post" }] }],
    } } });
    expect(w.begun).toHaveLength(1);
    expect(w.begun[0]!.opener).toEqual({
      requester: { kind: "external_runtime", runId: linkRoot(id), botId: linkedId(peer.key, CALLER_ID), threadId: linkRoot(id) },
      origin: { kind: "outside", source: "peer", ref: thread },
    });
    expect(w.runs).toEqual([{ botId: "writer", text: "Draft the launch post", origin: { kind: "outside" } }]);
    expect(w.titles).toEqual(["@Partner agent · work"]);
    const work = (JSON.parse(readFileSync(join(peer.dataDir, "bot-link.json"), "utf8")) as { work: Json }).work[id];
    expect(work).toMatchObject({ from: "Partner agent", to: "writer", by: CALLER_ID });
    expect(work).not.toHaveProperty("person");
  });

  it("hands the bot the text without unseen characters, and refuses a text with nothing to see", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    await rpc(w, peer, sendMessage("m1", { text: UNSEEN_TEXT, blocking: true }));
    expect(w.runs.map((run) => run.text)).toEqual([SEEN_TEXT]);
    const blank = await rpc(w, peer, sendMessage("m2", { text: "​\u{e0041}ㅤ⁦" }));
    expect(blank.body.error.code).toBe(-32602);
    expect(w.begun).toHaveLength(1);
  });

  it("answers the same messageId again with the same task and starts nothing new (AC-15)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    const first = await rpc(w, peer, sendMessage("m1"));
    const again = await rpc(w, peer, sendMessage("m1", { text: "Something else" }));
    expect(again.body.result.task.id).toBe(first.body.result.task.id);
    release();
    await until(async () => await stateOf(w, peer, first.body.result.task.id) === "TASK_STATE_COMPLETED", "m1 is done");
    const late = await rpc(w, peer, sendMessage("m1"));
    expect(late.body.result.task).toMatchObject({ id: first.body.result.task.id, status: { state: "TASK_STATE_COMPLETED" } });
    expect([w.begun.length, w.runs.length]).toEqual([1, 1]);
  });

  it("makes two tasks when two peers send the same messageId, and neither sees the other's (AC-16, AC-23)", async () => {
    const w = await world([{ label: "one" }, { label: "two" }]);
    const [one, two] = w.peers as [Peer, Peer];
    const a = await rpc(w, one, sendMessage("same", { blocking: true }));
    const b = await rpc(w, two, sendMessage("same", { blocking: true }));
    expect(a.body.result.task.id).not.toBe(b.body.result.task.id);
    expect([a.body.result.task.status.state, b.body.result.task.status.state]).toEqual(["TASK_STATE_COMPLETED", "TASK_STATE_COMPLETED"]);
    expect(w.runs).toHaveLength(2);
    const before = [workKeys(one), workKeys(two)];
    for (const body of [getTask(b.body.result.task.id), cancelTask(b.body.result.task.id), getTask("unknown"), cancelTask("unknown")]) {
      expect((await rpc(w, one, body)).body.error.code).toBe(-32001);
    }
    expect([workKeys(one), workKeys(two)]).toEqual(before);
    expect(one.tasks.get(b.body.result.task.id)).toBeNull();
  });

  it("keeps one thread for one context and opens another for another context", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const contexts: string[] = [];
    for (const [messageId, contextId] of [["m1", "c1"], ["m2", "c1"], ["m3", "c2"]] as const) {
      contexts.push((await rpc(w, peer, sendMessage(messageId, { contextId, blocking: true }))).body.result.task.contextId);
    }
    expect(contexts).toEqual(["c1", "c1", "c2"]);
    expect(w.titles).toHaveLength(2);
  });

  it("answers a part that is not text with -32005 and starts nothing (AC-17)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (const parts of [[{ text: "Look" }, { url: "https://files.example/a.png" }], [{ raw: "aGVsbG8=" }], [{ data: { a: 1 } }], [{ text: "x", raw: "eA==" }]]) {
      expect((await rpc(w, peer, sendMessage("m1", { parts }))).body.error.code).toBe(-32005);
    }
    expect([w.begun, peer.tasks.get(frameId(peer.key, "m1")), workKeys(peer)]).toEqual([[], null, []]);
  });

  it("answers a body over 64 KB with 413 and a text over the limit with -32602, and starts nothing (AC-18)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const large = await rpc(w, peer, sendMessage("m1", { text: "x".repeat(INBOUND_BODY_MAX) }));
    expect([large.status, large.body]).toEqual([413, { error: "The request is too large." }]);
    expect(await chunked(w, peer, JSON.stringify(sendMessage("m2", { text: "y".repeat(INBOUND_BODY_MAX) })))).toBe(413);
    const half = "z".repeat(TEXT_MAX / 2 + 1);
    for (const more of [{ text: "x".repeat(TEXT_MAX + 1) }, { parts: [{ text: half }, { text: half }] }, { text: "   " }]) {
      expect((await rpc(w, peer, sendMessage("m3", more))).body.error.code).toBe(-32602);
    }
    expect((await rpc(w, peer, sendMessage("m4", { text: "x".repeat(TEXT_MAX) }))).body.result.task.id).toBe(frameId(peer.key, "m4"));
    expect(w.begun).toHaveLength(1);
    expect(["m1", "m2", "m3"].map((id) => peer.tasks.get(frameId(peer.key, id)))).toEqual([null, null, null]);
  });

  it("refuses a batch, an unknown method, the methods it does not offer and push (AC-19)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const codeOf = async (body: unknown) => (await rpc(w, peer, body)).body.error?.code as number | undefined;
    const method = (name: string) => ({ jsonrpc: "2.0", id: 7, method: name, params: {} });
    expect(await codeOf([sendMessage("m1")])).toBe(-32600);
    expect(await codeOf("{not json")).toBe(-32700);
    expect(await codeOf({ id: 1, method: "SendMessage" })).toBe(-32600);
    expect(await codeOf(method("DoSomething"))).toBe(-32601);
    for (const name of ["GetExtendedAgentCard", "SendStreamingMessage", "SubscribeToTask", "ListTasks"]) expect(await codeOf(method(name))).toBe(-32004);
    for (const name of ["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]) expect(await codeOf(method(name))).toBe(-32003);
    for (const configuration of [{ pushNotificationConfig: { url: "https://hook.example" } }, { taskPushNotificationConfig: { url: "https://hook.example" } }]) {
      expect(await codeOf(sendMessage("m2", { configuration }))).toBe(-32003);
    }
    expect(await codeOf(sendMessage("m3", { role: "ROLE_AGENT" }))).toBe(-32602);
    expect(await codeOf(method("SendMessage"))).toBe(-32602);
    expect(w.begun).toEqual([]);
  });

  it("refuses a version other than 1.x, and takes a request with no version as 1.0 (AC-20)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (const version of ["0.3", "2.0", "1.0, 0.3"]) expect((await rpc(w, peer, sendMessage("m1"), "writer", { "a2a-version": version })).body.error.code).toBe(-32009);
    expect(w.begun).toEqual([]);
    expect((await rpc(w, peer, sendMessage("m2"), "writer", { "a2a-version": "1.0" })).body.result.task).toBeDefined();
    expect((await rpc(w, peer, sendMessage("m3"))).body.result.task).toBeDefined();
  });

  it("answers a taskId of an ended task with -32004 and an unknown one with -32001, and starts nothing (AC-25)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const ended = (await rpc(w, peer, sendMessage("m1", { blocking: true }))).body.result.task.id as string;
    expect((await rpc(w, peer, sendMessage("m2", { taskId: ended }))).body.error.code).toBe(-32004);
    expect((await rpc(w, peer, sendMessage("m3", { taskId: "no-such-task" }))).body.error.code).toBe(-32001);
    expect(w.begun).toHaveLength(1);
  });

  it(`refuses a new context once ${CONTEXTS_MAX} are in use, and still takes a known one and the standing one (AC-26)`, async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    for (let n = 0; n < CONTEXTS_MAX; n += 1) {
      peer.tasks.put({ id: `old-${n}`, dir: "in", bot: "writer", context: `c${n}`, thread: threadKey("writer", `c${n}`), state: "TASK_STATE_COMPLETED", at: Date.now() });
    }
    expect((await rpc(w, peer, sendMessage("m1", { contextId: "new-context" }))).body.error.code).toBe(-32004);
    expect(peer.tasks.get(frameId(peer.key, "m1"))).toBeNull();
    expect((await rpc(w, peer, sendMessage("m2", { contextId: "c7" }))).body.result.task.contextId).toBe("c7");
    expect((await rpc(w, peer, sendMessage("m3"))).body.result.task.contextId).toBe("seira-writer");
    expect(w.begun).toHaveLength(2);
  });

  it("answers REJECTED with the admission text when the limit refuses, and records one refusal (AC-27)", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    w.knobs.limit = BUSY_TEXT;
    const res = await rpc(w, peer, sendMessage("m1", { blocking: true }));
    const id = frameId(peer.key, "m1");
    expect(res.body.result.task).toMatchObject({ id, status: { state: "TASK_STATE_REJECTED", message: { role: "ROLE_AGENT", parts: [{ text: BUSY_TEXT }] } } });
    expect(peer.events.filter((event) => event.kind === "refused")).toEqual([{ kind: "refused", reason: "limit", peer: peer.key, bot: "writer", far: CALLER_ID, id }]);
    expect([w.begun, w.runs]).toEqual([[], []]);
    expect(await stateOf(w, peer, id)).toBe("TASK_STATE_REJECTED");
  });
});

describe("holding a request (AC-21)", () => {
  it("holds a blocking request while the work runs and then answers WORKING, and answers returnImmediately at once", async () => {
    const w = await world([{ label: "one", holdMs: 400 }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    let start = Date.now();
    const held = await rpc(w, peer, sendMessage("m1", { blocking: true }));
    expect(Date.now() - start).toBeGreaterThanOrEqual(350);
    expect(held.body.result.task.status.state).toBe("TASK_STATE_WORKING");
    start = Date.now();
    const quick = await rpc(w, peer, sendMessage("m2"));
    expect(Date.now() - start).toBeLessThan(350);
    expect(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]).toContain(quick.body.result.task.status.state);
    release();
    await until(async () => await stateOf(w, peer, held.body.result.task.id) === "TASK_STATE_COMPLETED", "m1 is done");
  });

  it("answers a blocking request as soon as the work ends", async () => {
    const w = await world([{ label: "one", holdMs: 6_000 }]);
    const [peer] = w.peers as [Peer];
    w.knobs.run = async (node) => { await new Promise((resolve) => setTimeout(resolve, 100)); return { ok: true, text: `${node.botId} did it` }; };
    const start = Date.now();
    const res = await rpc(w, peer, sendMessage("m1", { blocking: true }));
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(res.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("holds at most its limit of requests and answers one more at once, and a caller that hangs up frees its place", async () => {
    const w = await world([{ label: "one", holdMs: 600, limits: { holds: 1 } }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    const first = rpc(w, peer, sendMessage("m1", { blocking: true }));
    await until(() => w.begun.length === 1, "m1 started");
    let start = Date.now();
    await rpc(w, peer, sendMessage("m2", { blocking: true }));
    expect(Date.now() - start).toBeLessThan(450);
    await first;

    const hangUp = new AbortController();
    const gone = rpc(w, peer, sendMessage("m3", { blocking: true }), "writer", {}, hangUp.signal).catch(() => "hung up");
    await until(() => w.begun.length === 3, "m3 started");
    await new Promise((resolve) => setTimeout(resolve, 100));
    hangUp.abort();
    expect(await gone).toBe("hung up");
    await new Promise((resolve) => setTimeout(resolve, 50));
    start = Date.now();
    await rpc(w, peer, sendMessage("m4", { blocking: true }));
    expect(Date.now() - start).toBeGreaterThanOrEqual(500);
    release();
  });

  it("ends a held request with 401 when the peer's side closes, and answers 401 after that", async () => {
    const w = await world([{ label: "one", holdMs: 6_000 }]);
    const [peer] = w.peers as [Peer];
    gated(w);
    const held = rpc(w, peer, sendMessage("m1", { blocking: true }));
    await until(() => w.begun.length === 1, "m1 started");
    const start = Date.now();
    peer.transport.close();
    const res = await held;
    expect(Date.now() - start).toBeLessThan(4_000);
    expect([res.status, res.body]).toEqual([401, NOT_VALID]);
    expect((await rpc(w, peer, getTask(frameId(peer.key, "m1")))).status).toBe(401);
    expect(w.failedTries).toEqual([]);
  });
});

describe("GetTask and CancelTask (AC-22 to AC-24)", () => {
  it("reports the live state, then COMPLETED with one text artifact", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    const id = (await rpc(w, peer, sendMessage("m1"))).body.result.task.id as string;
    await until(async () => await stateOf(w, peer, id) === "TASK_STATE_WORKING", "m1 runs");
    release();
    await until(async () => await stateOf(w, peer, id) === "TASK_STATE_COMPLETED", "m1 is done");
    const task = (await rpc(w, peer, getTask(id))).body.result;
    expect(task).toMatchObject({ id, contextId: "seira-writer", status: { state: "TASK_STATE_COMPLETED" } });
    expect(task.artifacts).toEqual([{ artifactId: "result", parts: [{ text: "writer did: Do m1" }] }]);
    expect(task.status.message).toBeUndefined();
  });

  it("reports a failure as FAILED with the fixed text only", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    w.knobs.run = async () => ({ ok: false, text: "Spend cap reached: $12.40 of $10.00 used this month." });
    const res = await rpc(w, peer, sendMessage("m1", { blocking: true }));
    expect(res.body.result.task).toMatchObject({ status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: FAIL }] } } });
    expect(res.body.result.task.artifacts).toBeUndefined();
    const again = await rpc(w, peer, getTask(res.body.result.task.id));
    expect(JSON.stringify([res.body, again.body])).not.toContain("12.40");
  });

  it("stops open work and reports CANCELED, and refuses to cancel ended work with -32002", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    const id = (await rpc(w, peer, sendMessage("m1"))).body.result.task.id as string;
    await until(() => w.runs.length === 1, "m1 runs");
    const cancelled = await rpc(w, peer, cancelTask(id));
    expect(cancelled.body.result).toMatchObject({ id, status: { state: "TASK_STATE_CANCELED" } });
    expect(await stateOf(w, peer, id)).toBe("TASK_STATE_CANCELED");
    expect((await rpc(w, peer, cancelTask(id))).body.error.code).toBe(-32002);
    release();
    const done = (await rpc(w, peer, sendMessage("m2", { blocking: true }))).body.result.task.id as string;
    expect((await rpc(w, peer, cancelTask(done))).body.error.code).toBe(-32002);
  });
});

describe("budgets of one peer", () => {
  it("answers 429 once the peer spent its requests in the window", async () => {
    const w = await world([{ label: "one", limits: { requests: 3 } }]);
    const [peer] = w.peers as [Peer];
    for (let n = 0; n < 3; n += 1) expect((await rpc(w, peer, getTask("x"))).status).toBe(200);
    const res = await call(w.base, "/api/a2a/writer/.well-known/agent-card.json", { token: peer.token });
    expect([res.status, res.headers.get("retry-after"), res.body]).toEqual([429, "60", { error: "Too many requests. Try again later." }]);
  });

  it("answers 429 with the busy text once the link's frame budget is spent, and starts nothing more", async () => {
    const w = await world([{ label: "one", frames: 2 }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    await rpc(w, peer, sendMessage("m1"));
    const id = frameId(peer.key, "m1");
    await rpc(w, peer, cancelTask(id));
    const res = await rpc(w, peer, sendMessage("m2"));
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(res.body.error).toMatchObject({ code: -32603, message: BUSY_TEXT });
    expect(peer.tasks.get(frameId(peer.key, "m2"))).toBeNull();
    expect(w.begun).toHaveLength(1);
    release();
  });
});

describe("the character budget of a peer", () => {
  it("answers 429 with the busy text when the text has no room, before it reads the text, and starts nothing", async () => {
    const w = await world([{ label: "one", chars: 100 }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    expect((await rpc(w, peer, sendMessage("m1", { text: "a".repeat(60) }))).status).toBe(200);
    const res = await rpc(w, peer, sendMessage("m2", { text: "b".repeat(60) }));
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "60"]);
    expect(res.body.error).toMatchObject({ code: -32603, message: BUSY_TEXT });
    expect(peer.tasks.get(frameId(peer.key, "m2"))).toBeNull();
    expect(w.begun).toHaveLength(1);
    release();
  });

  it("takes no room for a call that repeats a message id", async () => {
    const w = await world([{ label: "one", chars: 100 }]);
    const [peer] = w.peers as [Peer];
    const release = gated(w);
    for (let n = 0; n < 3; n += 1) expect((await rpc(w, peer, sendMessage("m1", { text: "a".repeat(60) }))).status).toBe(200);
    expect(w.begun).toHaveLength(1);
    release();
  });
});

describe("a request that starts nothing (lesson 6)", () => {
  it("leaves no task when the link took no work from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-inbound-stub-"));
    const tasks: TaskIndex = createTaskIndex(dir, Date.now);
    const received: unknown[] = [];
    let inbound!: A2aInbound;
    const server = await listen({ peerFor: (token) => (token === "lsa_stub" ? inbound : undefined), attemptAllowed: () => true, attemptFailed: () => {} });
    open.push(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await removeTempDir(dir); });
    inbound = createA2aInbound({
      link: { receive: (_peer, frames) => { received.push(...frames); }, has: () => true, ownsRoot: () => false },
      key: "abcd1234", peerName: () => "Partner", exposed: () => true, bot: (id) => BOTS.find((bot) => bot.id === id),
      endpoint: (botId) => `https://seira.example/api/a2a/${botId}`, coordinator: () => ({ children: () => [] }), tasks,
      frames: { left: () => 10, spend: () => {} }, cleaning: { fits: () => true, spend: () => {} }, failText: FAIL,
    });
    const res = await call(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "/api/a2a/writer", { token: "lsa_stub", body: sendMessage("m1") });
    expect(res.body.error.code).toBe(-32603);
    expect(received).toHaveLength(1);
    expect(tasks.get(frameId("abcd1234", "m1"))).toBeNull();
    expect(createTaskIndex(dir, Date.now).get(frameId("abcd1234", "m1"))).toBeNull();
  });
});

describe("the transport on a real link", () => {
  it("routes the link's result to the task and acknowledges it, so a new session sends it no more", async () => {
    const w = await world([{ label: "one" }]);
    const [peer] = w.peers as [Peer];
    const id = (await rpc(w, peer, sendMessage("m1", { blocking: true }))).body.result.task.id as string;
    const work = (JSON.parse(readFileSync(join(peer.dataDir, "bot-link.json"), "utf8")) as { work: Json }).work[id];
    expect(work.ackedAt).toEqual(expect.any(Number));
    peer.transport.start();
    expect(peer.link.outgoing(peer.key, 0).map((entry) => entry.frame.t).filter((t) => t !== "hello")).toEqual([]);
    expect([peer.sent, peer.cancelled]).toEqual([[], []]);
  });
});

function chunked(w: World, peer: Peer, body: string): Promise<number> {
  const url = new URL(`${w.base}/api/a2a/writer`);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { authorization: `Bearer ${peer.token}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    for (let at = 0; at < body.length; at += 8_192) req.write(body.slice(at, at + 8_192));
    req.end();
  });
}
