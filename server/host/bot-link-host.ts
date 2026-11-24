// index.ts's wiring of the link between a person's computer and their Cloud (server/bot-link/link.ts) and of the links to
// servers of other owners (server/host/linked-servers.ts): the links over this server's store and coordinator, the
// computer's end that asks the Cloud, and the routes. With the person's link off (no bot-link.json in the data folder)
// and no linked server, `start` asks nobody and every hook here answers as if no link existed.
import type { IncomingMessage } from "node:http";

import type { AdminActionRow, AdminActor } from "../admin-activity.ts";
import { createDialer } from "../bot-link/dial.ts";
import { createBotLink, type CoordinateContext } from "../bot-link/link.ts";
import { isLinkedId } from "../bot-link/protocol.ts";
import type { CoordinateBotsCall, Coordinator, CoordinatorHost } from "../coordinator.ts";
import type { PeerDeliveryReceipt } from "../peer-delivery.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBotLinkRoutes, linkSessionUser } from "../routes/bot-link.ts";
import { createLinkedServerRoutes } from "../routes/linked-servers.ts";
import { PASS, dispatchRoutes, type RouteHandler } from "../routes/table.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { mascotAccessories } from "../../shared/mascot-accessories.ts";
import type { BotRecord, Store } from "../store.ts";
import { botLinkDeps, type BotLinkStoreDeps } from "./bot-link-deps.ts";
import { createLinkedRooms, type LinkedRoomsDeps } from "./bot-link-rooms.ts";
import type { HandoffFiles } from "./handoff-files.ts";
import { CHAINED, createLinkedServers, type GuestRequest } from "./linked-servers.ts";

export interface BotLinkHostDeps extends Omit<BotLinkStoreDeps, "store" | "files"> {
  dataDir: string;
  environmentId: string;
  store: Pick<Store, "bots" | "bot" | "standIns" | "createTask" | "taskByThread" | "appendMessage" | "patchTask" | "onChange" | "group" | "groups" | "groupTaskByThread" | "markGroupThreadUnread" | "activePath" | "messagesFor" | "patchGroup">;
  /** A room line in the language of its thread, and what follows a member's answer (its mentions take their turns). */
  roomLine: LinkedRoomsDeps["line"];
  roomFollow?: LinkedRoomsDeps["follow"];
  /** The room's lines as a member reads them, and who stands behind a room thread's words when it is not the person. */
  roomWindow: LinkedRoomsDeps["window"];
  roomOpener?: LinkedRoomsDeps["opener"];
  /** A room's far members can be reached now, or no longer can: the app hears the room again. */
  roomChanged?(groupId: string): void;
  coordinator(): Coordinator;
  kick(): void;
  sessions: {
    issue(input: { label: string; scopes: Array<"admin" | "client">; email?: string; userId?: string }): { token: string; session: { id: string } };
    revoke(id: string): boolean;
    /** Whether this caller may try a code now, and a wrong code it tried. */
    attemptAllowed(source: string): { ok: boolean };
    noteFailure(source: string): void;
  };
  local(auth: RequestAuth): boolean;
  owner(auth: RequestAuth): boolean;
  power(): { sleeping(): boolean; sleepSignal(): AbortSignal } | null | undefined;
  files: Pick<HandoffFiles, "carried" | "crossed" | "sentWith" | "returnedWith" | "drop">;
  /** The name other servers know this server by. */
  serverName(): string;
  /** The secure public address other servers reach this server at, or null when it has none. */
  publicOrigin(): string | null;
  audit(row: Omit<AdminActionRow, "at">): void;
  /** Who made an admin request, for the activity record. */
  actor(auth: RequestAuth, req: IncomingMessage): AdminActor;
  log(line: string): void;
}

type Answer = { status: number; body: Record<string, unknown> };
type Local = (call: CoordinateBotsCall) => Promise<Answer>;

export function createBotLinkHost(deps: BotLinkHostDeps) {
  const { store } = deps;
  const shared = botLinkDeps(deps);
  /** Each bot of each linked place as a record this place finds by its address: its name and look, and where it lives.
   * It has no conversation, model or tools here, and takes no turn here. */
  const syncStandIns = () => {
    const next = new Map<string, BotRecord>();
    for (const { id, peer, place, kind, bot } of link.linked()) {
      next.set(id, { id, name: bot.name, color: bot.color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: bot.model ?? "" },
        home: { place: peer, placeName: place.name, botId: bot.id, kind }, ...(bot.title ? { title: bot.title } : {}), ...(bot.description ? { description: bot.description } : {}),
        ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}), ...(bot.mascotFaceColor ? { mascotFaceColor: bot.mascotFaceColor } : {}),
        ...(mascotAccessories(bot.mascotAccessories).length ? { mascotAccessories: mascotAccessories(bot.mascotAccessories) } : {}) } as unknown as BotRecord);
    }
    // A far member of a room here that cannot be reached now (the link is off, its place is unlinked, or its place no
    // longer has it) stays a member: it is found by its address, named as it was last known, and takes no turn.
    rooms.sync();
    for (const { id, gone, name, color, place, placeName, botId, kind, title, mascotBody, mascotFaceColor, mascotAccessories: worn } of rooms.absent()) {
      next.set(id, { id, name, color: color ?? "blue", threadId: "", tasks: [], resumeCursors: {}, modelSelection: { instanceId: "", model: "" },
        home: { place, placeName, botId, ...(kind ? { kind } : {}), gone }, ...(title ? { title } : {}), ...(mascotBody ? { mascotBody } : {}), ...(mascotFaceColor ? { mascotFaceColor } : {}),
        ...(worn?.length ? { mascotAccessories: worn } : {}) } as unknown as BotRecord);
    }
    store.standIns.clear();
    for (const [id, record] of next) if (isLinkedId(id)) store.standIns.set(id, record);
    for (const group of store.groups) {
      const far = group.dm || !group.memberIds.some(isLinkedId) ? "" : JSON.stringify(rooms.far(group));
      if ((farTold.get(group.id) ?? "") === far) continue;
      if (far) farTold.set(group.id, far); else farTold.delete(group.id);
      deps.roomChanged?.(group.id);
    }
  };
  /** What the app was last told of each room's far members. */
  const farTold = new Map<string, string>();
  const rooms = createLinkedRooms({ dataDir: deps.dataDir, store, coordinator: deps.coordinator, on: () => link.on(), linked: (peer) => link.has(peer), online: (peer) => link.online(peer), linkedBots: () => link.linked(), selfName: () => link.selfName(), wanted: () => link.wanted(),
    personName: deps.personName, line: deps.roomLine, window: deps.roomWindow, log: deps.log, ...(deps.roomOpener ? { opener: deps.roomOpener } : {}), ...(deps.roomFollow ? { follow: deps.roomFollow } : {}) });
  const link = createBotLink({
    ...shared, dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, rooms, directoryChanged: () => { syncStandIns(); }, revoke: (sessionId) => { deps.sessions.revoke(sessionId); },
    notMine: (botId) => linked.instances().some((one) => one.link.claims(botId)),
  });
  const linked = createLinkedServers({
    ...shared, dataDir: deps.dataDir, coordinator: deps.coordinator, kick: deps.kick, log: deps.log, power: deps.power,
    dropFiles: (paths) => deps.files.drop(paths),
    serverName: deps.serverName, selfId: () => deps.environmentId, publicOrigin: deps.publicOrigin, audit: deps.audit,
    attemptAllowed: (source) => deps.sessions.attemptAllowed(source).ok, attemptFailed: (source) => { deps.sessions.noteFailure(source); },
    ownPeer: (key) => link.has(key),
  });
  const dialer = createDialer({ link, log: deps.log });
  let stopWatching: (() => void) | undefined, stopWatchingGuests: (() => void) | undefined, upkeep: NodeJS.Timeout | undefined;
  /** While the link is on: bot changes reach the other places, and old records and stray file bytes are cleared hourly. */
  const watch = () => {
    stopWatching ??= store.onChange((change) => { if (change.type.startsWith("bot.")) link.botsChanged(); });
    watchRooms();
    if (upkeep) return;
    upkeep = setInterval(() => link.tidy(), 60 * 60_000);
    upkeep.unref?.();
  };
  /** A room's members changed: a far member is remembered by name for when its place cannot be asked, and one the person
   * removed is forgotten. Watched while the link is on, or while a room still has a far member. */
  let stopWatchingRooms: (() => void) | undefined;
  const watchRooms = () => { stopWatchingRooms ??= store.onChange((change) => { if (change.type === "group" && (store.standIns.size > 0 || rooms.any())) syncStandIns(); }); };
  const ownRoutes = createBotLinkRoutes({ link, dialer, turnedOn: watch, environmentId: deps.environmentId, local: deps.local, owner: deps.owner, power: deps.power,
    // A personal Cloud issues no session without its owner's scopes, so the link's carries them; `linkSessionRefusal`
    // (wired where requests are admitted) keeps it to the link's own routes.
    issue: (auth, label, computerId) => {
      const issued = deps.sessions.issue({ label, scopes: [...auth.scopes], userId: linkSessionUser(computerId), ...(auth.kind === "session" && auth.session.email ? { email: auth.session.email } : {}) });
      return { token: issued.token, sessionId: issued.session.id };
    },
    revoke: (sessionId) => { deps.sessions.revoke(sessionId); } });
  const adminRoutes = createLinkedServerRoutes({ manager: linked, knownBot: (id) => store.bots.some((bot) => bot.id === id), actor: deps.actor });
  const routes: RouteHandler = async (ctx) => (await dispatchRoutes([ownRoutes, adminRoutes], ctx) ? undefined : PASS);

  /** Work a linked server started: a target of any other server is refused, and the rest goes on here. */
  async function keepHere(call: CoordinateBotsCall, local: Local): Promise<Answer> {
    const away = call.botIds.filter((raw) => isLinkedId(raw.trim()) || link.resolve(raw) !== undefined);
    if (away.length === 0) return local(call);
    const refused = away.map((botId): PeerDeliveryReceipt => ({ botId, outcome: "failed", detail: CHAINED }));
    const here = call.botIds.filter((raw) => !away.includes(raw));
    if (here.length === 0) return { status: 409, body: { receipts: refused, error: CHAINED } };
    const rest = await local({ ...call, botIds: here });
    const receipts = [...refused, ...(Array.isArray(rest.body.receipts) ? rest.body.receipts as PeerDeliveryReceipt[] : [])];
    const said = (other: unknown) => [CHAINED, ...(typeof other === "string" && other ? [other] : [])].join("; ");
    return rest.status === 200
      ? { status: 200, body: { ...rest.body, receipts, notSent: said(rest.body.notSent) } }
      : { status: rest.status, body: { ...rest.body, receipts, error: said(rest.body.error) } };
  }

  const facade = {
    ...link,
    /** The coordinator's host with the bots of the person's other places and of every linked server in it. */
    host: (inner: CoordinatorHost): CoordinatorHost => linked.host(link.host(inner)),
    /** coordinate_bots: the person's other places take their targets, then each linked server, then this server. */
    async coordinate(call: CoordinateBotsCall, context: CoordinateContext, local: Local): Promise<Answer> {
      const parent = deps.coordinator().node(context.parentId ?? context.generation);
      if (parent && linked.started(parent.rootId)) return keepHere(call, local);
      const guests = linked.instances().reduceRight<Local>((next, one) => (rest) => one.link.coordinate(rest, context, next), local);
      return link.coordinate(call, context, guests);
    },
    agents: () => [...link.agents(), ...linked.instances().flatMap((one) => one.link.agents())],
    /** Requests before sign-in that only a linked server makes. False: not one of them. */
    publicRoutes: (ctx: GuestRequest): Promise<boolean> => linked.serve(ctx),
    capFor: (threadId: string, mode: ApprovalMode): ApprovalMode => linked.capFor(threadId, mode),
  };

  return {
    link: facade, routes, rooms, linked,
    /** Once the server is up. Off: nothing. On, on the computer: it starts asking the Cloud. */
    start(): void {
      linked.start();
      stopWatchingGuests ??= store.onChange((change) => { if (change.type.startsWith("bot.")) for (const one of linked.instances()) one.link.botsChanged(); });
      // Off: nothing, unless a room here still has a member from another place, which is then found and shown as away.
      if (!link.on()) { if (rooms.any()) { syncStandIns(); watchRooms(); } return; }
      syncStandIns();
      watch();
      link.tidy();
      if (link.role() === "dialer") dialer.start({ gentle: true });
    },
    close(): void { if (upkeep) clearInterval(upkeep); stopWatching?.(); stopWatchingGuests?.(); stopWatchingRooms?.(); dialer.close(); link.close(); linked.close(); },
  };
}
