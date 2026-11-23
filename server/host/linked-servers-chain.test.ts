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

type Bot = { id: string; name: string };
type Answer = { status: number; body: Record<string, unknown> };
const WRITER: Bot = { id: "writer", name: "Writer" }, ANALYST: Bot = { id: "analyst", name: "Analyst" }, KEEPER: Bot = { id: "keeper", name: "Keeper" };
const SCOUT: Bot = { id: "scout", name: "Scout" }, CLERK: Bot = { id: "clerk", name: "Clerk" };
/** A bot of the person's own other place, as the head server knows it. */
const OWN_PEER = "abcdef01", HELPER = linkedId(OWN_PEER, "helper");
const ADMIN = { kind: "cli" } as const;

const cleanups: Array<() => Promise<void> | void> = [];
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
  const knobs: { run(node: HandoffView, signal: AbortSignal): Promise<HostTurnResult> } = { run: async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` }) };
  let opened = 0, port = 0, turns = 0;
  let coordinator: Coordinator | undefined;
  const tick = () => { try { coordinator?.tick(); } catch { /* closed */ } };
  const store = {
    bots: records, bot: (id: string) => records.find((bot) => bot.id === id), standIns: new Map<string, BotRecord>(),
    createTask: (botId: string) => { const threadId = `${botId}-work-${++opened}`; threads.add(threadId); return { threadId }; },
    taskByThread: (_botId: string, threadId: string) => (threads.has(threadId) ? { threadId } : undefined),
    appendMessage: (threadId: string, message: Record<string, unknown>) => { messages.push({ threadId, message }); },
    patchTask: () => {}, onChange: () => () => {}, group: () => undefined, groups: [], groupTaskByThread: () => undefined, markGroupThreadUnread: () => {},
    activePath: () => [], messagesFor: () => [], patchGroup: () => {},
  } as unknown as BotLinkHostDeps["store"];

  const made = createBotLinkHost({
    dataDir, environmentId: `${label}-environment`, store,
    roomLine: () => "", roomWindow: () => ({ lines: [], order: [], readable: [] }),
    coordinator: () => coordinator!, kick: () => { queueMicrotask(tick); },
    level: () => "full", refusal: () => null, language: () => undefined, personName: () => undefined,
    sessions: { issue: () => { throw new Error("no sessions here"); }, revoke: () => true, attemptAllowed: () => ({ ok: true }), noteFailure: () => {} },
    local: () => false, owner: () => false, power: () => null,
    files: { carried: () => [], crossed: () => {}, sentWith: () => ({}), returnedWith: () => ({}), drop: () => {} },
    storeFile: async () => { throw new Error("no files here"); },
    serverName: () => label, publicOrigin: () => `http://127.0.0.1:${port}`, audit: (row) => { rows.push(row); }, actor: () => ({ kind: "loopback" }),
    log: () => {},
  });
  const inner: CoordinatorHost = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
    names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
    levelOf: () => ({ level: "full" }), chiefOf: () => false,
    run: (node, _resumed, signal) => { runs.push(node); return knobs.run(node, signal); },
  };
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
    label, origin: `http://127.0.0.1:${port}`, made, linked: made.linked, coordinator, messages, rows, runs, knobs,
    /** A turn the person starts with one of this server's bots. */
    begin(bot: Bot, text: string): At {
      const id = `${label}-turn-${++turns}`, address = { botId: bot.id, threadId: `${bot.id}-chat` };
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

/** The inviter shows `bots` to the joiner; their addresses at the joiner. */
async function expose(inviter: Server, joiner: Server, ids: { inviterLink: string; joinerLink: string }, bots: string[]) {
  inviter.linked.update(ids.inviterLink, { exposed: bots }, ADMIN);
  const seen = () => joiner.linked.list().find((one) => one.id === ids.joinerLink)?.bots ?? [];
  await until(() => seen().length === bots.length, `${joiner.label} sees the exposed bots`);
  return seen().map((one) => one.id);
}

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
