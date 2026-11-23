// What a link through Seira Relay keeps apart from links.json: <data>/linked-servers/relay.json, mode 600. It names the
// relay invites that are open, the links this server hosts over the relay, and the relay route of each link it joined.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { admission, admissionHash, credentialHash, credentialHashFromHex, keyId, psk } from "../../companion/src/e2e/credentials.ts";
import { parseDescriptor, type E2EDescriptor } from "../../companion/src/e2e/descriptor.ts";
import { TRANSPORT_RELAY } from "../../companion/src/e2e/noise.ts";
import type { E2EOriginDeadlines } from "../../companion/src/e2e/origin.ts";
import { dial } from "../../companion/src/e2e/phone.ts";
import type { Peer } from "../../companion/src/e2e/registry.ts";
import { SessionClosed, type E2ESession } from "../../companion/src/e2e/session.ts";
import { fetchOverSession } from "../bot-link/relay-fetch.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { LINK_ID, linkedServersDir } from "./linked-servers-store.ts";

/** Links that others joined over the relay at one time. */
export const RELAY_LINKS_MAX = 4;
/** Invites for a relay link that wait to be used at one time. */
export const RELAY_INVITES_MAX = 2;
/** The start of the device id under which the relay admits a link. */
export const LINK_DEVICE_PREFIX = "link:";

const FILE = "relay.json";
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const route = z.object({ v: z.literal(1), k: z.string().max(200), h: z.string().max(64), r: z.array(z.string().max(64)).min(1).max(4) }).strict()
  .refine((descriptor) => { const parsed = parseDescriptor(descriptor); return parsed.outcome === "ok" && parsed.hostId !== null; });
const fileSchema = z.object({
  v: z.literal(1),
  invites: z.array(hex64).max(RELAY_INVITES_MAX),
  hosted: z.array(z.string().regex(LINK_ID)).max(RELAY_LINKS_MAX),
  joined: z.record(z.string().regex(LINK_ID), route),
}).strict();

export type RelayLinksFile = z.infer<typeof fileSchema>;

const empty = (): RelayLinksFile => ({ v: 1, invites: [], hosted: [], joined: {} });

/** The address that stands in for the far server of a relay link. Nothing resolves or dials it. */
export const placeholderOrigin = (hostId: Buffer): string => `https://h-${hostId.toString("hex")}.e2e.invalid`;

/** A file that is missing is empty. A file that does not parse is empty too, and says so once. */
export function readRelayLinks(dataDir: string, log: (line: string) => void = () => {}): RelayLinksFile {
  let text: string;
  try { text = readFileSync(join(linkedServersDir(dataDir), FILE), "utf8"); } catch { return empty(); }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch { /* reported below */ }
  log("linked servers: their relay record did not parse, so no relay link is in use");
  return empty();
}

export function writeRelayLinks(dataDir: string, file: RelayLinksFile): void {
  ensurePrivateDir(linkedServersDir(dataDir));
  writeFileAtomic(join(linkedServersDir(dataDir), FILE), JSON.stringify(fileSchema.parse(file)), { mode: 0o600 });
}

/** A link may carry a file for ten minutes, twice the time a phone request gets. */
export const LINK_DEADLINES: E2EOriginDeadlines = { headersMs: 30_000, requestMs: 600_000 };

export interface RelayRoute {
  e2e: E2EDescriptor;
  transportKey: Buffer;
  hostId: Buffer;
}

export interface RelayDialOptions {
  /** Tests: dial this address for every node instead of `wss://<node>`. */
  baseUrl?: string | null;
  app: string;
  dial?: typeof dial;
  timeoutMs?: number;
}

/** What the relay or the far server answered that no other node can change. */
const STOPS = new Set([4000, 4001, 4429]);

/** Opens one session to the far server with `credential`, trying the relay nodes in the order the route names them. Every
 * node that answers 4404 gives "not connected here, or not admitted": the next node is tried, and only when all of them
 * said so does the call reject with 4404. A pin mismatch, a rejected handshake and a rate limit stop at once. */
export async function openRelaySession(route: RelayRoute, credential: string, options: RelayDialOptions): Promise<E2ESession<never>> {
  const hash = credentialHash(credential);
  const connect = options.dial ?? dial;
  const nodes = route.e2e.r ?? [];
  let failure: unknown = new SessionClosed(4404);
  let refused = 0;
  for (const node of nodes) {
    try {
      return await connect({
        url: `${options.baseUrl ?? `wss://${node}`}/v1/phone`,
        transportByte: TRANSPORT_RELAY,
        remoteStatic: route.transportKey,
        psk: psk(hash, keyId(route.transportKey)),
        app: options.app,
        relay: { hostId: route.hostId, adm: admission(hash, route.hostId) },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (error) {
      failure = error;
      if (!(error instanceof SessionClosed)) throw error;
      if (error.code === 4404) refused += 1;
      if (STOPS.has(error.code)) throw error;
    }
  }
  throw refused > 0 && refused === nodes.length ? new SessionClosed(4404) : failure;
}

export interface RelayLinkFetch {
  fetch: typeof fetch;
  /** True only while a session is open. */
  online(): boolean;
  /** Closes the session. Later calls reject and dial nothing. */
  close(): void;
}

export interface RelayLinkFetchOptions extends RelayDialOptions {
  /** Security: the far server said inside the session that it dropped this link. Called once. A close code alone never
   * ends a link, because the relay can write any close code: 4404 also means that the far server is off. */
  removed(): void;
}

/** The `fetch` of one relay link: it dials on the first call, keeps one session, dials again once that session closed, and
 * lets calls that arrive during a dial share it. It never resolves or dials the link's placeholder origin. */
export function createRelayLinkFetch(route: RelayRoute, credential: () => string | null, options: RelayLinkFetchOptions): RelayLinkFetch {
  let session: E2ESession<never> | null = null;
  let dialing: Promise<E2ESession<never>> | null = null;
  let shut = false;
  let dropped = false;

  const drop = (): void => {
    if (dropped) return;
    dropped = true;
    session?.shutdown();
    options.removed();
  };

  const open = (): Promise<E2ESession<never>> => {
    if (shut) return Promise.reject(new Error("this link is closed"));
    if (dropped) return Promise.reject(new Error("the other server removed this link"));
    if (session?.state === "open") return Promise.resolve(session);
    if (dialing) return dialing;
    const secret = credential();
    if (!secret) return Promise.reject(new Error("this link has no credential"));
    const attempt = openRelaySession(route, secret, options).then((opened) => {
      if (shut || dropped) {
        opened.shutdown();
        throw new Error("this link is closed");
      }
      session = opened;
      void opened.closed.then(() => {
        if (session === opened) session = null;
        if (opened.removed) drop();
      });
      return opened;
    });
    const settled = attempt.finally(() => { if (dialing === settled) dialing = null; });
    dialing = settled;
    return settled;
  };

  const linkFetch: typeof fetch = (input, init) => {
    const signal = init?.signal ?? undefined;
    const waiting = open();
    waiting.catch(() => {});
    if (!signal) return fetchOverSession(() => waiting)(input, init);
    return fetchOverSession(() => new Promise<E2ESession<never>>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    }))(input, init);
  };

  return {
    fetch: linkFetch,
    online: () => session?.state === "open",
    close() {
      shut = true;
      session?.shutdown();
      session = null;
    },
  };
}

/** What the phone relay asks of the link manager, and what the manager asks of the phone relay. */
export interface LinkRelayHost {
  /** The relay identity and key a joining server pins, or null until the relay is connected. */
  descriptor(): E2EDescriptor | null;
  /** Phones now, and links this server hosts over the relay now. */
  room(): { devices: number; links: number };
  /** The records or windows changed: tell the relay again who may reach this server. */
  changed(): void;
  /** Tells the far side that the link was removed, and closes its sessions. `id` is the link id without the prefix. */
  closeLink(id: string): void;
}

/** The link manager's side. `records` name the links by link id (the relay knows each as `LINK_DEVICE_PREFIX` plus that id)
 * with the hash of the credential the far side holds; `windows` are the invites that wait to be used. */
export interface LinkRelayGuests {
  attach(host: LinkRelayHost | null): void;
  records(): readonly { id: string; tokenHash: string }[];
  windows(): readonly { tokenHash: string }[];
  allows(kind: "link" | "invite", method: string, path: string): boolean;
}

/** Which guest a session belongs to: a link (its device) or a waiting invite (its pairing window), or neither. */
export function guestKind(peer: Peer, guests: LinkRelayGuests, hostId: Buffer): "link" | "invite" | null {
  if (peer.kind === "device") {
    return peer.id.startsWith(LINK_DEVICE_PREFIX) && guests.records().some((record) => `${LINK_DEVICE_PREFIX}${record.id}` === peer.id) ? "link" : null;
  }
  if (!peer.admHash) return null;
  const held = peer.admHash;
  return guests.windows().some((window) => {
    const hash = credentialHashFromHex(window.tokenHash);
    return hash !== null && admissionHash(admission(hash, hostId)) === held;
  }) ? "invite" : null;
}
