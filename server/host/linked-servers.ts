// Links between this server and servers of other owners, so a bot here can hand work to a bot there and back. Each link
// is one guest bot link (server/bot-link/link.ts with a policy) with its own folder under <data>/linked-servers.
//
// Security invariants:
// - Only an admin makes a link: by making an invite here, or by pasting the other server's invite here. An invite is a
//   random code, good once and for INVITE_TTL_MS; only its sha256 is kept.
// - Accepting an invite gives the joining server one credential (GUEST_TOKEN_PREFIX + 32 random bytes). Only its sha256
//   is kept here; the joiner keeps it in that link's own mode-600 state. It reaches the link's exchange and file paths
//   here and nothing else: any other request that carries it is refused.
// - A peer sees only the bots an admin exposed to it, as id, name, title and description, read again at each hand-off.
//   Its work runs here as outside work, at no more than the link's approval cap.
// - A link takes at most ADMIT.open open hand-offs, and ADMIT.perWindow in each ADMIT.windowMs. At most LINKS_MAX links.
// - The inviter answers a link's joiner at most ADMIT.exchanges exchanges and ADMIT.sessions new sessions in each
//   ADMIT.windowMs; more get 429. The joiner waits JOINER_PACE between them, so it stays well below both.
// - Both sides are guests to each other, so the inviter and the joiner each apply these limits to the frames the other
//   sends: of one exchange or answer, a side takes the frames up to the first work frame (hand-off, cancel, result)
//   past ADMIT.frames in ADMIT.windowMs, or past ADMIT.chars characters to clean, and no work frame while ADMIT.outbox
//   frames for the other side wait. The rest is not acknowledged, so the other side sends it again later. Of the hellos
//   taken, only the last of a batch is kept, and at most ADMIT.hellos are read in ADMIT.windowMs.
// - Each side reads at most GUEST_EXCHANGE_MAX bytes in one request or answer, and ADMIT.bytes in ADMIT.windowMs. The
//   inviter answers a request past that 429 before it reads it; the joiner waits before its next exchange. A frame
//   is priced and cleaned from what parsed. Each side sends at most ADMIT.sendBytes in ADMIT.windowMs of work frames
//   (a hello and the other frames without work are outside it), so an honest pair stays within both. Each link writes at most 20 log lines a minute.
// - What a peer says (its place and bots, a hand-off's sender, words and file names, a result's words and file names)
//   loses its invisible and control characters before this server takes it (farFrame).
// - A frame whose file is larger than FILE_MAX_BYTES is dropped. The files of a link waiting here, put by the other side
//   or got from it, stay within SPOOL_ROOM: bytes, hand-off ids and files, checked before any of its folders is made.
// - A right credential is always served. A wrong one counts as a failed try of its sender, as a wrong invite code does.
// - A cancel for work the link does not know leaves no trace. Refusals write at most one activity row a minute.
// - Another server is asked only at https or at this machine's loopback, never through a redirect. Its answers and
//   its error texts never reach an error, a log line or an activity row here.
// - Work a linked server started here goes to no bot of another server, and its turns run at no more than that link's
//   cap: the lowest cap when the work of several links meets in one thread.
// - When a link ends (an admin removes it, the other server ends it or refuses its credential), all work its peer
//   started here stops, also what bots here took on from that work. Work that still runs keeps the rules above, also
//   after a restart: an ended link stays in the record, with its cap, while such work is open.
// Open risks:
// - The names a peer gives itself and its bots reach the bot lists here, cleaned to one short line each.
// - A peer whose hand-off files never come keeps the open slots of those hand-offs.
// - When the frames each side has for the other both pass ADMIT.outbox, that link carries no more work. Only a peer
//   that does not take what it is sent can make that happen.
// - A sender that fails too many tries is refused, also when it shares its address with a linked server.
// - A bot at work for a linked server can create a routine. The rule against handing that work on to another server
//   does not see the work that routine starts later.
import type { LookupAddress } from "node:dns";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { AdminActionRow, AdminActor, LinkedServerActor } from "../admin-activity.ts";
import { FILE_IDLE_MS, createDialer, readCapped, type SendPace } from "../bot-link/dial.ts";
import { SPOOL, createBotLink, type BotLink, type BotLinkDeps, type LinkEvent, type LinkPolicy } from "../bot-link/link.ts";
import { GUEST_EXCHANGE_MAX, LINK_PREFIX, isLinkedId, parseLinked, peerKey, type Place } from "../bot-link/protocol.ts";
import type { CoordinatorHost, HandoffView } from "../coordinator.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { json, readBody } from "../harness/http.ts";
import { bearerToken, requestSource, type RequestAuth } from "../request-auth.ts";
import { createLinkExchange } from "../routes/bot-link-exchange.ts";
import type { RouteContext } from "../routes/table.ts";
import type { Outcome } from "../runtime/types.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { ADMIT, createAdmission, createFrameBudget, createIntake, createPace, createRefusalRecord, createSendPace, kindOf, limitLog } from "./linked-servers-admit.ts";
import { LinkedServerDestinationError, publicFetch } from "./linked-servers-egress.ts";
import { createSpoolRoom, type SpoolLimits } from "./linked-servers-spool.ts";
import { farFileName, farFrame, readFar } from "./linked-servers-text.ts";
import {
  ENDED_MAX, GUEST_TOKEN_PREFIX, LINKS_MAX, addInvite, botIdSchema, cleanName, cleanPlace, decodeInvite, encodeInvite, guestOrigin, hashSecret, instanceDir, liveInvite,
  newLinkId, newToken, pruneInvites, readLinks, sameHash, writeLinks, type ApprovalCap, type StoredLink,
} from "./linked-servers-store.ts";

export { ADMIT } from "./linked-servers-admit.ts";
export { GUEST_TOKEN_PREFIX, INVITE_TTL_MS, LINKS_MAX, type ApprovalCap } from "./linked-servers-store.ts";

export const ACCEPT_PATH = "/api/linked-servers/accept";
export const GUEST_PATHS = { sync: "/api/linked-servers/sync", file: "/api/linked-servers/file" } as const;
export const CHAINED = "Work from another Seira cannot go on to a third one.";

const WORDS = { handedTo: "Handed to another Seira.", otherSide: "another Seira" };
const FAIL_TEXT = "The work could not be done on the other side.";
const REMOVED = "This work stopped because the link to another Seira was removed.";
const ENDED_THERE = "This work stopped because the other side ended the link.";
const LINK_OFF = "This link is not in use any more.";
const TOO_MANY = "Too many tries. Wait a minute and try again.";
const ONLY_LINK = "This sign-in works only for a link between two Seiras.";
const NOT_VALID = "That invite is not valid any more. Ask for a new one.";
const NOT_NOW = "The link could not be made now. Try again later.";
const FULL_HERE = "This Seira already has as many links as it can keep. Remove one first.";
const FALLBACK_NAME = "Another Seira";
const SELF_FALLBACK = "Seira";
const ANSWER_MAX = 64 * 1024;
const JOIN_MS = 10_000;
/** At most 60 exchanges and 6 new sessions a minute: half of ADMIT.exchanges and ADMIT.sessions, so restarts fit too. */
const JOINER_PACE = { gapMs: 1_000, freshMs: 10_000 };
const TIDY_MS = 60 * 60_000;
const GUEST_BEARER = /\bbearer\s+lsk_/iu;
const isBye = (frame: unknown) => kindOf(frame) === "bye";
const OUTCOMES: ReadonlySet<string> = new Set<Outcome>(["done", "needs_input", "cap_continued", "stalled", "interrupted", "budget", "provider_error", "denied", "expired", "stopped", "refused", "duplicate"]);
/** The exchange reads no auth: the peer was identified here, by its credential. */
const NO_AUTH: RequestAuth = { kind: "loopback", scopes: [] };

const farPlace = z.object({ id: z.string().min(1).max(200), name: z.string().max(1_000) }).strict();
const acceptBody = z.object({ code: z.string().max(100), place: farPlace }).strict();
const acceptAnswer = z.object({ token: z.string().regex(/^lsk_[A-Za-z0-9_-]{43}$/u), place: farPlace });

const CAP_RANK: Record<ApprovalCap, number> = { ask: 0, edits: 1, auto: 2 };
/** The approval mode work from a linked server runs at: the bot's own, but never above the link's cap. */
export function capMode(mode: ApprovalMode, cap: ApprovalCap): ApprovalMode {
  return mode === "custom" || mode === "full" || CAP_RANK[mode] > CAP_RANK[cap] ? cap : mode;
}

/** A join that did not happen, with a message the person can read. */
export class LinkedServerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LinkedServerError";
    this.status = status;
  }
}

export interface LinkedServerView {
  id: string;
  /** The name the other server gives itself. */
  name: string;
  /** `inviter`: this server made the invite. `joiner`: this server used the other server's invite. */
  role: "inviter" | "joiner";
  /** `ended`: the other server ended the link, so it carries nothing until it is removed and made again. */
  state: "online" | "offline" | "ended";
  /** This server's bots the other server can see and hand work to. */
  exposed: string[];
  cap: ApprovalCap;
  /** The other server's bots this server can hand work to, each by its address here. */
  bots: Array<{ id: string; name: string; title?: string; description?: string }>;
  createdAt: number;
}

/** A request before sign-in: the link's own paths take no other sign-in. */
export type GuestRequest = Pick<RouteContext, "req" | "res" | "url" | "path" | "method">;

type InstanceDeps = Pick<BotLinkDeps, "coordinator" | "bots" | "bot" | "refusal" | "model" | "level" | "openThread" | "hasThread" | "personName" | "sentRow" | "resultRow" | "kick" | "directoryChanged">;

export interface LinkedServersDeps extends InstanceDeps {
  dataDir: string;
  /** Files that cross with hand-offs, as for the person's own link. Absent: files do not cross. */
  files?: Omit<NonNullable<BotLinkDeps["files"]>, "discard">;
  /** Removes stored files that no hand-off carries and no message names. A refused hand-off's files go here. */
  dropFiles?(paths: readonly string[]): void;
  serverName(): string;
  /** This server's own identity, as the other server knows it. */
  selfId(): string;
  /** The address other servers reach this one at, or null when it has none. */
  publicOrigin(): string | null;
  audit(row: Omit<AdminActionRow, "at">): void;
  /** Whether this caller may try an invite code now. */
  attemptAllowed(key: string): boolean;
  /** A wrong invite code came from this caller. */
  attemptFailed?(key: string): void;
  /** The person's own link already uses this peer key. */
  ownPeer?(key: string): boolean;
  power?(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  fetch?: typeof fetch;
  /** Resolves a host name for the public-address check. A test stands in for DNS with it. */
  lookup?(host: string): Promise<LookupAddress[]>;
  /** Allow loopback addresses. Tests only; default: SEIRA_TEST_LINKED_LOOPBACK is 1. */
  allowLoopback?: boolean;
  now?: () => number;

  log?(line: string): void;
  /** Shorter waits for tests: how long an exchange is held, a joiner's first retry, and when a peer counts as gone. */
  timing?: { holdMs?: number; firstRetryMs?: number; seenMs?: number; pace?: { gapMs: number; freshMs: number } };
  /** Smaller limits for tests: a link's files waiting here, its work frames, hellos and characters to clean in a window, its frames
   * waiting here, its joiner's exchanges and new sessions in a window, and the bytes this side reads from it and sends it in
   * a window. */
  limits?: { spool?: SpoolLimits; frames?: number; outbox?: number; hellos?: number; chars?: number; exchanges?: number; sessions?: number; bytes?: number; sendBytes?: number };
}

type Instance = {
  id: string;
  key: string;
  link: BotLink;
  dialer: ReturnType<typeof createDialer> | null;
  exchange: ReturnType<typeof createLinkExchange> | null;
};

export type LinkedServers = ReturnType<typeof createLinkedServers>;

export function createLinkedServers(deps: LinkedServersDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** Security invariant: every request to another server goes through a fetch that dials only public addresses, so a saved link is checked at every connect, not only when it was made. */
  const dial = deps.fetch ?? publicFetch({ ...(deps.lookup ? { lookup: deps.lookup } : {}), ...(deps.allowLoopback !== undefined ? { allowLoopback: deps.allowLoopback } : {}) });
  const timing = deps.timing ?? {};
  const file = readLinks(deps.dataDir, log);
  const instances = new Map<string, Instance>();
  const admission = createAdmission(now);
  const refusals = createRefusalRecord(now);
  const intake = createIntake(now, { frames: deps.limits?.frames, hellos: deps.limits?.hellos, chars: deps.limits?.chars }, readFar);
  const sent = createFrameBudget(now, deps.limits?.frames);
  const bytesIn = createFrameBudget(now, deps.limits?.bytes ?? ADMIT.bytes);
  const sendPace = createSendPace(now, { bytes: deps.limits?.sendBytes });
  const heldBack = createRefusalRecord(now);
  const pace = createPace(now, { exchanges: deps.limits?.exchanges, sessions: deps.limits?.sessions });
  const outboxMax = deps.limits?.outbox ?? ADMIT.outbox;
  let upkeep: NodeJS.Timeout | undefined;

  const save = () => writeLinks(deps.dataDir, file);
  const recordOf = (id: string) => file.links.find((one) => one.id === id);
  const keyOf = (id: string) => peerKey(`guest:${id}`);
  const selfPlace = (): Place => ({ id: deps.selfId(), name: cleanName(deps.serverName()) || SELF_FALLBACK });
  const live = (entry: Instance | undefined): entry is Instance => Boolean(entry?.link.has(entry.key));
  const nameOf = (record: StoredLink) => {
    const entry = instances.get(record.id);
    return (live(entry) ? cleanName(entry.link.placeName(entry.key)) : "") || record.place.name;
  };
  const targetOf = (record: StoredLink) => ({ kind: "linked-server", id: record.id, name: nameOf(record) });
  const peerActor = (record: StoredLink): LinkedServerActor => ({ kind: "linked-server", linkId: record.id, name: nameOf(record) });
  const files = ((): BotLinkDeps["files"] => {
    const drop = deps.dropFiles;
    if (!deps.files || !drop) return deps.files;
    return { ...deps.files, discard: (passed) => drop(passed.map((one) => one.path)) };
  })();

  /** A new link id whose peer key no other link here uses. */
  function freshId(): string {
    for (let tries = 0; tries < 8; tries++) {
      const id = newLinkId(), key = keyOf(id);
      if (!file.links.some((one) => one.id === id || keyOf(one.id) === key) && !file.ended?.some((one) => one.key === key) && !deps.ownPeer?.(key)) return id;
    }
    throw new LinkedServerError("The link could not be made. Try again.", 500);
  }

  /** One crossing for the activity record: who and which hand-off, never its words. */
  function recordEvent(id: string, event: LinkEvent): void {
    const record = recordOf(id);
    if (!record) return;
    const base = { category: "linked-server" as const, target: targetOf(record) };
    if (event.kind === "refused") {
      const count = refusals.count(id);
      if (count === null) return;
      deps.audit({ ...base, action: "linked-server.refused", actor: peerActor(record), after: { reason: event.reason, bot: event.bot, farBot: event.far, handoff: event.id, count } });
      return;
    }
    if (event.kind === "result-sent" && event.outcome === "refused") return;
    const fromPeer = event.kind === "received" || event.kind === "result-received";
    const state = event.kind === "result-sent" || event.kind === "result-received" ? (event.ok ? "done" : "failed") : "started";
    const outcome = "outcome" in event && event.outcome && OUTCOMES.has(event.outcome) ? event.outcome : undefined;
    deps.audit({ ...base, action: "linked-server.handoff", actor: fromPeer ? peerActor(record) : { kind: "worker" },
      after: { direction: event.kind, bot: event.bot, farBot: event.far, handoff: event.id, state, ...(outcome ? { outcome } : {}) } });
  }

  /** The key of the link whose peer started the work under this root: the root's turn is asked by that peer's bot. */
  function starterKey(rootId: string): string | undefined {
    if (!rootId.startsWith(LINK_PREFIX)) return undefined;
    const root = deps.coordinator().node(rootId);
    return root && !root.parentId && isLinkedId(root.botId) ? parseLinked(root.botId)?.peer : undefined;
  }

  /** The roots of the open work each link's peer started here, by the link's key. */
  function openRoots(): Map<string, string[]> {
    const roots = new Map<string, string[]>();
    for (const rootId of new Set(deps.coordinator().active().map((node) => node.rootId))) {
      const key = starterKey(rootId);
      if (key) roots.set(key, [...(roots.get(key) ?? []), rootId]);
    }
    return roots;
  }

  /** The link ended: the work its peer started here stops, with all that bots here took on from it. */
  function stopWork(link: BotLink, key: string, reason: string): void {
    link.stopInbound(reason);
    for (const rootId of openRoots().get(key) ?? []) deps.coordinator().cancelUnder(rootId, reason);
  }

  /** Work of an ended link that is still open is stopped again. An ended link with no open work is forgotten. */
  function settleEnded(): void {
    if (!file.ended?.length) return;
    const roots = openRoots();
    for (const one of file.ended) for (const rootId of roots.get(one.key) ?? []) deps.coordinator().cancelUnder(rootId, REMOVED);
    const kept = file.ended.filter((one) => roots.has(one.key));
    if (kept.length === file.ended.length) return;
    file.ended = kept;
    save();
  }

  /** The other server answered the joiner's exchange with "not linked": the link is over on both sides. */
  function endedThere(id: string): void {
    const entry = instances.get(id);
    if (!entry?.link.on()) return;
    void entry.dialer?.stop();
    stopWork(entry.link, entry.key, ENDED_THERE);
    entry.link.turnOff(true);
    log("linked servers: the other server ended a link");
  }

  /** The frames of one exchange or answer from the link's other side that are taken now. */
  function intakeOf(id: string, frames: readonly unknown[], full: boolean): { count: number; frames: unknown[]; undo(): void } {
    const taken = intake.take(id, frames, full);
    if (taken.count < frames.length && heldBack.count(id) !== null) log("linked servers: another Seira sent more than a link takes now; the rest waits");
    return taken;
  }

  /** What this side sends the link, paced. */
  const sendsOf = (id: string): SendPace => ({
    next: (frames) => sendPace.next(id, frames),
    sent: (frames) => sendPace.sent(id, frames),
    took: (work, taken) => sendPace.took(id, work, taken),
  });

  function dialerFor(id: string, key: string, dataDir: string, link: BotLink, linkLog: (line: string) => void) {
    const watched = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      let response: Response;
      try { response = await dial(input, init); }
      catch (error) {
        if (error instanceof LinkedServerDestinationError) linkLog("linked servers: a saved link points to an address that is not public; it is not dialed");
        throw error;
      }
      const url = input instanceof Request ? input.url : String(input);
      if ((response.status === 401 || response.status === 403) && new URL(url).pathname === GUEST_PATHS.sync) setTimeout(() => endedThere(id), 0);
      return response;
    }) as typeof fetch;
    return createDialer({ link, fetch: watched, paths: GUEST_PATHS, farText: false, log: () => linkLog("linked servers: the other server could not be reached; trying again"),
      takes: (frames) => intakeOf(id, frames, link.backlog(key, 0) >= outboxMax),
      budget: { left: () => sent.left(id), spend: (frames) => sent.spend(id, frames) },
      reads: { left: () => bytesIn.left(id), spend: (bytes) => { bytesIn.spend(id, bytes); }, waitFor: (bytes) => bytesIn.waitFor(id, bytes) }, sends: sendsOf(id),
      room: createSpoolRoom(join(dataDir, SPOOL), deps.limits?.spool), answerMax: GUEST_EXCHANGE_MAX, pace: timing.pace ?? JOINER_PACE, fileIdleMs: FILE_IDLE_MS,
      ...(timing.holdMs ? { holdMs: timing.holdMs } : {}), ...(timing.firstRetryMs ? { firstRetryMs: timing.firstRetryMs } : {}) });
  }

  function open(record: StoredLink): Instance {
    const { id } = record, key = keyOf(id), dataDir = instanceDir(deps.dataDir, id), linkLog = limitLog(log, now);
    ensurePrivateDir(dataDir);
    const policy: LinkPolicy = {
      key,
      exposed: (botId) => recordOf(id)?.exposed.includes(botId) === true,
      admit: (_peer, openCount) => admission.admit(id, openCount),
      failText: () => FAIL_TEXT,
      words: WORDS,
      record: (event) => recordEvent(id, event),
    };
    const link = createBotLink({
      dataDir, policy, now, log: linkLog,
      coordinator: deps.coordinator, bots: deps.bots, bot: deps.bot,
      level: (bot) => capMode(deps.level(bot), recordOf(id)?.cap ?? "ask"),
      openThread: deps.openThread, hasThread: deps.hasThread, personName: deps.personName, sentRow: deps.sentRow, resultRow: deps.resultRow, kick: deps.kick,
      refusal: deps.refusal, model: deps.model, directoryChanged: deps.directoryChanged, files,
    });
    const endsOnBye: BotLink = { ...link, receive: (peer, read) => { const frames = read.map(farFrame); if (frames.some(isBye)) stopWork(link, key, ENDED_THERE); link.receive(peer, frames); } };
    const takes = (frames: readonly unknown[], ack: number) => intakeOf(id, frames, link.backlog(key, ack) >= outboxMax);
    const entry: Instance = {
      id, key, link,
      dialer: record.role === "joiner" ? dialerFor(id, key, dataDir, endsOnBye, linkLog) : null,
      exchange: record.role === "inviter"
        ? createLinkExchange({ link: endsOnBye, paths: GUEST_PATHS, power: deps.power ?? (() => null), room: createSpoolRoom(join(dataDir, SPOOL), deps.limits?.spool), takes,
          pace: { exchange: () => pace.exchange(id), session: () => pace.session(id) },
          bytes: { max: GUEST_EXCHANGE_MAX, spend: (bytes) => { if (bytesIn.left(id) < bytes) return false; bytesIn.spend(id, bytes); return true; }, left: () => bytesIn.left(id), giveBack: (bytes) => bytesIn.giveBack(id, bytes) }, sends: sendsOf(id),
          fileName: farFileName, log: linkLog, ...(timing.seenMs ? { seenMs: timing.seenMs } : {}) })
        : null,
    };
    instances.set(id, entry);
    return entry;
  }

  /** The caps of the links whose peer started the work under this root: a link here now, or one that ended while that
   * work could still run. A root stays its starter's after the link forgets the work. */
  function startersOf(rootId: string): ApprovalCap[] {
    if ((instances.size === 0 && !file.ended?.length) || !rootId.startsWith(LINK_PREFIX)) return [];
    const key = starterKey(rootId);
    return [...[...instances.values()].filter((entry) => entry.link.ownsRoot(rootId) || entry.key === key).map(capOf),
      ...(file.ended ?? []).filter((one) => one.key === key).map((one) => one.cap)];
  }

  function chained(node: Pick<HandoffView, "parentId" | "botId" | "rootId">): string | undefined {
    return node.parentId && isLinkedId(node.botId) && startersOf(node.rootId).length > 0 ? CHAINED : undefined;
  }

  const capOf = (entry: Instance): ApprovalCap => recordOf(entry.id)?.cap ?? "ask";

  function shut(entry: Instance): void {
    entry.dialer?.close();
    entry.link.close();
  }

  function view(record: StoredLink): LinkedServerView {
    const entry = instances.get(record.id);
    const base = { id: record.id, name: nameOf(record), role: record.role, exposed: [...record.exposed], cap: record.cap, createdAt: record.createdAt };
    if (!live(entry) || entry.dialer?.state().needsPairing) return { ...base, state: "ended", bots: [] };
    const bots = entry.link.linked().filter((one) => one.peer === entry.key).map(({ id, bot }) => {
      const title = cleanName(bot.title ?? "", 200), description = cleanName(bot.description ?? "", 400);
      return { id, name: cleanName(bot.name) || bot.id, ...(title ? { title } : {}), ...(description ? { description } : {}) };
    });
    return { ...base, state: entry.link.online(entry.key) ? "online" : "offline", bots };
  }

  /** Every error that accepting an invite does not answer itself gets one fixed answer, so a cause (a path in the data
   * folder) never reaches the joiner. */
  async function accept(ctx: GuestRequest): Promise<void> {
    try { await acceptOf(ctx); } catch (error) {
      log(`linked servers: an invite could not be taken (${error instanceof Error ? error.message : String(error)})`);
      if (ctx.res.headersSent || ctx.res.destroyed) ctx.res.destroy(); else json(ctx.res, 503, { error: NOT_NOW });
    }
  }

  async function acceptOf(ctx: GuestRequest): Promise<void> {
    const { req, res } = ctx;
    res.setHeader("cache-control", "no-store");
    const source = `linked-server:${requestSource(req)}`;
    if (!deps.attemptAllowed(source)) { req.resume(); return json(res, 429, { error: TOO_MANY }); }
    let raw: unknown;
    try { raw = await readBody(req, 16 * 1024); } catch { raw = null; }
    const body = acceptBody.safeParse(raw);
    const at = now();
    pruneInvites(file, at);
    const invite = body.success ? liveInvite(file, body.data.code, at) : undefined;
    if (!body.success || !invite) { deps.attemptFailed?.(source); return json(res, 403, { error: NOT_VALID }); }
    if (file.links.length >= LINKS_MAX) return json(res, 409, { error: "This Seira cannot take another link now." });
    let id: string;
    try { id = freshId(); } catch { return json(res, 500, { error: "The link could not be made. Try again." }); }
    const token = newToken();
    const record: StoredLink = { id, role: "inviter", place: cleanPlace(body.data.place, FALLBACK_NAME), exposed: [], cap: "ask", tokenHash: hashSecret(token), createdAt: at };
    invite.usedAt = at;
    pruneInvites(file, at);
    try {
      file.links.push(record);
      save();
      const self = selfPlace();
      open(record).link.pair({ self, sessionId: id, computer: record.place });
      deps.audit({ category: "linked-server", action: "linked-server.accept", target: targetOf(record), actor: peerActor(record) });
      return json(res, 200, { token, place: self });
    } catch (error) {
      file.links = file.links.filter((one) => one !== record);
      const entry = instances.get(id);
      if (entry) { instances.delete(id); try { shut(entry); } catch { /* closing anyway */ } }
      try { rmSync(instanceDir(deps.dataDir, id), { recursive: true, force: true }); } catch { /* a folder no link names is never read */ }
      delete invite.usedAt;
      file.invites.push(invite);
      try { save(); } catch { /* a link kept on disk is of no use: its credential was never sent */ }
      throw error;
    }
  }

  /** The instance whose credential this is. Every stored hash is compared, in constant time each. */
  function byToken(token: string): Instance | undefined {
    const hash = hashSecret(token);
    let found: string | undefined;
    for (const record of file.links) if (record.tokenHash && sameHash(record.tokenHash, hash)) found = record.id;
    return found ? instances.get(found) : undefined;
  }

  async function exchange(ctx: GuestRequest): Promise<void> {
    const { req, res } = ctx;
    res.setHeader("cache-control", "no-store");
    const token = bearerToken(req.headers.authorization);
    const entry = token?.startsWith(GUEST_TOKEN_PREFIX) ? byToken(token) : undefined;
    if (!entry?.exchange) {
      req.resume();
      const source = `linked-server:${requestSource(req)}`;
      if (!deps.attemptAllowed(source)) return json(res, 429, { error: TOO_MANY });
      deps.attemptFailed?.(source);
      return json(res, 401, { error: LINK_OFF });
    }
    const stillLinked = () => instances.get(entry.id) === entry && entry.link.has(entry.key);
    if (!stillLinked()) { req.resume(); return json(res, 401, { error: LINK_OFF }); }
    return entry.exchange.serve({ ...ctx, auth: NO_AUTH, json, readBody }, entry.key, stillLinked);
  }

  /** Security invariant: no part of the other server's answer but a parsed token and place leaves this function. */
  async function askToJoin(origin: string, code: string, self: Place): Promise<z.infer<typeof acceptAnswer>> {
    const unreachable = new LinkedServerError("The other side could not be reached. Try again later.", 502);
    let response: Response;
    try {
      response = await dial(`${origin}${ACCEPT_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(JOIN_MS),
        headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ code, place: self }) });
    } catch (error) {
      if (error instanceof LinkedServerDestinationError) throw new LinkedServerError(`${error.message} Ask for an invite with a public address.`, 400);
      log("linked servers: the other server could not be reached to join it");
      throw unreachable;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 403) throw new LinkedServerError(NOT_VALID, 409);
      if (response.status === 409) throw new LinkedServerError("The other side cannot take another link now.", 409);
      if (response.status === 429) throw new LinkedServerError(TOO_MANY, 429);
      throw unreachable;
    }
    const body = await readCapped(response, ANSWER_MAX);
    try {
      const parsed = acceptAnswer.safeParse(JSON.parse(body ?? ""));
      if (parsed.success) return parsed.data;
    } catch { /* answered below */ }
    log("linked servers: the other server's answer to a join did not parse");
    throw unreachable;
  }

  for (const record of file.links) open(record);

  return {
    list(): LinkedServerView[] { return file.links.map(view); },

    invite(actor: AdminActor): { invite: string; expiresAt: number } | { error: "no_address" } | { error: "full" } {
      const address = deps.publicOrigin();
      const origin = address ? guestOrigin(address, deps.allowLoopback) : null;
      if (!origin) return { error: "no_address" };
      if (file.links.length >= LINKS_MAX) return { error: "full" };
      const { code, expiresAt } = addInvite(file, now());
      save();
      deps.audit({ category: "linked-server", action: "linked-server.invite", target: { kind: "linked-server-invite" }, after: { expiresAt: new Date(expiresAt).toISOString() }, actor });
      return { invite: encodeInvite({ origin, name: selfPlace().name, code }), expiresAt };
    },

    /** Uses another server's invite. Throws a LinkedServerError whose message the person can read. */
    async join(text: string, actor: AdminActor): Promise<LinkedServerView> {
      const invite = decodeInvite(text);
      if (!invite) throw new LinkedServerError("That invite is not valid. Copy the whole invite and try again.", 400);
      const origin = guestOrigin(invite.origin, deps.allowLoopback);
      if (!origin) throw new LinkedServerError("That invite points to an address that is not secure or not public, so it was not used.", 400);
      if (file.links.length >= LINKS_MAX) throw new LinkedServerError(FULL_HERE, 409);
      const self = selfPlace();
      const answer = await askToJoin(origin, invite.code, self);
      if (file.links.length >= LINKS_MAX) throw new LinkedServerError(FULL_HERE, 409);
      const record: StoredLink = { id: freshId(), role: "joiner", place: cleanPlace(answer.place, FALLBACK_NAME), exposed: [], cap: "ask", createdAt: now() };
      file.links.push(record);
      save();
      const entry = open(record);
      entry.link.turnOn({ self, origin, token: answer.token, peer: record.place });
      entry.dialer?.start();
      deps.audit({ category: "linked-server", action: "linked-server.join", target: targetOf(record), actor });
      return view(record);
    },

    update(id: string, patch: { exposed?: string[]; cap?: ApprovalCap }, actor: AdminActor): LinkedServerView | null {
      const record = recordOf(id), entry = instances.get(id);
      if (!record || !entry) return null;
      const changed: string[] = [], before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
      if (patch.exposed) {
        const next = [...new Set(patch.exposed.filter((one) => botIdSchema.safeParse(one).success))].slice(0, 500);
        if (JSON.stringify(next) !== JSON.stringify(record.exposed)) { changed.push("exposed"); before.exposed = record.exposed; after.exposed = next; record.exposed = next; }
      }
      if (patch.cap && patch.cap !== record.cap) { changed.push("cap"); before.cap = record.cap; after.cap = patch.cap; record.cap = patch.cap; }
      if (changed.length === 0) return view(record);
      save();
      entry.link.botsChanged();
      deps.audit({ category: "linked-server", action: "linked-server.update", target: targetOf(record), changed, before, after, actor });
      return view(record);
    },

    async remove(id: string, actor: AdminActor): Promise<boolean> {
      const record = recordOf(id);
      if (!record) return false;
      const target = targetOf(record);
      const entry = instances.get(id), key = keyOf(id);
      if (entry) stopWork(entry.link, key, REMOVED);
      const told = entry?.dialer && record.role === "joiner" ? entry.dialer.stop({ bye: true }) : Promise.resolve(true);
      entry?.link.turnOff(true);
      file.links = file.links.filter((one) => one.id !== id);
      const ended = (file.ended ?? []).filter((one) => one.key !== key);
      file.ended = openRoots().has(key) ? [...ended, { key, cap: record.cap, at: now() }].slice(-ENDED_MAX) : ended;
      save();
      instances.delete(id);
      await told.catch(() => false);
      if (entry) shut(entry);
      admission.forget(id);
      refusals.forget(id);
      intake.forget(id);
      sent.forget(id);
      bytesIn.forget(id);
      sendPace.forget(id);
      heldBack.forget(id);
      pace.forget(id);
      rmSync(instanceDir(deps.dataDir, id), { recursive: true, force: true });
      deps.audit({ category: "linked-server", action: "linked-server.remove", target, actor });
      return true;
    },

    /** Requests before sign-in: an invite's acceptance, and a linked server's exchange and files. A request elsewhere
     * that carries a link's credential is refused. False: not this module's request. */
    async serve(ctx: GuestRequest): Promise<boolean> {
      const { req, res, path, method } = ctx;
      if (path === ACCEPT_PATH && method === "POST") { await accept(ctx); return true; }
      if ((path === GUEST_PATHS.sync && method === "POST") || (path === GUEST_PATHS.file && (method === "GET" || method === "PUT"))) { await exchange(ctx); return true; }
      if (!GUEST_BEARER.test(req.headers.authorization ?? "")) return false;
      req.resume();
      res.setHeader("cache-control", "no-store");
      json(res, 403, { error: ONLY_LINK });
      return true;
    },

    instances(): ReadonlyArray<{ id: string; link: BotLink }> { return [...instances.values()].map(({ id, link }) => ({ id, link })); },

    /** The coordinator's host with every linked server's bots in it, around `inner`. The links are read again at each
     * call, so a link made or removed while the server runs takes effect at once. */
    host(inner: CoordinatorHost): CoordinatorHost {
      let made: { links: BotLink[]; host: CoordinatorHost } | undefined;
      const current = (): CoordinatorHost => {
        const links = [...instances.values()].map((entry) => entry.link);
        if (made?.links.length === links.length && made.links.every((one, index) => one === links[index])) return made.host;
        const outer = links.reduce((host, link) => link.host(host), inner);
        made = { links, host: { ...outer, validate: (node, parent) => chained(node) ?? outer.validate(node, parent) } };
        return made.host;
      };
      return new Proxy(inner, { get: (_target, prop) => Reflect.get(current(), prop) });
    },

    /** Whether a linked server started the work under this root. */
    started: (rootId: string): boolean => startersOf(rootId).length > 0,

    /** The approval mode of a turn in this thread: no more than the cap of each link whose work runs in it, or that
     * opened it. */
    capFor(threadId: string, mode: ApprovalMode): ApprovalMode {
      if (instances.size === 0 && !file.ended?.length) return mode;
      const caps = new Set<ApprovalCap>();
      for (const entry of instances.values()) if (entry.link.openedThread(threadId)) caps.add(capOf(entry));
      for (const node of deps.coordinator().inThread(threadId, { open: true })) for (const cap of startersOf(node.rootId)) caps.add(cap);
      return [...caps].reduce(capMode, mode);
    },

    start(): void {
      for (const entry of instances.values()) {
        entry.link.tidy();
        if (entry.dialer && entry.link.role() === "dialer") entry.dialer.start({ gentle: true });
      }
      settleEnded();
      if (upkeep) return;
      upkeep = setInterval(() => { for (const entry of instances.values()) entry.link.tidy(); settleEnded(); }, TIDY_MS);
      upkeep.unref?.();
    },

    close(): void {
      if (upkeep) clearInterval(upkeep);
      upkeep = undefined;
      for (const entry of instances.values()) shut(entry);
      instances.clear();
    },
  };
}
