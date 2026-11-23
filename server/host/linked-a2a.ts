// This server's A2A peers (server/host/a2a-peers-store.ts) as running links. Each peer is one guest bot link, as a linked
// server's is, with the A2A transport (server/a2a/transport.ts) in place of the exchange: its inbound side answers the
// peer's calls, and its outbound side calls the peer's agent.
//
// Security invariants:
// - The far agent is an outside party, also when its token is valid. All it says, and all work its calls start, reaches
//   its link through farFrame, under the policy, admission and approval cap of a linked server.
// - Only the sha256 of an inbound token is kept, in the peer's record. The token is shown once, when it is made.
// - The outbound token is kept only in the state of the peer's own link (mode 600). No view, log line or activity row
//   holds a token, a hash or the peer's address.
// - A rotated, turned off or removed inbound token is refused at once: the record changes first, then held calls end.
// - A peer's link counts with every other link here (createLinkedServers), so work it started goes to no other link and
//   work another link started goes to no A2A peer.
import { mkdirSync, rmSync } from "node:fs";

import type { AdminActionRow, AdminActor, LinkedServerActor } from "../admin-activity.ts";
import type { EgressDeps } from "../a2a/egress.ts";
import { ROOT_CARD_PATH, createA2aInbound, type A2aGate, type A2aInbound, type InboundBot } from "../a2a/inbound.ts";
import { PROBLEM, createA2aOutbound, type A2aOutbound } from "../a2a/outbound.ts";
import { A2A_PREFIX } from "../a2a/protocol.ts";
import { createTaskIndex, type TaskIndex } from "../a2a/tasks.ts";
import { createA2aTransport, type A2aTransport } from "../a2a/transport.ts";
import type { BotLink, LinkEvent, LinkPolicy } from "../bot-link/link.ts";
import { peerKey, type Place } from "../bot-link/protocol.ts";
import type { Coordinator } from "../coordinator.ts";
import { PEER_NAME_MAX, newA2aToken, outboundUrl, peerByToken, readA2aPeers, writeA2aPeers, type A2aPeer, type EndedPeer } from "./a2a-peers-store.ts";
import { ADMIT, createFrameBudget } from "./linked-servers-admit.ts";
import { ENDED_MAX, LINKS_MAX, botIdSchema, cleanName, guestOrigin, instanceDir, type ApprovalCap } from "./linked-servers-store.ts";
import { farFrame } from "./linked-servers-text.ts";

const WORDS = { handedTo: "Handed to the A2A agent.", otherSide: "the A2A agent" };
const FAIL_TEXT = "The work could not be done on the other side.";
const REMOVED = "This work stopped because the link to the A2A agent was removed.";
const CALLS_OFF = "This work stopped because the A2A agent can no longer call this Seira.";
export const FULL_HERE = "This Seira already has as many links as it can keep. Remove one first.";
const NO_NAME = "Give the A2A agent a name.";
const NO_WAY = "Give the address of the A2A agent, let it call this Seira, or both.";
const TOKEN_ALONE = "A token is for an A2A agent that this Seira calls. Give its address too.";
const BAD_TOKEN = "That token cannot be sent. Paste it again, with no spaces.";
const NO_ADDRESS = "The A2A agent cannot reach this Seira. Give this Seira a secure public address first.";
/** What a far agent's token may hold: one header value of visible ASCII. */
const OUTBOUND_TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const EXPOSED_MAX = 500;

/** A change an admin asked for that was not made, with a message the person can read. */
export class LinkedServerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LinkedServerError";
    this.status = status;
  }
}

export interface A2aPeerView {
  id: string;
  kind: "a2a";
  /** The name an admin gave the agent here. */
  name: string;
  /** `offline`: this server calls the agent and cannot use it now; `problem` says why. */
  state: "online" | "offline" | "ended";
  /** This server's bots the agent can call. */
  exposed: string[];
  cap: ApprovalCap;
  /** The agent as a teammate here, by its address here, once its card was read. */
  bots: Array<{ id: string; name: string; description?: string }>;
  createdAt: number;
  /** This server calls the agent at `url`. Null: it does not call it. */
  outbound: { url: string; hasToken: boolean } | null;
  /** The agent calls this server: the card address of each exposed bot. Null: it does not call in. */
  inbound: { urls: CardUrl[] } | null;
  /** Why this server cannot call the agent now, in words for the admin. */
  problem: string | null;
}

export type CardUrl = { bot: string; url: string };

export interface A2aInput { name: string; url?: string; token?: string; inbound: boolean; exposed?: string[]; cap?: ApprovalCap }

/** `url` or `token` null: no more. `inbound` false: the agent can no longer call in; a new token lets it again. */
export interface A2aPatch { exposed?: string[]; cap?: ApprovalCap; name?: string; url?: string | null; token?: string | null; inbound?: false }

export interface LinkedA2aDeps {
  dataDir: string;
  now: () => number;
  log: (line: string) => void;
  audit(row: Omit<AdminActionRow, "at">): void;
  coordinator(): Pick<Coordinator, "children">;
  bot(id: string): InboundBot | null | undefined;
  /** A guest link in `dataDir` under `policy`, whose turns run at no more than `cap`. Files do not cross it. */
  link(dataDir: string, policy: LinkPolicy, cap: () => ApprovalCap): BotLink;
  /** The link counts with the other links here, for their bots, the chain rule and the caps, until `unregister`. */
  register(id: string, key: string, link: BotLink, cap: () => ApprovalCap): void;
  unregister(id: string): void;
  admit(id: string, open: number): string | null;
  /** One crossing for the activity record. */
  record(id: string, who: { target: NonNullable<AdminActionRow["target"]>; actor: LinkedServerActor }, event: LinkEvent): void;
  /** The work the link's peer started here stops, with all that bots here took on from it. */
  stopWork(link: BotLink, key: string, reason: string): void;
  /** The roots of the open work each link's peer started here, by the link's key. */
  openRoots(): Map<string, string[]>;
  cancelUnder(rootId: string, reason: string): void;
  /** A new id that no link of either kind uses, and whose key, as `keyOf` makes it, no link uses. */
  freshId(keyOf: (id: string) => string): string;
  /** The links to other Seiras here. With the A2A peers, they share LINKS_MAX. */
  seiraLinks(): number;
  /** The link's admission and refusal records go. */
  forget(id: string): void;
  self(): Place;
  /** The address A2A agents reach this server at, or null when it has none. */
  origin(): string | null;
  attemptAllowed(source: string): boolean;
  attemptFailed(source: string): void;
  /** Tests only: an agent on this machine's loopback, at http. */
  allowLoopback?: boolean;
  egress?: EgressDeps;
  holdMs?: number;
}

type Sides = { id: string; key: string; link: BotLink; place: Place; tasks: TaskIndex };
type Runtime = Sides & { inbound: A2aInbound; outbound: A2aOutbound; transport: A2aTransport; gone: boolean };

export const a2aKey = (id: string): string => peerKey(`a2a:${id}`);
const originOf = (id: string) => `a2a:${id}`;

/** What the far agent says, and what its calls start, as the link takes it in: the one path every far text takes. */
const taking = (link: BotLink): Pick<BotLink, "receive" | "has" | "ownsRoot"> => ({
  receive: (peer, raw) => { link.receive(peer, raw.map(farFrame)); },
  has: (peer) => link.has(peer),
  ownsRoot: (rootId) => link.ownsRoot(rootId),
});

const exposedOf = (ids: readonly string[]): string[] => [...new Set(ids.filter((one) => botIdSchema.safeParse(one).success))].slice(0, EXPOSED_MAX);

export type LinkedA2a = ReturnType<typeof createLinkedA2a>;

export function createLinkedA2a(deps: LinkedA2aDeps) {
  const { now, log } = deps;
  const allowLoopback = deps.allowLoopback === true;
  const egress = deps.egress ?? { allowLoopback };
  const file = readA2aPeers(deps.dataDir, log);
  const runtimes = new Map<string, Runtime>();
  const frames = createFrameBudget(now, ADMIT.frames);

  const save = () => writeA2aPeers(deps.dataDir, file);
  const recordOf = (id: string) => file.peers.find((one) => one.id === id);
  const capOf = (id: string): ApprovalCap => recordOf(id)?.cap ?? "ask";
  const urlOf = (peer: A2aPeer) => (peer.url ? outboundUrl(peer.url, allowLoopback) : null);
  const targetOf = (peer: A2aPeer) => ({ kind: "a2a-peer", id: peer.id, name: peer.name });
  const actorOf = (peer: A2aPeer): LinkedServerActor => ({ kind: "linked-server", linkId: peer.id, name: peer.name, a2a: true });
  const origin = () => { const raw = deps.origin(); return raw ? guestOrigin(raw) : null; };
  const full = () => deps.seiraLinks() + file.peers.length >= LINKS_MAX;
  const outboundToken = (rt: Runtime) => rt.link.dial()?.token ?? "";

  function cardUrls(peer: A2aPeer): CardUrl[] {
    const base = origin();
    return peer.tokenHash && base ? peer.exposed.map((bot) => ({ bot, url: `${base}${A2A_PREFIX}${bot}${ROOT_CARD_PATH}` })) : [];
  }

  function policyOf(id: string, key: string): LinkPolicy {
    return {
      key,
      exposed: (botId) => recordOf(id)?.exposed.includes(botId) === true,
      admit: (_peer, open) => deps.admit(id, open),
      failText: () => FAIL_TEXT,
      words: WORDS,
      record: (event) => { const peer = recordOf(id); if (peer) deps.record(id, { target: targetOf(peer), actor: actorOf(peer) }, event); },
    };
  }

  function inboundOf(rt: Sides): A2aInbound {
    return createA2aInbound({
      link: taking(rt.link), key: rt.key,
      peerName: () => recordOf(rt.id)?.name ?? "",
      exposed: (botId) => recordOf(rt.id)?.exposed.includes(botId) === true,
      bot: deps.bot,
      endpoint: (botId) => `${origin() ?? ""}${A2A_PREFIX}${botId}`,
      coordinator: deps.coordinator, tasks: rt.tasks,
      frames: { left: () => frames.left(rt.key), spend: (count) => { frames.spend(rt.key, count); } },
      failText: FAIL_TEXT, now, ...(deps.holdMs ? { holdMs: deps.holdMs } : {}),
    });
  }

  function outboundOf(rt: Sides): A2aOutbound {
    return createA2aOutbound({
      link: taking(rt.link), key: rt.key, place: rt.place,
      url: () => { const peer = recordOf(rt.id); return peer ? urlOf(peer) : null; },
      token: () => rt.link.dial()?.token ?? null,
      tasks: rt.tasks, egress, now, log,
    });
  }

  /** The peer's runtime, registered with the other links. Its link is not turned on here: that may kick the coordinator. */
  function open(peer: A2aPeer): Runtime {
    const { id } = peer, key = a2aKey(id), dir = instanceDir(deps.dataDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const link = deps.link(dir, policyOf(id, key), () => capOf(id));
    const index = createTaskIndex(dir, now, log);
    const tasks: TaskIndex = {
      ...index,
      put: (entry) => { if (!rt.gone) index.put(entry); },
      remove: (taskId) => { if (!rt.gone) index.remove(taskId); },
      setContext: (thread, far, inputTask) => { if (!rt.gone) index.setContext(thread, far, inputTask); },
    };
    const sides: Sides = { id, key, link, place: { id: originOf(id), name: peer.name }, tasks };
    const rt: Runtime = {
      ...sides, inbound: inboundOf(sides), outbound: outboundOf(sides), gone: false,
      transport: createA2aTransport({
        link, key, log,
        inbound: { settled: (taskId, frame) => { rt.inbound.settled(taskId, frame); }, close: () => { rt.inbound.close(); } },
        outbound: { send: (frame) => { rt.outbound.send(frame); }, cancel: (taskId) => { rt.outbound.cancel(taskId); }, close: () => { rt.outbound.close(); } },
      }),
    };
    runtimes.set(id, rt);
    deps.register(id, key, link, () => capOf(id));
    return rt;
  }

  function turnOn(rt: Runtime, token: string): void {
    rt.link.turnOn({ self: deps.self(), origin: originOf(rt.id), token, peer: { ...rt.place } });
  }

  /** The far agent's JSON-RPC address, kept once its card named it. */
  function noteEndpoint(id: string): void {
    const rt = runtimes.get(id), peer = recordOf(id);
    if (!rt || !peer?.url) return;
    const found = rt.outbound.endpoint();
    const kept = found && outboundUrl(found, true)?.href === found && new URL(found).origin === new URL(peer.url).origin ? found : undefined;
    if (kept === peer.endpoint) return;
    if (kept) peer.endpoint = kept;
    else delete peer.endpoint;
    save();
  }

  /** The peer is online on its link, and its agent's card is read. */
  function go(rt: Runtime): void {
    rt.transport.start();
    void rt.outbound.connect().then(() => { noteEndpoint(rt.id); });
  }

  /** The inbound side starts again: calls held on the old one end, and a token it took is checked again. */
  function freshInbound(rt: Runtime): void {
    const old = rt.inbound;
    rt.inbound = inboundOf(rt);
    old.close();
  }

  function view(peer: A2aPeer): A2aPeerView {
    const rt = runtimes.get(peer.id);
    const live = Boolean(rt?.link.has(rt.key));
    const problem = !peer.url ? null : urlOf(peer) ? rt?.outbound.problem() ?? null : PROBLEM.address;
    const bots = rt && live ? rt.link.linked().filter((one) => one.peer === rt.key).map(({ id, bot }) => {
      const description = cleanName(bot.description ?? "", 400);
      return { id, name: cleanName(bot.name) || bot.id, ...(description ? { description } : {}) };
    }) : [];
    return {
      id: peer.id, kind: "a2a", name: peer.name, state: !live ? "ended" : problem ? "offline" : "online",
      exposed: [...peer.exposed], cap: peer.cap, bots, createdAt: peer.createdAt,
      outbound: peer.url ? { url: peer.url, hasToken: rt ? outboundToken(rt) !== "" : false } : null,
      inbound: peer.tokenHash ? { urls: cardUrls(peer) } : null,
      problem,
    };
  }

  const gate: A2aGate = {
    peerFor: (token) => { const peer = peerByToken(file, token); return peer ? runtimes.get(peer.id)?.inbound : undefined; },
    attemptAllowed: (source) => deps.attemptAllowed(source),
    attemptFailed: (source) => { deps.attemptFailed(source); },
  };

  for (const peer of file.peers) open(peer);

  return {
    gate,
    has: (id: string): boolean => recordOf(id) !== undefined,
    ids: (): string[] => file.peers.map((one) => one.id),
    count: (): number => file.peers.length,
    list: (): A2aPeerView[] => file.peers.map(view),
    /** Removed peers whose work here may still run. */
    ended: (): readonly EndedPeer[] => file.ended ?? [],

    /** Throws a LinkedServerError whose message the person can read. The inbound token is in the answer only. */
    add(input: A2aInput, actor: AdminActor): { server: A2aPeerView; token?: string; urls: CardUrl[] } {
      const name = cleanName(input.name, PEER_NAME_MAX);
      if (!name) throw new LinkedServerError(NO_NAME, 400);
      const asked = input.url?.trim() ?? "";
      const url = asked ? outboundUrl(asked, allowLoopback) : null;
      if (asked && !url) throw new LinkedServerError(PROBLEM.address, 400);
      if (!url && !input.inbound) throw new LinkedServerError(NO_WAY, 400);
      if (input.token !== undefined && !url) throw new LinkedServerError(TOKEN_ALONE, 400);
      if (input.token !== undefined && !OUTBOUND_TOKEN.test(input.token)) throw new LinkedServerError(BAD_TOKEN, 400);
      if (full()) throw new LinkedServerError(FULL_HERE, 409);
      if (input.inbound && !origin()) throw new LinkedServerError(NO_ADDRESS, 409);
      const made = input.inbound ? newA2aToken() : null;
      const peer: A2aPeer = { id: deps.freshId(a2aKey), name, ...(url ? { url: url.href } : {}), ...(made ? { tokenHash: made.hash } : {}),
        exposed: exposedOf(input.exposed ?? []), cap: input.cap ?? "ask", createdAt: now() };
      file.peers.push(peer);
      save();
      const rt = open(peer);
      turnOn(rt, input.token ?? "");
      go(rt);
      deps.audit({ category: "linked-server", action: "linked-server.a2a-add", target: targetOf(peer), actor,
        changed: ["name", ...(url ? ["url"] : []), ...(input.token !== undefined ? ["outboundToken"] : []), ...(made ? ["inboundToken"] : []), "exposed", "cap"],
        after: { exposed: peer.exposed, cap: peer.cap } });
      return { server: view(peer), ...(made ? { token: made.token } : {}), urls: cardUrls(peer) };
    },

    /** Null: no such peer. Throws a LinkedServerError whose message the person can read. */
    change(id: string, patch: A2aPatch, actor: AdminActor): A2aPeerView | null {
      const peer = recordOf(id), rt = runtimes.get(id);
      if (!peer || !rt) return null;
      const next: A2aPeer = { ...peer };
      const changed: string[] = [], before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
      if (patch.name !== undefined) {
        const name = cleanName(patch.name, PEER_NAME_MAX);
        if (!name) throw new LinkedServerError(NO_NAME, 400);
        if (name !== peer.name) { changed.push("name"); before.name = peer.name; after.name = name; next.name = name; }
      }
      if (patch.url !== undefined) {
        const asked = patch.url?.trim() ?? "";
        const url = asked ? outboundUrl(asked, allowLoopback) : null;
        if (asked && !url) throw new LinkedServerError(PROBLEM.address, 400);
        if (url?.href !== peer.url) {
          changed.push("url");
          delete next.endpoint;
          if (url) next.url = url.href;
          else delete next.url;
        }
      }
      if (patch.inbound === false && peer.tokenHash) { changed.push("inboundToken"); delete next.tokenHash; }
      if (!next.url && !next.tokenHash) throw new LinkedServerError(NO_WAY, 400);
      let token = outboundToken(rt);
      if (typeof patch.token === "string") {
        if (!next.url) throw new LinkedServerError(TOKEN_ALONE, 400);
        if (!OUTBOUND_TOKEN.test(patch.token)) throw new LinkedServerError(BAD_TOKEN, 400);
        token = patch.token;
      } else if (patch.token === null || !next.url) token = "";
      if (token !== outboundToken(rt)) changed.push("outboundToken");
      if (patch.exposed) {
        const exposed = exposedOf(patch.exposed);
        if (JSON.stringify(exposed) !== JSON.stringify(peer.exposed)) { changed.push("exposed"); before.exposed = peer.exposed; after.exposed = exposed; next.exposed = exposed; }
      }
      if (patch.cap && patch.cap !== peer.cap) { changed.push("cap"); before.cap = peer.cap; after.cap = patch.cap; next.cap = patch.cap; }
      if (changed.length === 0) return view(peer);
      file.peers = file.peers.map((one) => (one.id === id ? next : one));
      save();
      if (changed.includes("inboundToken")) { freshInbound(rt); deps.stopWork(rt.link, rt.key, CALLS_OFF); }
      if (changed.includes("name")) rt.place.name = next.name;
      if (changed.includes("name") || changed.includes("outboundToken")) turnOn(rt, token);
      if (changed.includes("url")) { rt.outbound.close(); rt.outbound = outboundOf(rt); }
      if (changed.includes("exposed") || changed.includes("cap")) rt.link.botsChanged();
      if (changed.some((one) => one === "name" || one === "url" || one === "outboundToken")) go(rt);
      deps.audit({ category: "linked-server", action: "linked-server.update", target: targetOf(next), changed, before, after, actor });
      return view(next);
    },

    /** A new inbound token for the peer, which turns its calls on when they were off. The old token stops at once. */
    rotate(id: string, actor: AdminActor): { server: A2aPeerView; token: string; urls: CardUrl[] } | null {
      const peer = recordOf(id), rt = runtimes.get(id);
      if (!peer || !rt) return null;
      if (!origin()) throw new LinkedServerError(NO_ADDRESS, 409);
      const made = newA2aToken();
      peer.tokenHash = made.hash;
      save();
      freshInbound(rt);
      deps.audit({ category: "linked-server", action: "linked-server.token-rotate", target: targetOf(peer), changed: ["inboundToken"], actor });
      return { server: view(peer), token: made.token, urls: cardUrls(peer) };
    },

    /** The record, the folder and both tokens go. The inbound token is refused at once, and the peer's work stops. */
    remove(id: string, actor: AdminActor): boolean {
      const peer = recordOf(id);
      if (!peer) return false;
      const rt = runtimes.get(id), key = a2aKey(id);
      if (rt) {
        rt.gone = true;
        rt.inbound.close();
        deps.stopWork(rt.link, key, REMOVED);
        rt.link.turnOff(true);
      }
      file.peers = file.peers.filter((one) => one.id !== id);
      const ended = (file.ended ?? []).filter((one) => one.key !== key);
      file.ended = deps.openRoots().has(key) ? [...ended, { key, cap: peer.cap, at: now() }].slice(-ENDED_MAX) : ended;
      save();
      if (rt) { rt.transport.close(); rt.link.close(); }
      runtimes.delete(id);
      deps.unregister(id);
      deps.forget(id);
      frames.forget(key);
      rmSync(instanceDir(deps.dataDir, id), { recursive: true, force: true });
      deps.audit({ category: "linked-server", action: "linked-server.remove", target: targetOf(peer), actor });
      return true;
    },

    /** Work of a removed peer that is still open is stopped again. A removed peer with no open work is forgotten. */
    settle(roots: Map<string, string[]>): void {
      if (!file.ended?.length) return;
      for (const one of file.ended) for (const rootId of roots.get(one.key) ?? []) deps.cancelUnder(rootId, REMOVED);
      const kept = file.ended.filter((one) => roots.has(one.key));
      if (kept.length === file.ended.length) return;
      file.ended = kept;
      save();
    },

    /** Once the server is up: each peer's link is on, it is online, and its agent's card is read. */
    start(): void {
      for (const rt of runtimes.values()) {
        if (!rt.link.has(rt.key)) turnOn(rt, "");
        go(rt);
      }
    },

    tidy(): void { for (const rt of runtimes.values()) rt.tasks.prune(); },

    close(): void {
      for (const rt of runtimes.values()) { rt.transport.close(); rt.link.close(); deps.unregister(rt.id); }
      runtimes.clear();
    },
  };
}
