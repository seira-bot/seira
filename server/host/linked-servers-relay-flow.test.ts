// Two servers in one process link through a fake Seira Relay. The inviting server has no address and no HTTP listener; the
// global fetch must never run for a relay link.
import { createECDH, createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { admission, admissionHash, b64u, credentialHash, ed25519RawPublicKey, fromB64u, keyId, mintRelayToken, psk } from "../../companion/src/e2e/credentials.ts";
import { TRANSPORT_RELAY } from "../../companion/src/e2e/noise.ts";
import { dial } from "../../companion/src/e2e/phone.ts";
import { startFakeRelay, type FakeRelay } from "../../companion/test/e2e/fake-relay.ts";
import type { AdminActionRow } from "../admin-activity.ts";
import { createCoordinator, type CoordinateBotsCall, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import { json } from "../harness/http.ts";
import { startPhoneRelay, type PhoneRelay } from "../phone-relay.ts";
import { SessionRegistry } from "../sessions.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBotLinkHost, type BotLinkHostDeps } from "./bot-link-host.ts";
import type { PassedFile } from "./handoff-files.ts";
import { readRelayLinks, openRelaySession, type RelayRoute } from "./linked-servers-relay.ts";
import { decodeAnyInvite } from "./linked-servers-store.ts";

type Bot = { id: string; name: string };
const WRITER: Bot = { id: "writer", name: "Writer" }, SCOUT: Bot = { id: "scout", name: "Scout" };
const ADMIN = { kind: "cli" } as const;
const MIB = 1024 * 1024;
const CANARY = "canary-7f3a9c-plain-words-that-only-a-sealed-record-may-hold";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const until = async (what: () => boolean, label: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/** The link credential a joining server keeps in its data folder. */
function lskIn(root: string): string | null {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const found = /lsk_[A-Za-z0-9_-]{43}/u.exec(readFileSync(join(entry.parentPath, entry.name), "utf8"));
    if (found) return found[0];
  }
  return null;
}
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    fetchCalls.push(String(input));
    throw new Error(`fetch must not run: ${String(input)}`);
  }) as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });
});

interface World {
  relay: FakeRelay;
  /** Every byte the relay carried or saw, in both directions. */
  captured: Buffer[];
  port: number;
}

async function world(): Promise<World> {
  const captured: Buffer[] = [];
  const tamper = (_direction: unknown, data: Buffer) => { captured.push(Buffer.from(data)); return data; };
  const relay = await startFakeRelay({ keys, tamper });
  const state: World = { relay, captured, port: relay.port };
  cleanups.push(() => state.relay.close().catch(() => {}));
  const before = process.env.SEIRA_PHONE_RELAY_URL;
  process.env.SEIRA_PHONE_RELAY_URL = relay.url;
  cleanups.push(() => { if (before === undefined) delete process.env.SEIRA_PHONE_RELAY_URL; else process.env.SEIRA_PHONE_RELAY_URL = before; });
  return state;
}

/** One server as index.ts wires it. It has no address and no HTTP listener. */
async function node(label: string, bots: Bot[], where: World) {
  const dataDir = mkdtempSync(join(tmpdir(), `linked-relay-${label}-`));
  const attachments = join(dataDir, "attachments");
  mkdirSync(attachments);
  const records = bots.map((bot) => ({ ...bot, threadId: `${bot.id}-chat`, modelSelection: { instanceId: "", model: "" } }) as unknown as BotRecord);
  const threads = new Set(records.map((bot) => bot.threadId));
  const messages: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  const rows: Array<Omit<AdminActionRow, "at">> = [];
  const runs: HandoffView[] = [];
  const logs: string[] = [];
  const requests: string[] = [];
  const ledger = new Map<string, { from: { botId: string; name: string }; files: PassedFile[] }>();
  const knobs: { run(node: HandoffView): Promise<HostTurnResult> } = { run: async (one) => ({ ok: true, text: `${one.botId} did: ${one.text}` }) };
  let opened = 0, turns = 0;
  let coordinator: Coordinator | undefined;
  let phoneRelay: PhoneRelay | null = null;
  let sessions: SessionRegistry | null = null;
  const tick = () => { try { coordinator?.tick(); } catch { /* closed */ } };
  const store = {
    bots: records, bot: (id: string) => records.find((bot) => bot.id === id), standIns: new Map<string, BotRecord>(),
    createTask: (botId: string) => { const threadId = `${botId}-work-${++opened}`; threads.add(threadId); return { threadId }; },
    taskByThread: (_botId: string, threadId: string) => (threads.has(threadId) ? { threadId } : undefined),
    appendMessage: (threadId: string, message: Record<string, unknown>) => { messages.push({ threadId, message }); },
    patchTask: () => {}, onChange: () => () => {}, group: () => undefined, groups: [], groupTaskByThread: () => undefined, markGroupThreadUnread: () => {},
    activePath: () => [], messagesFor: () => [], patchGroup: () => {},
  } as unknown as BotLinkHostDeps["store"];
  const keep = (name: string, data: Buffer): PassedFile => {
    const path = join(attachments, `${sha(data).slice(0, 24)}-${name}`);
    writeFileSync(path, data);
    return { kind: "file", path, name, mime: "application/octet-stream", bytes: data.length };
  };

  const build = () => createBotLinkHost({
    dataDir, environmentId: `${label}-environment`, store,
    roomLine: () => "", roomWindow: () => ({ lines: [], order: [], readable: [] }),
    coordinator: () => coordinator!, kick: () => { queueMicrotask(tick); },
    level: () => "full", refusal: () => null, language: () => undefined, personName: () => undefined,
    sessions: { issue: () => { throw new Error("no sessions here"); }, revoke: () => true, attemptAllowed: () => ({ ok: true }), noteFailure: () => {} },
    local: () => false, owner: () => false, power: () => null,
    files: {
      carried: (id, way) => ledger.get(`${id}:${way}`)?.files ?? [],
      crossed: (id, way, from, files) => { if (!ledger.has(`${id}:${way}`)) ledger.set(`${id}:${way}`, { from, files: [...files] }); },
      sentWith: () => ({}), returnedWith: () => ({}), drop: () => {},
    },
    storeFile: async (path, name) => {
      const data = readFileSync(path);
      const kept = keep(name, data);
      return { attachment: { kind: "file", path: kept.path, name, mime: kept.mime }, bytes: data.length } as never;
    },
    serverName: () => label, publicOrigin: () => null, audit: (row) => { rows.push(row); }, actor: () => ({ kind: "loopback" }),
    log: (line) => { logs.push(line); },
  });
  const inner: CoordinatorHost = {
    validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
    names: (one, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: one.botId }),
    levelOf: () => ({ level: "full" }), chiefOf: () => false,
    run: (one) => { runs.push(one); return knobs.run(one); },
  };
  let made = build();
  coordinator = createCoordinator({ dataDir, host: made.link.host(inner), log: () => {} });
  made.start();
  const ticker = setInterval(tick, 15);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);
    try {
      if (await made.link.publicRoutes({ req, res, url, path: url.pathname, method: req.method ?? "GET" })) return;
      req.resume();
      json(res, 404, { error: "not here" });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error) });
    }
  }

  const iat = Math.floor(Date.now() / 1000);
  const hostId = randomBytes(16);
  const grant = { token: mintRelayToken({ v: 1, kid: "k1", hid: b64u(hostId), iid: `${label}-install`, iat, exp: iat + 43_200 }, signingKey), hostId: b64u(hostId), nodes: ["relay1.seira.bot"], expiresAt: (iat + 43_200) * 1000, refreshAfter: (iat + 3_600) * 1000 };
  /** `serve --relay`: the phone relay carries this server's link requests. */
  function serveRelay() {
    sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
    phoneRelay = startPhoneRelay({
      env: { SEIRA_PHONE_RELAY: "1", SEIRA_PHONE_RELAY_URL: `ws://127.0.0.1:${where.port}` }, dataDir, sessions,
      handle: (req, res) => void handle(req, res), serverName: () => label, publicOrigin: () => null, version: "0.1.152", refusal: null,
      fetchGrant: async () => grant, guests: made.linked.relayGuests, log: () => {},
    });
    if (!phoneRelay) throw new Error("the relay did not start");
  }
  function stopRelay() { phoneRelay?.stop(); phoneRelay = null; sessions?.close(); sessions = null; }

  cleanups.push(async () => {
    clearInterval(ticker);
    stopRelay();
    made.close();
    try { coordinator?.close(); } catch { /* closed */ }
    await removeTempDir(dataDir);
  });

  type At = { generation: string; parentId?: string; address: { botId: string; threadId: string } };
  const self = {
    label, dataDir, messages, rows, runs, logs, requests, knobs, ledger, keep, hostId: b64u(hostId),
    get made() { return made; },
    get linked() { return made.linked; },
    get coordinator() { return coordinator!; },
    get phoneRelay() { return phoneRelay; },
    serveRelay, stopRelay,
    /** The server stops and starts again over the same data. */
    restart() {
      const served = phoneRelay !== null;
      stopRelay();
      made.close();
      coordinator?.close();
      made = build();
      coordinator = createCoordinator({ dataDir, host: made.link.host(inner), log: () => {} });
      made.start();
      if (served) serveRelay();
    },
    begin(bot: Bot, text: string): At {
      const id = `${label}-turn-${++turns}`, address = { botId: bot.id, threadId: `${bot.id}-chat` };
      coordinator!.beginTurn({ id, address, brief: text, level: "full", origin: { kind: "user", request: text } });
      return { generation: id, address };
    },
    coordinate(sender: Bot, at: At, botIds: string[], message: string, files: PassedFile[] = []) {
      const local = async () => ({ status: 409, body: { error: "not here" } });
      const call: CoordinateBotsCall = { botIds, message, rework: false, thread: "new", reply: "resume", consult: false, ...(files.length ? { files } : {}) };
      return made.link.coordinate(call, { sender, address: at.address, generation: at.generation, external: false, handed: () => {} }, local);
    },
    relayFile: () => readRelayLinks(dataDir),
  };
  return self;
}
type Node = Awaited<ReturnType<typeof node>>;

/** The inviter makes an invite once its relay is up; the joiner uses it. */
async function linkUp(inviter: Node, joiner: Node) {
  let invite: { invite: string; expiresAt: number } | null = null;
  await until(() => {
    const made = inviter.linked.invite(ADMIN);
    if ("error" in made) return false;
    invite = made;
    return true;
  }, `${inviter.label} makes an invite`);
  const joined = await joiner.linked.join(invite!.invite, ADMIN);
  const there = () => inviter.linked.list().find((one) => one.kind === "seira" && one.name === joiner.label);
  const here = () => joiner.linked.list().find((one) => one.id === joined.id);
  await until(() => there()?.state === "online" && here()?.state === "online", `${inviter.label} and ${joiner.label} are online`);
  return { invite: invite!.invite, inviterLink: there()!.id, joinerLink: joined.id };
}

async function expose(from: Node, fromLink: string, to: Node, toLink: string, bots: string[]) {
  from.linked.update(fromLink, { exposed: bots }, ADMIN);
  const seen = () => { const one = to.linked.list().find((link) => link.id === toLink); return one?.kind === "seira" ? one.bots : []; };
  await until(() => seen().length === bots.length, `${to.label} sees the exposed bots`);
  return seen();
}

const admittedCount = (where: World, inviter: Node) => where.relay.admitted(inviter.hostId).size;

describe("linked servers through Seira Relay", () => {
  it("answers no_address and relay_waiting before the relay is ready, and stores no invite (AC-09)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where);
    expect(inviter.linked.invite(ADMIN)).toEqual({ error: "no_address" });
    inviter.serveRelay();
    const first = inviter.linked.invite(ADMIN);
    if ("error" in first) expect(first.error).toBe("relay_waiting");
    if ("error" in first) expect(inviter.relayFile().invites).toEqual([]);
    await until(() => !("error" in inviter.linked.invite(ADMIN)), "the relay is ready");
    expect(inviter.relayFile().invites.length).toBeGreaterThan(0);
  });

  it("makes a version 2 invite, joins through the relay, and carries work and a 5 MiB file each way (AC-02, 04, 05, 06, 07, 10, 15, 19)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where), joiner = await node("branch", [SCOUT], where);
    inviter.serveRelay();
    const ids = await linkUp(inviter, joiner);

    const decoded = decodeAnyInvite(ids.invite);
    expect(decoded).toMatchObject({ v: 2, name: "head" });
    // AC-15: the invite is used, so its admission is gone and a second dial fails.
    expect(inviter.relayFile().invites).toEqual([]);
    expect(inviter.relayFile().hosted).toEqual([ids.inviterLink]);
    const route = decoded as Extract<NonNullable<typeof decoded>, { v: 2 }>;
    const { code } = route;
    await expect(openRelaySession({ e2e: route.e2e, transportKey: route.transportKey, hostId: route.hostId } satisfies RelayRoute, code, { app: "test/1", baseUrl: `ws://127.0.0.1:${where.port}` })).rejects.toBeDefined();

    expect(joiner.relayFile().joined[ids.joinerLink]).toBeDefined();
    expect(joiner.linked.list().find((one) => one.id === ids.joinerLink)).toMatchObject({ route: "relay", role: "joiner" });
    expect(inviter.linked.list().find((one) => one.id === ids.inviterLink)).toMatchObject({ route: "relay", role: "inviter" });
    expect(admittedCount(where, inviter)).toBe(1);

    // AC-07: the hello holds the full bot entries, both ways.
    const writers = await expose(inviter, ids.inviterLink, joiner, ids.joinerLink, ["writer"]);
    expect(writers).toEqual([expect.objectContaining({ name: "Writer" })]);
    const scouts = await expose(joiner, ids.joinerLink, inviter, ids.inviterLink, ["scout"]);
    expect(scouts).toEqual([expect.objectContaining({ name: "Scout" })]);

    // AC-06: a 5 MiB file goes with the hand-off and a 5 MiB file comes back with the result.
    const outgoing = randomBytes(5 * MIB), incoming = randomBytes(5 * MIB);
    inviter.knobs.run = async (one) => {
      inviter.ledger.set(`${one.id}:returned`, { from: { botId: "writer", name: "Writer" }, files: [inviter.keep("back.bin", incoming)] });
      return { ok: true, text: `Writer did: ${one.text}` };
    };
    const asked = joiner.begin(SCOUT, "Draft");
    const answer = await joiner.coordinate(SCOUT, asked, [writers[0]!.id], `Draft this. ${CANARY}`, [joiner.keep("out.bin", outgoing)]);
    expect(answer.status).toBe(200);
    joiner.coordinator.endTurn(asked.generation, { ok: true, text: "Handed on." });
    await until(() => inviter.runs.some((one) => one.botId === "writer"), "the writer works");
    const work = inviter.runs.find((one) => one.botId === "writer")!;
    const arrived = inviter.ledger.get(`${work.id}:sent`)?.files ?? [];
    expect(arrived).toHaveLength(1);
    expect(sha(readFileSync(arrived[0]!.path))).toBe(sha(outgoing));
    await until(() => joiner.messages.some(({ message }) => (message.roomRequest as { phase?: string } | undefined)?.phase === "result"), "the result is back", 60_000);
    const requestId = (answer.body.receipts as Array<{ requestId?: string }>)[0]!.requestId!;
    const back = joiner.ledger.get(`${requestId}:returned`)?.files ?? [];
    expect(back).toHaveLength(1);
    expect(sha(readFileSync(back[0]!.path))).toBe(sha(incoming));

    // AC-05, AC-19: no request left through the global fetch.
    expect(fetchCalls).toEqual([]);
    // AC-10: the relay never saw a plain word of the hand-off.
    const seen = Buffer.concat(where.captured);
    expect(seen.length).toBeGreaterThan(MIB);
    expect(seen.includes(Buffer.from(CANARY))).toBe(false);
    expect(seen.includes(outgoing.subarray(0, 4_096))).toBe(false);
    expect(seen.includes(Buffer.from("Writer"))).toBe(false);
    expect(seen.includes(Buffer.from(ids.invite))).toBe(false);
  }, 120_000);

  it("brings the link back after the inviting server, the joining server, and the relay restart (AC-08)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where), joiner = await node("branch", [SCOUT], where);
    inviter.serveRelay();
    const ids = await linkUp(inviter, joiner);
    const online = () => inviter.linked.list().find((one) => one.id === ids.inviterLink)?.state === "online" && joiner.linked.list().find((one) => one.id === ids.joinerLink)?.state === "online";
    const exchange = async (label: string) => {
      const [writer] = await expose(inviter, ids.inviterLink, joiner, ids.joinerLink, ["writer"]);
      const before = inviter.runs.length;
      const asked = joiner.begin(SCOUT, label);
      expect((await joiner.coordinate(SCOUT, asked, [writer!.id], label)).status).toBe(200);
      joiner.coordinator.endTurn(asked.generation, { ok: true, text: "Handed on." });
      await until(() => inviter.runs.length > before, `${label} reaches the writer`, 60_000);
    };
    await exchange("first");

    inviter.restart();
    await until(online, "online after the inviting server restarted", 60_000);
    await exchange("after the inviting server");

    joiner.restart();
    await until(online, "online after the joining server restarted", 60_000);
    expect(joiner.relayFile().joined[ids.joinerLink]).toBeDefined();
    await exchange("after the joining server");

    const old = where.relay;
    await old.kill();
    where.relay = await startFakeRelay({ keys, port: where.port, tamper: (_d, data) => data });
    await until(online, "online after the relay restarted", 60_000);
    await exchange("after the relay");
    expect(fetchCalls).toEqual([]);
  }, 240_000);

  it("fails the handshake of a party with a valid admission but a wrong key, and no stream reaches the server (AC-14)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where), joiner = await node("branch", [SCOUT], where);
    inviter.serveRelay();
    const ids = await linkUp(inviter, joiner);
    const token = lskIn(joiner.dataDir);
    expect(token).not.toBeNull();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const wrongKey = ecdh.getPublicKey();
    const hostId = fromB64u(inviter.hostId)!;
    const hash = credentialHash(token!);
    const before = inviter.requests.length;
    await expect(dial({
      url: `ws://127.0.0.1:${where.port}/v1/phone`, transportByte: TRANSPORT_RELAY, remoteStatic: wrongKey,
      psk: psk(hash, keyId(wrongKey)), app: "test/1", relay: { hostId, adm: admission(hash, hostId) },
    })).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inviter.requests.length).toBe(before);
    expect(admissionHash(admission(hash, hostId))).toBeTypeOf("string");
  }, 60_000);

  it("refuses a fifth relay link and a third waiting relay invite (AC-17)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where);
    inviter.serveRelay();
    await until(() => !("error" in inviter.linked.invite(ADMIN)), "the relay is ready");
    // One invite is waiting already; a second waits too.
    expect("error" in inviter.linked.invite(ADMIN)).toBe(false);
    expect(inviter.linked.invite(ADMIN)).toEqual({ error: "relay_full" });
    expect(inviter.relayFile().invites).toHaveLength(2);

    const joiners = await Promise.all(Array.from({ length: 5 }, (_, index) => node(`branch${index}`, [SCOUT], where)));
    for (const [index, one] of joiners.slice(0, 4).entries()) {
      let made: ReturnType<typeof inviter.linked.invite> = { error: "relay_waiting" };
      await until(() => { made = inviter.linked.invite(ADMIN); return !("error" in made); }, `invite ${index}`);
      await one.linked.join((made as { invite: string }).invite, ADMIN);
    }
    await until(() => inviter.relayFile().hosted.length === 4, "four relay links are hosted");
    expect(inviter.linked.invite(ADMIN)).toEqual({ error: "relay_full" });
    expect(inviter.relayFile().hosted).toHaveLength(4);
  }, 120_000);

  it("drops the admission and ends the link on either side when an admin removes it (AC-18)", async () => {
    const where = await world();
    const inviter = await node("head", [WRITER], where), joiner = await node("branch", [SCOUT], where), other = await node("shop", [SCOUT], where);
    inviter.serveRelay();
    const first = await linkUp(inviter, joiner);
    const second = await linkUp(inviter, other);
    expect(admittedCount(where, inviter)).toBe(2);

    // The inviting side removes: the admission goes and the joining side sees the link end.
    expect(await inviter.linked.remove(first.inviterLink, ADMIN)).toBe(true);
    await until(() => admittedCount(where, inviter) === 1, "the removed link is no longer admitted");
    expect(inviter.relayFile().hosted).toEqual([second.inviterLink]);
    await until(() => joiner.linked.list().find((one) => one.id === first.joinerLink)?.state === "ended", "the joining side sees the end", 60_000);

    // The joining side removes: the inviting side drops the link and its admission.
    expect(await other.linked.remove(second.joinerLink, ADMIN)).toBe(true);
    expect(other.relayFile().joined).toEqual({});
    await until(() => admittedCount(where, inviter) === 0, "the second link is no longer admitted", 60_000);
    expect(inviter.relayFile().hosted).toEqual([]);
    expect(existsSync(join(other.dataDir, "linked-servers", second.joinerLink))).toBe(false);
    expect(fetchCalls).toEqual([]);
  }, 120_000);
});
