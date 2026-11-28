import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { createCoordinator, type CoordinateBotsCall, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { json, readBody } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBotLinkHost, type BotLinkHostDeps } from "./bot-link-host.ts";
import { taking } from "./linked-a2a.ts";
import { CHAINED, LINKS_MAX, type A2aPeerView, type LinkedServerView } from "./linked-servers.ts";
import { hashSecret } from "./linked-servers-store.ts";

process.env.SEIRA_TEST_LINKED_LOOPBACK = "1";

type Bot = { id: string; name: string };
type Json = Record<string, unknown>;
type Answer = { status: number; body: Json };
const WRITER: Bot = { id: "writer", name: "Writer" }, ANALYST: Bot = { id: "analyst", name: "Analyst" };
const SCOUT: Bot = { id: "scout", name: "Scout" }, CLERK: Bot = { id: "clerk", name: "Clerk" };
const ADMIN = { kind: "cli" } as const;
const NO_AGENT = { error: "There is no such agent here." };
const NOT_VALID = { error: "The token is not valid." };
const FULL = "This Seira already has as many links as it can keep. Remove one first.";
const NO_WAY = "Give the address of the A2A agent, let it call this Seira, or both.";
const NOT_HERE = { error: "That link is not here." };
const TOKEN = /^lsa_[A-Za-z0-9_-]{43}$/u;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const until = async (what: () => boolean, label: string, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Every file under `dir` that is still there when it is read, as text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((name) => {
    const path = join(dir, name);
    try { return statSync(path).isFile() ? [{ path, text: readFileSync(path, "utf8") }] : []; } catch { return []; }
  });
}

/** One server as index.ts wires it, with A2A agents on loopback allowed: the bot link host over a store, a coordinator
 * over its host, and its routes. A source that sends `tries` wrong credentials is throttled. `chars` is the characters of far text a link may have cleaned in a window. */
async function server(label: string, bots: Bot[], { tries = Number.POSITIVE_INFINITY, chars = 0 } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `linked-a2a-${label}-`));
  const records = bots.map((bot) => ({ ...bot, threadId: `${bot.id}-chat`, modelSelection: { instanceId: "", model: "" } }) as unknown as BotRecord);
  const threads = new Set(records.map((bot) => bot.threadId));
  const messages: Array<{ threadId: string; message: Json }> = [];
  const rows: Array<Omit<AdminActionRow, "at">> = [];
  const runs: HandoffView[] = [];
  const logs: string[] = [];
  const failures = new Map<string, number>();
  const knobs: { run(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult> } = { run: async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` }) };
  let opened = 0, port = 0, turns = 0;
  let coordinator: Coordinator | undefined;
  const tick = () => { try { coordinator?.tick(); } catch { /* closed */ } };
  const store = {
    bots: records, bot: (id: string) => records.find((bot) => bot.id === id), standIns: new Map<string, BotRecord>(),
    createTask: (botId: string) => { const threadId = `${botId}-work-${++opened}`; threads.add(threadId); return { threadId }; },
    taskByThread: (_botId: string, threadId: string) => (threads.has(threadId) ? { threadId } : undefined),
    appendMessage: (threadId: string, message: Json) => { messages.push({ threadId, message }); },
    patchTask: () => {}, onChange: () => () => {}, group: () => undefined, groups: [], groupTaskByThread: () => undefined, markGroupThreadUnread: () => {},
    activePath: () => [], messagesFor: () => [], patchGroup: () => {},
  } as unknown as BotLinkHostDeps["store"];

  const build = () => createBotLinkHost({
    dataDir, environmentId: `${label}-environment`, store,
    roomLine: () => "", roomWindow: () => ({ lines: [], order: [], readable: [] }),
    coordinator: () => coordinator!, kick: () => { queueMicrotask(tick); },
    level: () => "full", refusal: () => null, language: () => undefined, personName: () => undefined,
    sessions: { issue: () => { throw new Error("no sessions here"); }, revoke: () => true,
      attemptAllowed: (source) => ({ ok: (failures.get(source) ?? 0) < tries }), noteFailure: (source) => { failures.set(source, (failures.get(source) ?? 0) + 1); } },
    local: () => false, owner: () => false, power: () => null,
    files: { carried: () => [], crossed: () => {}, sentWith: () => ({}), returnedWith: () => ({}), drop: () => {} },
    storeFile: async () => { throw new Error("no files here"); },
    serverName: () => label, publicOrigin: () => `http://127.0.0.1:${port}`, audit: (row) => { rows.push(row); }, actor: () => ({ kind: "loopback" }),
    log: (line) => { logs.push(line); }, a2a: { allowLoopback: true, ...(chars ? { cleanChars: chars } : {}) },
  });
  const inner: CoordinatorHost = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
    names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
    levelOf: () => ({ level: "full" }), chiefOf: () => false,
    run: (node, _resumed, signal) => { runs.push(node); return knobs.run(node, signal); },
  };
  let made = build();
  coordinator = createCoordinator({ dataDir, host: made.link.host(inner), log: () => {} });
  made.start();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ctx = { req, res, url, path: url.pathname, method: req.method ?? "GET" };
    try {
      if (await made.link.publicRoutes(ctx)) return;
      if (await made.routes({ ...ctx, auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody }) !== PASS) return;
      req.resume();
      json(res, 404, { error: "not here" });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (!res.headersSent) json(res, typeof status === "number" ? status : 500, { error: "The request failed." });
    }
  }
  const http = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const ticker = setInterval(tick, 15);
  cleanups.push(async () => {
    clearInterval(ticker);
    made.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    try { coordinator?.close(); } catch { /* closed */ }
    await removeTempDir(dataDir);
  });

  type At = { generation: string; parentId?: string; address: { botId: string; threadId: string } };
  return {
    label, origin, dataDir, messages, rows, runs, logs, knobs,
    get linked() { return made.linked; },
    get made() { return made; },
    get coordinator() { return coordinator; },
    view: (id: string): LinkedServerView | undefined => made.linked.list().find((one) => one.id === id),
    peer: (id: string): A2aPeerView | undefined => made.linked.list().find((one): one is A2aPeerView => one.id === id && one.kind === "a2a"),
    /** The server stops and starts again over the same data. */
    restart() {
      made.close();
      http.closeAllConnections();
      coordinator?.close();
      made = build();
      coordinator = createCoordinator({ dataDir, host: made.link.host(inner), log: () => {} });
      made.start();
    },
    async api(method: string, path: string, body?: unknown): Promise<Answer> {
      const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Json };
    },
    /** A request as an A2A agent makes it, with `token` as its bearer: a card read, or a JSON-RPC call with a body. */
    async call(path: string, token: string | null, body?: unknown): Promise<Answer> {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
    },
    begin(bot: Bot, text: string): At {
      const id = `${label}-turn-${++turns}`, address = { botId: bot.id, threadId: `${bot.id}-chat` };
      coordinator!.beginTurn({ id, address, brief: text, level: "full", origin: { kind: "user", request: text } });
      return { generation: id, address };
    },
    within: (node: HandoffView): At => ({ generation: node.rootId, parentId: node.id, address: { botId: node.botId, threadId: node.threadId } }),
    /** coordinate_bots as index.ts calls it; this server's own bots get the work in their own conversation. */
    coordinate(sender: Bot, at: At, botIds: string[], message: string): Promise<Answer> {
      const local = async (call: CoordinateBotsCall): Promise<Answer> => {
        const receipts = call.botIds.map((botId) => {
          try {
            const { node } = coordinator!.enqueue(at.address, at.generation, at.parentId, { botId, threadId: `${botId}-chat` }, call.message, { thread: "standing" });
            return { botId, outcome: "queued", detail: "queued", requestId: node.id };
          } catch (error) { return { botId, outcome: "failed", detail: (error as Error).message }; }
        });
        const sent = receipts.some((one) => one.outcome === "queued");
        return { status: sent ? 200 : 409, body: { receipts, ...(sent ? { message: "Handed on." } : { error: receipts.map((one) => one.detail).join("; ") }) } };
      };
      return made.link.coordinate({ botIds, message, rework: false, thread: "new", reply: "resume", consult: false },
        { sender, address: at.address, generation: at.generation, ...(at.parentId ? { parentId: at.parentId } : {}), external: false, handed: () => {} }, local);
    },
  };
}
type Server = Awaited<ReturnType<typeof server>>;

const cardPath = (bot: string) => `/api/a2a/${bot}/.well-known/agent-card.json`;
/** A SendMessage that the far side holds until the work ends. */
const sendMessage = (messageId: string, text: string) => ({
  jsonrpc: "2.0", id: `send-${messageId}`, method: "SendMessage", params: { message: { messageId, role: "ROLE_USER", parts: [{ text }] } } });
const results = (at: Server) => at.messages.filter(({ message }) => (message.roomRequest as { phase?: string } | undefined)?.phase === "result");
const refusal = (botId: string): Answer => ({ status: 409, body: { receipts: [{ botId, outcome: "failed", detail: CHAINED }], error: CHAINED } });
const lastRow = (at: Server, action: string) => at.rows.filter((row) => row.action === action).at(-1);
/** The id of the link to another Seira here. */
const toSeira = (at: Server) => at.linked.list().find((one) => one.kind === "seira")!.id;

/** `callee` lets an A2A agent call `bots`; `caller` adds that agent with the first bot's card address and the token. */
async function pair(caller: Server, callee: Server, bots: string[]) {
  const made = await callee.api("POST", "/api/linked-servers/a2a", { name: "Caller agent", inbound: true, exposed: bots });
  expect(made.status).toBe(200);
  const token = String(made.body.token), urls = made.body.urls as Array<{ bot: string; url: string }>;
  const added = await caller.api("POST", "/api/linked-servers/a2a", { name: "Writer agent", url: urls[0]!.url, token, inbound: false });
  expect(added.status).toBe(200);
  const callerId = String((added.body.server as Json).id), calleeId = String((made.body.server as Json).id);
  await until(() => caller.peer(callerId)?.state === "online" && caller.peer(callerId)?.bots.length === 1, "the caller sees the agent");
  return { token, callerId, calleeId, agent: caller.peer(callerId)!.bots[0]!.id };
}

/** The inviter makes an invite and the joiner uses it; both then wait to see the other online. */
async function link(inviter: Server, joiner: Server) {
  const invite = inviter.linked.invite(ADMIN);
  if ("error" in invite) throw new Error(invite.error);
  const joined = await joiner.linked.join(invite.invite, ADMIN);
  const there = () => inviter.linked.list().find((one) => one.name === joiner.label);
  await until(() => there()?.state === "online" && joiner.view(joined.id)?.state === "online", `${inviter.label} and ${joiner.label} are online`);
  return { inviterLink: there()!.id, joinerLink: joined.id };
}

/** `from` shows `bots` to `to` over the link they share; their addresses at `to`. */
async function offer(from: Server, fromLink: string, to: Server, toLink: string, bots: string[]) {
  from.linked.update(fromLink, { exposed: bots }, ADMIN);
  const seen = () => to.view(toLink)?.bots ?? [];
  await until(() => seen().length === bots.length, `${to.label} sees the exposed bots`);
  return seen().map((one) => one.id);
}

/** Holds the turns of these bots until the test ends. */
function hold(at: Server, botIds: string[]): void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  at.knobs.run = async (node) => { if (botIds.includes(node.botId)) await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; };
  cleanups.push(() => release());
}

/** The A2A agent asks the head's writer at its JSON-RPC address, and the call is held while the writer works. */
async function writerAtWork(head: Server, token: string) {
  hold(head, ["writer"]);
  const held = head.call("/api/a2a/writer", token, sendMessage("m-1", "Draft the launch post"));
  await until(() => head.runs.some((node) => node.botId === "writer"), "the writer works");
  return { held, work: head.runs.find((node) => node.botId === "writer")! };
}

describe("adding an A2A agent (AC-01, AC-05)", () => {
  it("makes an inbound token once, keeps only its hash, and gives one card address for each exposed bot", async () => {
    const head = await server("head", [WRITER, ANALYST]);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "  Partner\u0007 agent ", inbound: true, exposed: ["writer", "analyst", "writer"] });
    expect(made.status).toBe(200);
    const token = String(made.body.token), id = String((made.body.server as Json).id);
    expect(token).toMatch(TOKEN);
    expect(made.body.urls).toEqual(["writer", "analyst"].map((bot) => ({ bot, url: `${head.origin}${cardPath(bot)}` })));
    expect(made.body.server).toMatchObject({ kind: "a2a", name: "Partner agent", exposed: ["writer", "analyst"], cap: "ask", outbound: null, inbound: { urls: made.body.urls }, problem: null });

    const record = join(head.dataDir, "linked-servers", "a2a-peers.json");
    const stored = filesUnder(head.dataDir);
    expect(stored.filter(({ text }) => text.includes(token))).toEqual([]);
    expect(stored.filter(({ text }) => text.includes(hashSecret(token))).map(({ path }) => path)).toEqual([record]);
    expect(statSync(record).mode & 0o777).toBe(0o600);

    const listed = await head.api("GET", "/api/linked-servers");
    expect(listed.body.servers).toEqual([expect.objectContaining({ id, kind: "a2a", name: "Partner agent" })]);
    for (const text of [JSON.stringify(listed.body), JSON.stringify(head.rows), JSON.stringify(head.logs)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashSecret(token));
    }
    expect(head.rows).toEqual([{ category: "linked-server", action: "linked-server.a2a-add", target: { kind: "a2a-peer", id, name: "Partner agent" }, actor: { kind: "loopback" },
      changed: ["name", "inboundToken", "exposed", "cap"], after: { exposed: ["writer", "analyst"], cap: "ask" } }]);
    expect((await head.call(cardPath("writer"), token)).body).toMatchObject({ name: "Writer" });
  }, 30_000);

  it("exposes no bot and asks before each turn unless an admin says otherwise, and refuses what it cannot use", async () => {
    const head = await server("head", [WRITER]);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Partner agent", inbound: true });
    expect(made.body.server).toMatchObject({ exposed: [], cap: "ask" });
    expect(made.body.urls).toEqual([]);
    expect(await head.call(cardPath("writer"), String(made.body.token))).toEqual({ status: 404, body: NO_AGENT });

    const refused = async (body: Json) => (await head.api("POST", "/api/linked-servers/a2a", body)).body.error;
    expect(await refused({ name: " \u0007 ", inbound: true })).toBe("Give the A2A agent a name.");
    expect(await refused({ name: "Agent", inbound: false })).toBe(NO_WAY);
    expect(await refused({ name: "Agent", token: "secret", inbound: true })).toBe("A token is for an A2A agent that this Seira calls. Give its address too.");
    expect(await refused({ name: "Agent", url: `${head.origin}/x`, token: "two words", inbound: false })).toBe("That token cannot be sent. Paste it again, with no spaces.");
    expect(await refused({ name: "Agent", url: "ftp://agent.example/", inbound: false })).toBe("The address of the A2A agent must be a public https address.");
    expect(await refused({ name: "Agent", inbound: true, exposed: ["ghost"] })).toBe("One of those bots is not here.");
    expect(head.linked.list()).toHaveLength(1);
  }, 30_000);
});

describe("a call between two Seiras over A2A (AC-05, AC-29)", () => {
  it("carries a hand-off to the agent and its result back, with no token in a view, a log line or an activity row", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]);
    const { token, calleeId, callerId, agent } = await pair(branch, head, ["writer"]);
    expect(branch.peer(callerId)).toMatchObject({ kind: "a2a", name: "Writer agent", state: "online", outbound: { hasToken: true }, inbound: null, problem: null,
      bots: [{ id: agent, name: "Writer agent" }] });
    expect(branch.made.link.agents().map((one) => one.id)).toEqual([agent]);

    const asked = branch.begin(SCOUT, "Draft the launch post");
    expect((await branch.coordinate(SCOUT, asked, [agent], "Draft the launch post")).status).toBe(200);
    branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
    await until(() => results(branch).length === 1, "the result is back");
    expect(head.runs.map((node) => node.botId)).toEqual(["writer"]);
    expect(head.runs[0]!.text).toContain("Draft the launch post");
    expect(results(branch)[0]).toMatchObject({ threadId: "scout-chat", message: { tool: { ok: true } } });
    expect(JSON.stringify(results(branch)[0])).toContain("writer did:");

    const handoffs = head.rows.filter((row) => row.action === "linked-server.handoff");
    expect(handoffs.map((row) => (row.after as { direction?: string }).direction)).toEqual(["received", "result-sent"]);
    expect(handoffs[0]).toMatchObject({ target: { kind: "a2a-peer", id: calleeId, name: "Caller agent" }, actor: { kind: "linked-server", linkId: calleeId, name: "Caller agent", a2a: true } });
    const sent = branch.rows.filter((row) => row.action === "linked-server.handoff");
    expect(sent.map((row) => (row.after as { direction?: string }).direction)).toEqual(["sent", "result-received"]);

    const tokenFile = join(branch.dataDir, "linked-servers", callerId, "bot-link.json");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(filesUnder(branch.dataDir).filter(({ text }) => text.includes(token)).map(({ path }) => path)).toEqual([tokenFile]);
    for (const side of [head, branch]) {
      for (const text of [JSON.stringify(side.linked.list()), JSON.stringify(side.rows), JSON.stringify(side.logs)]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(hashSecret(token));
      }
      expect(JSON.stringify(side.rows)).not.toContain(head.origin);
      expect(JSON.stringify(side.logs)).not.toContain(head.origin);
    }
  }, 60_000);

  it("keeps work an A2A agent started from going to another link, and work another link started from going to an A2A agent", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]), other = await server("other", [CLERK]);
    const { agent } = await pair(branch, head, ["writer"]);
    const toHead = await link(other, head);
    const [clerk] = await offer(other, toHead.inviterLink, head, toHead.joinerLink, ["clerk"]);
    const toBranch = await link(other, branch);
    const [scout] = await offer(branch, toBranch.joinerLink, other, toBranch.inviterLink, ["scout"]);
    hold(head, ["writer"]);
    hold(branch, ["scout"]);

    const asked = branch.begin(SCOUT, "Draft the launch post");
    expect((await branch.coordinate(SCOUT, asked, [agent], "Draft the launch post")).status).toBe(200);
    branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
    await until(() => head.runs.some((node) => node.botId === "writer"), "the writer works for the A2A agent");
    const forAgent = head.within(head.runs.find((node) => node.botId === "writer")!);
    expect(await head.coordinate(WRITER, forAgent, [clerk!], "Ask the other Seira")).toEqual(refusal(clerk!));
    expect(() => head.coordinator!.enqueue(forAgent.address, forAgent.generation, forAgent.parentId, { botId: clerk!, threadId: `${clerk!}:direct` }, "Straight on")).toThrow(CHAINED);

    const fromOther = other.begin(CLERK, "Scout the market");
    expect((await other.coordinate(CLERK, fromOther, [scout!], "Scout the market")).status).toBe(200);
    other.coordinator!.endTurn(fromOther.generation, { ok: true, text: "Handed on." });
    await until(() => branch.runs.some((node) => node.botId === "scout"), "the scout works for the other Seira");
    const forOther = branch.within(branch.runs.find((node) => node.botId === "scout")!);
    expect(await branch.coordinate(SCOUT, forOther, [agent], "Ask the A2A agent")).toEqual(refusal(agent));
    expect(() => branch.coordinator!.enqueue(forOther.address, forOther.generation, forOther.parentId, { botId: agent, threadId: `${agent}:direct` }, "Straight on")).toThrow(CHAINED);
    expect(other.runs).toEqual([]);
    expect(head.runs.map((node) => node.botId)).toEqual(["writer"]);
  }, 60_000);
});

describe("signing in as an A2A agent (AC-08, AC-11, AC-12)", () => {
  it("answers 404 at the root card, the same 404 for a missing and a hidden bot, and 401 to a link's own token", async () => {
    const head = await server("head", [WRITER, ANALYST]), other = await server("other", [CLERK]);
    const { joinerLink } = await link(head, other);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Partner agent", inbound: true, exposed: ["writer"] });
    const token = String(made.body.token);

    for (const bearer of [null, token]) expect(await head.call("/.well-known/agent-card.json", bearer)).toEqual({ status: 404, body: NO_AGENT });
    expect(await head.call(cardPath("ghost"), token)).toEqual({ status: 404, body: NO_AGENT });
    expect(await head.call(cardPath("analyst"), token)).toEqual({ status: 404, body: NO_AGENT });
    expect((await head.call(cardPath("writer"), token)).status).toBe(200);

    const seiraToken = other.linked.instances().find((one) => one.id === joinerLink)!.link.dial()!.token;
    expect(seiraToken.startsWith("lsk_")).toBe(true);
    expect(await head.call(cardPath("writer"), seiraToken)).toEqual({ status: 401, body: NOT_VALID });
    expect(await head.call("/api/a2a/writer", seiraToken, sendMessage("m-1", "Draft"))).toEqual({ status: 401, body: NOT_VALID });
    expect(head.runs).toEqual([]);
  }, 30_000);

  it("throttles a source that keeps sending wrong tokens, and still serves a right one", async () => {
    const tries = 4;
    const head = await server("head", [WRITER], { tries });
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Partner agent", inbound: true, exposed: ["writer"] });
    const token = String(made.body.token);
    for (let index = 0; index < tries; index++) {
      const wrong = await fetch(`${head.origin}${cardPath("writer")}`, { headers: { authorization: `Bearer lsa_${String(index).repeat(43)}` } });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await head.call(cardPath("writer"), `lsa_${"x".repeat(43)}`)).status).toBe(429);
    expect((await head.call(cardPath("writer"), null)).status).toBe(429);
    expect((await head.call(cardPath("writer"), token)).status).toBe(200);
  }, 30_000);
});

describe("a new token, and removal (AC-04, AC-40)", () => {
  it("refuses the old token at once when an admin makes a new one, and ends a held call, while the work goes on", async () => {
    const head = await server("head", [WRITER]);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Partner agent", inbound: true, exposed: ["writer"] });
    const old = String(made.body.token), id = String((made.body.server as Json).id);
    const startedAt = Date.now();
    const { held } = await writerAtWork(head, old);

    const rotated = await head.api("POST", `/api/linked-servers/${id}/token`);
    expect(rotated.status).toBe(200);
    const fresh = String(rotated.body.token);
    expect(fresh).toMatch(TOKEN);
    expect(fresh).not.toBe(old);
    expect(rotated.body.urls).toEqual([{ bot: "writer", url: `${head.origin}${cardPath("writer")}` }]);
    expect(await held).toEqual({ status: 401, body: NOT_VALID });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(await head.call(cardPath("writer"), old)).toEqual({ status: 401, body: NOT_VALID });
    expect((await head.call(cardPath("writer"), fresh)).status).toBe(200);
    expect(head.coordinator!.active().some((node) => node.botId === "writer")).toBe(true);
    expect(lastRow(head, "linked-server.token-rotate")).toMatchObject({ target: { kind: "a2a-peer", id }, changed: ["inboundToken"] });
    expect(JSON.stringify(head.rows)).not.toContain(fresh);
    expect(await head.api("POST", "/api/linked-servers/ffffffffffffffff/token")).toEqual({ status: 404, body: NOT_HERE });
  }, 30_000);

  it("removes the agent's record, folder and token at once, ends a held call and stops its work", async () => {
    const head = await server("head", [WRITER]);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Partner agent", inbound: true, exposed: ["writer"] });
    const token = String(made.body.token), id = String((made.body.server as Json).id);
    const folder = join(head.dataDir, "linked-servers", id);
    const { held, work } = await writerAtWork(head, token);
    expect(existsSync(folder)).toBe(true);

    expect(await head.api("DELETE", `/api/linked-servers/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect(await held).toEqual({ status: 401, body: NOT_VALID });
    expect(await head.call(cardPath("writer"), token)).toEqual({ status: 401, body: NOT_VALID });
    expect(existsSync(folder)).toBe(false);
    expect(head.linked.list()).toEqual([]);
    expect(readFileSync(join(head.dataDir, "linked-servers", "a2a-peers.json"), "utf8")).not.toContain(id);
    await until(() => head.coordinator!.node(work.id)?.status === "cancelled", "the work stops");
    expect(lastRow(head, "linked-server.remove")).toMatchObject({ target: { kind: "a2a-peer", id } });
    expect(await head.api("DELETE", `/api/linked-servers/${id}`)).toEqual({ status: 404, body: NOT_HERE });
  }, 30_000);
});

describe("changing an A2A agent (AC-02)", () => {
  it("changes its name, bots, cap and tokens, turns its calls off and on, and leaves the links to other Seiras as they are", async () => {
    const head = await server("head", [WRITER, ANALYST]), branch = await server("branch", [SCOUT]), other = await server("other", [CLERK]);
    await link(head, other);
    const links = join(head.dataDir, "linked-servers", "links.json");
    const before = readFileSync(links);

    const { token, calleeId, callerId } = await pair(branch, head, ["writer"]);
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { name: "Head writer" })).body.server).toMatchObject({ name: "Head writer" });
    await until(() => branch.peer(callerId)?.bots[0]?.name === "Head writer", "the caller sees the new name");

    const changed = await head.api("PATCH", `/api/linked-servers/${calleeId}`, { exposed: ["analyst"], cap: "edits" });
    expect(changed.body.server).toMatchObject({ exposed: ["analyst"], cap: "edits", inbound: { urls: [{ bot: "analyst", url: `${head.origin}${cardPath("analyst")}` }] } });
    expect(lastRow(head, "linked-server.update")).toMatchObject({ changed: ["exposed", "cap"], before: { exposed: ["writer"], cap: "ask" }, after: { exposed: ["analyst"], cap: "edits" } });
    expect((await head.call(cardPath("writer"), token)).status).toBe(404);
    expect((await head.call(cardPath("analyst"), token)).status).toBe(200);
    expect((await head.api("PATCH", `/api/linked-servers/${calleeId}`, { exposed: ["writer"] })).body.server).toMatchObject({ exposed: ["writer"], cap: "edits" });

    expect(await head.api("PATCH", `/api/linked-servers/${calleeId}`, { inbound: false })).toEqual({ status: 400, body: { error: NO_WAY } });
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { inbound: false })).status).toBe(200);
    expect(await branch.api("PATCH", `/api/linked-servers/${callerId}`, { url: null })).toEqual({ status: 400, body: { error: NO_WAY } });

    const callsOn = await branch.api("POST", `/api/linked-servers/${callerId}/token`);
    expect(callsOn.status).toBe(200);
    expect(branch.peer(callerId)).toMatchObject({ inbound: { urls: [] }, outbound: { hasToken: true } });
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { inbound: false })).body.server).toMatchObject({ inbound: null });
    expect(await branch.call(cardPath("scout"), String(callsOn.body.token))).toEqual({ status: 401, body: NOT_VALID });

    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { token: null })).body.server).toMatchObject({ outbound: { hasToken: false } });
    await until(() => branch.peer(callerId)?.state === "offline", "the caller cannot read the card without the token");
    expect(branch.peer(callerId)?.problem).toBe("The A2A agent did not take the token. Check the token.");
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { token })).body.server).toMatchObject({ outbound: { hasToken: true } });
    await until(() => branch.peer(callerId)?.state === "online", "the caller reads the card again");

    expect(await head.api("PATCH", `/api/linked-servers/${toSeira(head)}`, { name: "x" }))
      .toEqual({ status: 400, body: { error: "Only an A2A agent has an address, a token or a name to change here." } });
    expect(await head.api("DELETE", `/api/linked-servers/${calleeId}`)).toEqual({ status: 200, body: { ok: true } });
    expect(readFileSync(links).equals(before)).toBe(true);
    for (const text of [JSON.stringify(head.rows), JSON.stringify(branch.rows)]) expect(text).not.toContain(token);
  }, 60_000);
});

/** A far address that records the credential of each request it gets. */
async function spy() {
  const seen: Array<string | undefined> = [];
  const http = createServer((req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(404).end(); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  return { seen, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/card.json` };
}

describe("the token goes only to the address it was confirmed for", () => {
  it("sends the old token to no other address, and sends a new token only to the new address", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]);
    const { token, callerId } = await pair(branch, head, ["writer"]);
    const far = await spy();

    const moved = await branch.api("PATCH", `/api/linked-servers/${callerId}`, { url: far.url });
    expect(moved.body.server).toMatchObject({ outbound: { url: far.url, hasToken: false } });
    expect(lastRow(branch, "linked-server.update")).toMatchObject({ changed: expect.arrayContaining(["url", "outboundToken"]) });
    await until(() => far.seen.length > 0, "the new address is called");
    expect(far.seen).toEqual([undefined]);

    const given = await branch.api("PATCH", `/api/linked-servers/${callerId}`, { token: "new-token" });
    expect(given.body.server).toMatchObject({ outbound: { hasToken: true } });
    await until(() => far.seen.at(-1) === "Bearer new-token", "the new token reaches the new address");
    expect(far.seen).not.toContain(`Bearer ${token}`);
  }, 60_000);

  it("sends the token to the new address when it comes in the same change", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]);
    const { token, callerId } = await pair(branch, head, ["writer"]);
    const far = await spy();
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { url: far.url, token: "other-token" })).body.server).toMatchObject({ outbound: { hasToken: true } });
    await until(() => far.seen.length > 0, "the new address is called");
    expect(far.seen).toEqual(["Bearer other-token"]);
    expect(far.seen).not.toContain(`Bearer ${token}`);
  }, 60_000);

  it("keeps the token when only the name changes, and drops it when a record names another address at a restart", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]);
    const { callerId } = await pair(branch, head, ["writer"]);
    expect((await branch.api("PATCH", `/api/linked-servers/${callerId}`, { name: "Renamed" })).body.server).toMatchObject({ outbound: { hasToken: true } });

    const far = await spy();
    const path = join(branch.dataDir, "linked-servers", "a2a-peers.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { peers: Array<Json> };
    record.peers[0]!.url = far.url;
    delete record.peers[0]!.endpoint;
    writeFileSync(path, JSON.stringify(record));
    branch.restart();
    expect(branch.peer(callerId)).toMatchObject({ outbound: { url: far.url, hasToken: false } });
    await until(() => far.seen.length > 0, "the address of the record is called");
    expect(far.seen).toEqual([undefined]);
  }, 60_000);
});

describe("a restart (AC-01)", () => {
  it("turns every A2A agent on again on both sides, with the same tokens", async () => {
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT]);
    const { token, callerId, calleeId, agent } = await pair(branch, head, ["writer"]);

    head.restart();
    branch.restart();
    expect(head.peer(calleeId)).toMatchObject({ name: "Caller agent", exposed: ["writer"], inbound: { urls: [{ bot: "writer" }] } });
    expect((await head.call(cardPath("writer"), token)).status).toBe(200);
    await until(() => branch.peer(callerId)?.state === "online" && branch.peer(callerId)?.bots[0]?.id === agent, "the caller sees the agent again");

    const asked = branch.begin(SCOUT, "Draft the launch post");
    expect((await branch.coordinate(SCOUT, asked, [agent], "Draft the launch post")).status).toBe(200);
    branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
    await until(() => results(branch).length === 1, "the result is back after the restart");
    expect(JSON.stringify(results(branch)[0])).toContain("writer did:");
  }, 60_000);
});

describe("the shared limit (AC-03)", () => {
  it("refuses a 21st link of either kind, and takes one again after a removal", async () => {
    const head = await server("head", [WRITER]), other = await server("other", [CLERK]);
    for (let index = 0; index < LINKS_MAX; index++) {
      expect((await head.api("POST", "/api/linked-servers/a2a", { name: `Agent ${index}`, inbound: true })).status).toBe(200);
    }
    expect(await head.api("POST", "/api/linked-servers/a2a", { name: "One more", inbound: true })).toEqual({ status: 409, body: { error: FULL } });
    expect(await head.api("POST", "/api/linked-servers/invites")).toEqual({ status: 409, body: { error: FULL } });
    const invite = other.linked.invite(ADMIN);
    if ("error" in invite) throw new Error(invite.error);
    expect(await head.api("POST", "/api/linked-servers/join", { invite: invite.invite })).toEqual({ status: 409, body: { error: FULL } });
    expect(other.linked.list()).toEqual([]);
    expect(head.linked.list()).toHaveLength(LINKS_MAX);

    expect(await head.api("DELETE", `/api/linked-servers/${head.linked.list()[0]!.id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await head.api("POST", "/api/linked-servers/invites")).status).toBe(200);
  }, 60_000);
});

/** `Date.now` and every clock made from it after this call run `skew` milliseconds ahead. Call it before a server starts. */
function skewing() {
  const real = Date.now.bind(Date);
  const clock = { skew: 0, forward(ms: number) { clock.skew += ms; } };
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + clock.skew);
  cleanups.push(() => { spy.mockRestore(); });
  return clock;
}
const sendNow = (messageId: string, text: string) => ({
  jsonrpc: "2.0", id: `send-${messageId}`, method: "SendMessage",
  params: { message: { messageId, role: "ROLE_USER", parts: [{ text }] }, configuration: { returnImmediately: true } } });
const BUSY = "The other side is busy now, so try again later.";
const received = (at: Server) => at.rows.filter((row) => row.action === "linked-server.handoff" && (row.after as { direction?: string }).direction === "received");

describe("the characters of far text that a link may have cleaned", () => {
  it("refuses a call with no room before it reads the text and starts no work, then takes calls again in a later window", async () => {
    const clock = skewing();
    const head = await server("head", [WRITER], { chars: 100 });
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Caller agent", inbound: true, exposed: ["writer"] });
    const token = String(made.body.token);

    const first = await head.call("/api/a2a/writer", token, sendNow("m-1", "a".repeat(60)));
    expect(first.status).toBe(200);
    await until(() => received(head).length === 1 && head.runs.length === 1, "the first call starts work");
    const refused = await head.call("/api/a2a/writer", token, sendNow("m-2", "b".repeat(60)));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { message: BUSY } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([head.runs.length, received(head).length]).toEqual([1, 1]);
    expect(JSON.stringify(head.rows)).not.toContain("m-2");
    const task = (id: string) => head.call("/api/a2a/writer", token, { jsonrpc: "2.0", id: "g", method: "GetTask", params: { id } });
    const ids = (await head.call("/api/a2a/writer", token, sendNow("m-1", "a".repeat(60)))).body.result as { task: { id: string } };
    expect((await task(ids.task.id)).body.result).toBeDefined();

    clock.forward(61_000);
    const later = await head.call("/api/a2a/writer", token, sendNow("m-2", "b".repeat(60)));
    expect(later.status).toBe(200);
    await until(() => head.runs.length === 2, "the call of the later window starts work");
  }, 60_000);

  it("takes the calls of an honest agent with the default limit", async () => {
    const head = await server("head", [WRITER]);
    const made = await head.api("POST", "/api/linked-servers/a2a", { name: "Caller agent", inbound: true, exposed: ["writer"] });
    const token = String(made.body.token);
    for (let index = 0; index < 12; index += 1) {
      expect((await head.call("/api/a2a/writer", token, sendNow(`m-${index}`, `Write post ${index}. ${"Words. ".repeat(140)}`))).status).toBe(200);
      await until(() => head.runs.length === index + 1, `call ${index} starts work`);
    }
  }, 60_000);

  it("reads the result of a far agent again in a later window while this link has no room for it", async () => {
    const clock = skewing();
    const head = await server("head", [WRITER]), branch = await server("branch", [SCOUT], { chars: 300 });
    const { agent } = await pair(branch, head, ["writer"]);
    head.knobs.run = async () => ({ ok: true, text: "r".repeat(250) });
    for (const text of ["Draft one", "Draft two"]) {
      const asked = branch.begin(SCOUT, text);
      expect((await branch.coordinate(SCOUT, asked, [agent], text)).status).toBe(200);
      branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
    }
    await until(() => results(branch).length === 1, "the first result is back", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(results(branch)).toHaveLength(1);
    clock.forward(61_000);
    await until(() => results(branch).length === 2, "the second result is back in the later window", 40_000);
    for (const one of results(branch)) expect(JSON.stringify(one)).toContain("r".repeat(250));
  }, 90_000);

  it("never cleans a frame that does not parse, so a field of 4,000,000 characters costs no time", () => {
    const seen: unknown[] = [];
    const link = { receive: (_peer: string, frames: readonly unknown[]) => { seen.push(...frames); }, has: () => true, ownsRoot: () => false };
    const bad = { t: "result", id: "x1", ok: true, text: "⦋".repeat(4_000_000) };
    const good = { t: "result", id: "x2", ok: true, text: "fine" };
    const started = process.hrtime.bigint();
    taking(link).receive("peer", [bad, good]);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
    expect(seen).toEqual([null, good]);
  }, 15_000);
});
