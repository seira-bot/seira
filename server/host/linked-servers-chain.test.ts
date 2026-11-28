import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { linkedId } from "../bot-link/protocol.ts";
import { createCoordinator, type CoordinateBotsCall, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { json, readBody } from "../harness/http.ts";
import { PASS } from "../routes/table.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBotLinkHost, type BotLinkHostDeps } from "./bot-link-host.ts";
import { CHAINED, type ApprovalCap } from "./linked-servers.ts";
import { ADMIT } from "./linked-servers-admit.ts";

type Bot = { id: string; name: string };
type Answer = { status: number; body: Record<string, unknown> };
const WRITER: Bot = { id: "writer", name: "Writer" }, ANALYST: Bot = { id: "analyst", name: "Analyst" }, KEEPER: Bot = { id: "keeper", name: "Keeper" };
const SCOUT: Bot = { id: "scout", name: "Scout" }, CLERK: Bot = { id: "clerk", name: "Clerk" };
/** A bot of the person's own other place, as the head server knows it. */
const OWN_PEER = "abcdef01", HELPER = linkedId(OWN_PEER, "helper");
const ADMIN = { kind: "cli" } as const;

const cleanups: Array<() => Promise<void> | void> = [];
// Two servers on this machine dial each other on loopback. Only a test may allow that.
process.env.SEIRA_TEST_LINKED_LOOPBACK = "1";
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const until = async (what: () => boolean, label: string, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** One server as index.ts wires it: the bot link host over a store, a coordinator over its host, and its routes. */
async function server(label: string, bots: Bot[], { ownLink = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `linked-chain-${label}-`));
  if (ownLink) {
    writeFileSync(join(dataDir, "bot-link.json"), JSON.stringify({ v: 2, role: "acceptor", self: { id: `${label}-environment`, name: label },
      peers: { [OWN_PEER]: { place: { id: "own-computer", name: "Own computer" }, bots: [{ id: "helper", name: "Helper" }], seenAt: Date.now() } }, threads: {}, work: {} }), { mode: 0o600 });
  }
  const records = bots.map((bot) => ({ ...bot, threadId: `${bot.id}-chat`, modelSelection: { instanceId: "", model: "" } }) as unknown as BotRecord);
  const threads = new Set(records.map((bot) => bot.threadId));
  const messages: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  const rows: Array<Omit<AdminActionRow, "at">> = [];
  const runs: HandoffView[] = [];
  const logs: string[] = [];
  /** `stuck`: the coordinator the link host sees stops nothing, as when work cannot be stopped at once. */
  const knobs: { run(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult>; stuck: boolean } = {
    run: async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` }), stuck: false };
  let opened = 0, port = 0, turns = 0;
  let coordinator: Coordinator | undefined;
  const seen = (): Coordinator => {
    if (!knobs.stuck) return coordinator!;
    return new Proxy(coordinator!, { get: (target, prop) => {
      if (prop === "cancelUnder" || prop === "cancelDirect") return () => {};
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const tick = () => { try { coordinator?.tick(); } catch { /* closed */ } };
  const store = {
    bots: records, bot: (id: string) => records.find((bot) => bot.id === id), standIns: new Map<string, BotRecord>(),
    createTask: (botId: string) => { const threadId = `${botId}-work-${++opened}`; threads.add(threadId); return { threadId }; },
    taskByThread: (_botId: string, threadId: string) => (threads.has(threadId) ? { threadId } : undefined),
    appendMessage: (threadId: string, message: Record<string, unknown>) => { messages.push({ threadId, message }); },
    patchTask: () => {}, onChange: () => () => {}, group: () => undefined, groups: [], groupTaskByThread: () => undefined, markGroupThreadUnread: () => {},
    activePath: () => [], messagesFor: () => [], patchGroup: () => {},
  } as unknown as BotLinkHostDeps["store"];

  const build = () => createBotLinkHost({
    dataDir, environmentId: `${label}-environment`, store,
    roomLine: () => "", roomWindow: () => ({ lines: [], order: [], readable: [] }),
    coordinator: seen, kick: () => { queueMicrotask(tick); },
    level: () => "full", refusal: () => null, language: () => undefined, personName: () => undefined,
    sessions: { issue: () => { throw new Error("no sessions here"); }, revoke: () => true, attemptAllowed: () => ({ ok: true }), noteFailure: () => {} },
    local: () => false, owner: () => false, power: () => null,
    files: { carried: () => [], crossed: () => {}, sentWith: () => ({}), returnedWith: () => ({}), drop: () => {} },
    storeFile: async () => { throw new Error("no files here"); },
    serverName: () => label, publicOrigin: () => `http://127.0.0.1:${port}`, audit: (row) => { rows.push(row); }, actor: () => ({ kind: "loopback" }),
    log: (line) => { logs.push(line); },
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
  const answered: number[] = [];
  const http = createServer((req, res) => { res.on("finish", () => answered.push(res.statusCode)); void handle(req, res); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as AddressInfo).port;
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
    label, origin: `http://127.0.0.1:${port}`, messages, rows, runs, logs, knobs, answered,
    get made() { return made; },
    get linked() { return made.linked; },
    get coordinator() { return coordinator; },
    /** The server stops and starts again over the same data. */
    restart() {
      made.close();
      http.closeAllConnections();
      coordinator?.close();
      made = build();
      coordinator = createCoordinator({ dataDir, host: made.link.host(inner), log: () => {} });
      made.start();
    },
    /** A turn the person starts with one of this server's bots, in its own chat or in `threadId`. */
    begin(bot: Bot, text: string, threadId = `${bot.id}-chat`): At {
      const id = `${label}-turn-${++turns}`, address = { botId: bot.id, threadId };
      coordinator!.beginTurn({ id, address, brief: text, level: "full", origin: { kind: "user", request: text } });
      return { generation: id, address };
    },
    /** Where a running hand-off's turn hands work on from. */
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
    setCap(linkId: string, cap: ApprovalCap) { expect(made.linked.update(linkId, { cap }, ADMIN)).toMatchObject({ cap }); },
  };
}
type Server = Awaited<ReturnType<typeof server>>;

/** The inviter makes an invite and the joiner uses it; both then wait to see the other online. */
async function link(inviter: Server, joiner: Server) {
  const invite = inviter.linked.invite(ADMIN);
  if ("error" in invite) throw new Error(invite.error);
  const joined = await joiner.linked.join(invite.invite, ADMIN);
  const there = () => inviter.linked.list().find((one) => one.name === joiner.label);
  const here = () => joiner.linked.list().find((one) => one.id === joined.id);
  await until(() => there()?.state === "online" && here()?.state === "online", `${inviter.label} and ${joiner.label} are online`);
  return { inviterLink: there()!.id, joinerLink: joined.id };
}

/** `from` shows `bots` to `to` over the link they share; their addresses at `to`. */
async function offer(from: Server, fromLink: string, to: Server, toLink: string, bots: string[]) {
  from.linked.update(fromLink, { exposed: bots }, ADMIN);
  const seen = () => to.linked.list().find((one) => one.id === toLink)?.bots ?? [];
  await until(() => seen().length === bots.length, `${to.label} sees the exposed bots`);
  return seen().map((one) => one.id);
}

/** The inviter shows `bots` to the joiner; their addresses at the joiner. */
const expose = (inviter: Server, joiner: Server, ids: { inviterLink: string; joinerLink: string }, bots: string[]) =>
  offer(inviter, ids.inviterLink, joiner, ids.joinerLink, bots);

/** Holds the turns of these bots until `release`. */
function hold(at: Server, botIds: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  at.knobs.run = async (node) => { if (botIds.includes(node.botId)) await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; };
  return () => release();
}

const refusal = (botId: string): Answer => ({ status: 409, body: { receipts: [{ botId, outcome: "failed", detail: CHAINED }], error: CHAINED } });

describe("work from a linked server", () => {
  it("goes to no bot of another server, by address, by name or straight to the coordinator, while a hand-off to a bot here goes on", async () => {
    const head = await server("head", [WRITER, ANALYST], { ownLink: true }), branch = await server("branch", [SCOUT]), other = await server("other", [CLERK]);
    const [writer] = await expose(head, branch, await link(head, branch), ["writer"]);
    const [clerk] = await expose(other, head, await link(other, head), ["clerk"]);
    const release = hold(head, ["writer"]);

    const asked = branch.begin(SCOUT, "Draft the launch post");
    expect((await branch.coordinate(SCOUT, asked, [writer!], "Draft the launch post")).status).toBe(200);
    branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
    await until(() => head.runs.some((node) => node.botId === "writer"), "the writer works");
    const work = head.runs.find((node) => node.botId === "writer")!;
    const at = head.within(work);

    expect(await head.coordinate(WRITER, at, [HELPER], "Ask the person's computer")).toEqual(refusal(HELPER));
    expect(await head.coordinate(WRITER, at, [clerk!], "Ask the other server")).toEqual(refusal(clerk!));
    expect(await head.coordinate(WRITER, at, ["Helper"], "Ask by name")).toEqual(refusal("Helper"));
    for (const target of [HELPER, clerk!]) {
      expect(() => head.coordinator!.enqueue(at.address, at.generation, at.parentId, { botId: target, threadId: `${target}:direct` }, "Straight to the coordinator")).toThrow(CHAINED);
      expect(() => head.coordinator!.enqueue(at.address, at.generation, at.parentId, { botId: target, threadId: "room-thread", groupId: "room-1" }, "In a room")).toThrow(CHAINED);
    }

    const mixed = await head.coordinate(WRITER, at, [HELPER, "analyst"], "Check the numbers");
    expect(mixed.status).toBe(200);
    expect(mixed.body.notSent).toBe(CHAINED);
    expect(mixed.body.receipts).toEqual([{ botId: HELPER, outcome: "failed", detail: CHAINED }, expect.objectContaining({ botId: "analyst", outcome: "queued" })]);
    expect(head.coordinator!.children(work.id).map((node) => node.botId)).toEqual(["analyst"]);
    await until(() => head.runs.some((node) => node.botId === "analyst"), "the analyst works");
    expect(other.runs).toEqual([]);

    release();
    await until(() => branch.messages.some(({ message }) => (message.roomRequest as { phase?: string } | undefined)?.phase === "result"), "the writer's result is back");
    const result = branch.messages.find(({ message }) => (message.roomRequest as { phase?: string } | undefined)?.phase === "result")!;
    expect(result).toMatchObject({ threadId: "scout-chat", message: { tool: { ok: true } } });
  }, 60_000);

  it("runs at the lowest cap of the links whose work is in the thread", async () => {
    const head = await server("head", [WRITER, ANALYST, KEEPER]), branch = await server("branch", [SCOUT]), other = await server("other", [CLERK]);
    const toBranch = await link(head, branch), toOther = await link(head, other);
    const [writer] = await expose(head, branch, toBranch, ["writer"]);
    const [analyst] = await expose(head, other, toOther, ["analyst"]);
    const release = hold(head, ["writer", "analyst", "keeper"]);

    const fromBranch = branch.begin(SCOUT, "Draft"), fromOther = other.begin(CLERK, "Check");
    expect((await branch.coordinate(SCOUT, fromBranch, [writer!], "Draft")).status).toBe(200);
    expect((await other.coordinate(CLERK, fromOther, [analyst!], "Check")).status).toBe(200);
    branch.coordinator!.endTurn(fromBranch.generation, { ok: true, text: "Handed on." });
    other.coordinator!.endTurn(fromOther.generation, { ok: true, text: "Handed on." });
    await until(() => ["writer", "analyst"].every((botId) => head.runs.some((node) => node.botId === botId)), "both work");
    const work = (botId: string) => head.runs.find((node) => node.botId === botId)!;
    const capFor = head.made.link.capFor;

    expect(capFor("writer-chat", "full")).toBe("full");
    expect(capFor(work("writer").threadId, "full")).toBe("ask");
    head.setCap(toBranch.inviterLink, "edits");
    expect((["ask", "edits", "auto", "full", "custom"] as const).map((mode) => capFor(work("writer").threadId, mode))).toEqual(["ask", "edits", "edits", "edits", "edits"]);

    head.setCap(toOther.inviterLink, "auto");
    expect(capFor("keeper-chat", "full")).toBe("full");
    expect((await head.coordinate(WRITER, head.within(work("writer")), ["keeper"], "Keep the draft")).status).toBe(200);
    expect(capFor("keeper-chat", "full")).toBe("edits");
    expect((await head.coordinate(ANALYST, head.within(work("analyst")), ["keeper"], "Keep the numbers")).status).toBe(200);
    expect(capFor("keeper-chat", "full")).toBe("edits");
    head.setCap(toOther.inviterLink, "ask");
    expect(capFor("keeper-chat", "full")).toBe("ask");
    expect(capFor("keeper-chat", "ask")).toBe("ask");
    expect(capFor("writer-chat", "custom")).toBe("custom");
    release();
  }, 60_000);
});

describe("work this server starts", () => {
  it("still goes to a linked server's bot and to the person's other place, through the facade", async () => {
    const head = await server("head", [ANALYST], { ownLink: true }), other = await server("other", [CLERK]);
    const [clerk] = await expose(other, head, await link(other, head), ["clerk"]);
    expect(head.made.link.agents().map((one) => one.id)).toEqual([HELPER, clerk]);

    const asked = head.begin(ANALYST, "Plan the week");
    const answer = await head.coordinate(ANALYST, asked, [HELPER, clerk!], "Plan the week");
    expect(answer.status).toBe(200);
    expect((answer.body.receipts as Array<{ botId: string; outcome: string }>).map(({ botId, outcome }) => ({ botId, outcome }))).toEqual([
      { botId: HELPER, outcome: "queued" }, { botId: clerk, outcome: "queued" }]);
    await until(() => other.runs.some((node) => node.botId === "clerk"), "the clerk works");
    expect(head.made.link.capFor("analyst-chat", "full")).toBe("full");

    const listed = await (await fetch(`${head.origin}/api/linked-servers`)).json() as { servers: Array<{ name: string }> };
    expect(listed.servers.map((one) => one.name)).toEqual(["other"]);
    const elsewhere = await fetch(`${head.origin}/api/bots`, { headers: { authorization: `Bearer lsk_${"B".repeat(43)}` } });
    expect(elsewhere.status).toBe(403);
  }, 60_000);
});

/** A branch server hands work to the head's writer. The writer hands long work to the keeper, here, with no reply, and
 * finishes, so the work the branch started is done there while the keeper still runs. */
async function keeperAtWork(headInvites: boolean) {
  const head = await server("head", [WRITER, KEEPER]), branch = await server("branch", [SCOUT]), other = await server("other", [CLERK]);
  const pair = headInvites ? await link(head, branch) : await link(branch, head);
  const ids = headInvites ? { head: pair.inviterLink, branch: pair.joinerLink } : { head: pair.joinerLink, branch: pair.inviterLink };
  const [writer] = await offer(head, ids.head, branch, ids.branch, ["writer"]);
  const toOther = await link(other, head);
  const [clerk] = await offer(other, toOther.inviterLink, head, toOther.joinerLink, ["clerk"]);

  let releaseWriter!: () => void, releaseKeeper!: () => void;
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; }), keeperGate = new Promise<void>((resolve) => { releaseKeeper = resolve; });
  cleanups.push(() => releaseKeeper());
  const signals: AbortSignal[] = [];
  head.knobs.run = async (node, signal) => {
    if (node.botId === "writer") await writerGate;
    if (node.botId === "keeper") {
      signals.push(signal);
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); void keeperGate.then(resolve); });
    }
    return { ok: true, text: `${node.botId} did: ${node.text}` };
  };

  const asked = branch.begin(SCOUT, "Draft the launch post");
  expect((await branch.coordinate(SCOUT, asked, [writer!], "Draft the launch post")).status).toBe(200);
  branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
  await until(() => head.runs.some((node) => node.botId === "writer"), "the writer works");
  const work = head.runs.find((node) => node.botId === "writer")!;
  const at = head.within(work);
  const { node: kept } = head.coordinator!.enqueue(at.address, at.generation, at.parentId, { botId: "keeper", threadId: "keeper-chat" }, "Keep at it", { reply: "none", thread: "standing" });
  await until(() => head.runs.some((node) => node.botId === "keeper"), "the keeper works");
  releaseWriter();
  await until(() => branch.messages.some(({ message }) => (message.roomRequest as { phase?: string } | undefined)?.phase === "result"), "the writer's result is back");
  expect(head.coordinator!.node(work.id)?.status).toBe("completed");
  expect(head.coordinator!.node(kept.id)?.status).toBe("running");
  return { head, branch, ids, kept, clerk: clerk!, signals };
}

describe("when a link ends", () => {
  const ends = [
    { how: "an admin here removes it", headInvites: true, end: (head: Server, _branch: Server, ids: { head: string; branch: string }) => head.linked.remove(ids.head, ADMIN) },
    { how: "the server that joined removes it", headInvites: true, end: (_head: Server, branch: Server, ids: { head: string; branch: string }) => branch.linked.remove(ids.branch, ADMIN) },
    { how: "the server that invited removes it", headInvites: false, end: (_head: Server, branch: Server, ids: { head: string; branch: string }) => branch.linked.remove(ids.branch, ADMIN) },
  ] as const;

  for (const { how, headInvites, end } of ends) {
    it(`stops what bots here took on from the other server's work when ${how}`, async () => {
      const { head, branch, ids, kept, signals } = await keeperAtWork(headInvites);
      expect(await end(head, branch, ids)).toBe(true);
      await until(() => head.coordinator!.node(kept.id)?.status === "cancelled", "the keeper stops");
      expect(signals.at(-1)?.aborted).toBe(true);
    }, 60_000);
  }

  it("keeps the cap and the rule against other servers on work that could not stop, also after a restart", async () => {
    const { head, ids, kept, clerk } = await keeperAtWork(true);
    head.setCap(ids.head, "edits");
    head.knobs.stuck = true;
    expect(await head.linked.remove(ids.head, ADMIN)).toBe(true);
    expect(head.linked.list().map((one) => one.name)).toEqual(["other"]);
    const keeper = () => head.coordinator!.node(kept.id)!;
    const rules = async () => {
      expect(keeper().status).toBe("running");
      expect(head.made.link.capFor(keeper().threadId, "full")).toBe("edits");
      const at = head.within(keeper());
      expect(await head.coordinate(KEEPER, at, [clerk], "Ask the other server")).toEqual(refusal(clerk));
      expect(() => head.coordinator!.enqueue(at.address, at.generation, at.parentId, { botId: clerk, threadId: `${clerk}:direct` }, "Straight to the coordinator")).toThrow(CHAINED);
    };
    await rules();

    const ran = head.runs.filter((node) => node.botId === "keeper").length;
    head.restart();
    await until(() => head.runs.filter((node) => node.botId === "keeper").length > ran, "the keeper runs again");
    await rules();
  }, 60_000);
});

describe("an honest pair of servers", () => {
  it("carries a minute of full work both ways, the hand-offs, their cancels and their results, with nothing held back or refused", async () => {
    const head = await server("head", [WRITER, ANALYST]), branch = await server("branch", [SCOUT, CLERK]);
    const ids = await link(head, branch);
    const [writer] = await offer(head, ids.inviterLink, branch, ids.joinerLink, ["writer"]);
    const [clerk] = await offer(branch, ids.joinerLink, head, ids.inviterLink, ["clerk"]);
    for (const [side, worker] of [[head, "writer"], [branch, "clerk"]] as const) {
      side.knobs.run = (node, signal) => (node.botId !== worker ? Promise.resolve({ ok: true, text: "Handed on." })
        : new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ ok: false, text: "stopped" }), { once: true }); }));
    }
    const running = (at: Server, botId: string) => at.runs.filter((node) => node.botId === botId).length;
    const back = (at: Server) => at.rows.filter((row) => row.action === "linked-server.handoff" && (row.after as { direction?: unknown } | undefined)?.direction === "result-received").length;

    /** A minute of work from `sender` to `address`, in waves of as many hand-offs as may be open; each wave is stopped once it all runs. */
    async function minute(from: Server, sender: Bot, address: string, to: Server, worker: string) {
      for (let sent = 0; sent < ADMIT.perWindow; sent += ADMIT.open) {
        const size = Math.min(ADMIT.open, ADMIT.perWindow - sent), turns: string[] = [];
        for (let index = sent; index < sent + size; index++) {
          const at = from.begin(sender, `Task ${index}`, `${sender.id}-task-${index}`);
          expect((await from.coordinate(sender, at, [address], `Task ${index}`)).status).toBe(200);
          from.coordinator!.endTurn(at.generation, { ok: true, text: "Handed on." });
          turns.push(at.generation);
        }
        await until(() => running(to, worker) >= sent + size, `${to.label} runs ${sent + size}`);
        for (const generation of turns) from.coordinator!.cancelUnder(generation, "Stopped");
        await until(() => back(from) >= sent + size, `${from.label} has ${sent + size} results back`);
      }
    }
    await Promise.all([minute(branch, SCOUT, writer!, head, "writer"), minute(head, ANALYST, clerk!, branch, "clerk")]);

    expect([running(head, "writer"), running(branch, "clerk"), back(head), back(branch)]).toEqual(Array.from({ length: 4 }, () => ADMIT.perWindow));
    for (const side of [head, branch]) {
      expect(side.logs.filter((line) => line.includes("the rest waits"))).toEqual([]);
      expect(side.rows.filter((row) => row.action === "linked-server.refused")).toEqual([]);
    }
  }, 60_000);

  it("keeps within each other's limits when either one restarts", async () => {
    const head = await server("head", [WRITER, ANALYST]), branch = await server("branch", [SCOUT, CLERK]);
    const ids = await link(head, branch);
    const [writer] = await offer(head, ids.inviterLink, branch, ids.joinerLink, ["writer"]);
    const [clerk] = await offer(branch, ids.joinerLink, head, ids.inviterLink, ["clerk"]);
    const back = (at: Server) => at.rows.filter((row) => row.action === "linked-server.handoff" && (row.after as { direction?: unknown } | undefined)?.direction === "result-received").length;
    let round = 0;
    const both = async () => {
      round += 1;
      const asked = branch.begin(SCOUT, `Task ${round}`, `scout-task-${round}`), checked = head.begin(ANALYST, `Check ${round}`, `analyst-task-${round}`);
      expect((await branch.coordinate(SCOUT, asked, [writer!], `Task ${round}`)).status).toBe(200);
      expect((await head.coordinate(ANALYST, checked, [clerk!], `Check ${round}`)).status).toBe(200);
      branch.coordinator!.endTurn(asked.generation, { ok: true, text: "Handed on." });
      head.coordinator!.endTurn(checked.generation, { ok: true, text: "Handed on." });
      await until(() => back(branch) >= round && back(head) >= round, `round ${round} is back on both sides`, 45_000);
    };
    await both();
    head.restart();
    await both();
    branch.restart();
    await both();
    for (const side of [head, branch]) {
      expect(side.answered.filter((status) => status === 429)).toEqual([]);
      expect(side.logs.filter((line) => line.includes("the rest waits"))).toEqual([]);
      expect(side.rows.filter((row) => row.action === "linked-server.refused")).toEqual([]);
    }
    expect([head.runs.filter((node) => node.botId === "writer").length, branch.runs.filter((node) => node.botId === "clerk").length]).toEqual([3, 3]);
  }, 150_000);
});
