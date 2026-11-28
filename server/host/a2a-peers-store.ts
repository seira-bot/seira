// The record of this server's A2A peers: <data>/linked-servers/a2a-peers.json, mode 600. It keeps each peer's name, its
// address, what it may reach here, and only the sha256 of the token it sends. The token this server sends to a peer is
// never in this file. A field this version does not know is dropped on read, and the peer is kept.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { isPublicDomainAddress } from "../custom-domain.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { APPROVAL_CAPS, ENDED_MAX, LINKS_MAX, LINK_ID, botIdSchema, cleanName, hashSecret, linkedServersDir, sameHash } from "./linked-servers-store.ts";

export const A2A_TOKEN_PREFIX = "lsa_";
export const URL_MAX = 2_048;
export const PEER_NAME_MAX = 120;
const FILE = "a2a-peers.json";
const TOKEN = /^lsa_[A-Za-z0-9_-]{43}$/u;
const LOOPBACK_NAMES = new Set(["localhost", "[::1]"]);

const isLoopbackHost = (hostname: string): boolean => LOOPBACK_NAMES.has(hostname) || (isIP(hostname) === 4 && hostname.startsWith("127."));

/**
 * Security invariant: an A2A peer is called only at https, or at http on this machine's loopback while the test switch
 * is on. The address carries no user name or password, and an IP literal must be public. A host name is checked again
 * when it resolves, before each call. Null for any other address.
 */
export function outboundUrl(raw: string, allowLoopback: boolean): URL | null {
  if (raw.length > URL_MAX) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.username || url.password) return null;
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !allowLoopback) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(literal) !== 0 && !loopback && !isPublicDomainAddress(literal)) return null;
  url.hash = "";
  return url.href.length > URL_MAX ? null : url;
}

const isOrigin = (value: string): boolean => { try { return new URL(value).origin === value; } catch { return false; } };

const storedUrl = z.string().max(URL_MAX).refine((value) => outboundUrl(value, true)?.href === value);

export const a2aPeerSchema = z.object({
  id: z.string().regex(LINK_ID),
  name: z.string().min(1).max(PEER_NAME_MAX).refine((value) => cleanName(value, PEER_NAME_MAX) === value),
  /** Where this server finds the peer's card. Absent: the peer only calls in. */
  url: storedUrl.optional(),
  /** The peer's JSON-RPC address, as its card named it. Always on the origin of `url`. */
  endpoint: storedUrl.optional(),
  /** The origin of `url` at the time the token this server sends was confirmed. The token goes only to that origin. */
  tokenOrigin: z.string().max(URL_MAX).refine(isOrigin).optional(),
  /** The sha256 of the token the peer sends. Absent: the peer does not call in. */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  exposed: z.array(botIdSchema).max(500),
  cap: z.enum(APPROVAL_CAPS),
  createdAt: z.number().finite(),
})
  .refine((peer) => peer.url !== undefined || peer.tokenHash !== undefined)
  .refine((peer) => peer.endpoint === undefined || (peer.url !== undefined && new URL(peer.endpoint).origin === new URL(peer.url).origin));

export type A2aPeer = z.infer<typeof a2aPeerSchema>;

/** A removed peer whose work here may still run: its key and its cap stay until that work ends. */
const endedSchema = z.object({ key: z.string().regex(/^[0-9a-f]{8}$/u), cap: z.enum(APPROVAL_CAPS), at: z.number().finite() }).strict();
export type EndedPeer = z.infer<typeof endedSchema>;

export interface A2aPeersFile { v: 1; peers: A2aPeer[]; ended?: EndedPeer[] }

const fileShape = z.object({ v: z.literal(1), peers: z.array(z.unknown()), ended: z.array(z.unknown()).optional() });

export function readA2aPeers(dataDir: string, log: (line: string) => void = () => {}): A2aPeersFile {
  let text: string;
  try { text = readFileSync(join(linkedServersDir(dataDir), FILE), "utf8"); } catch { return { v: 1, peers: [] }; }
  let raw: unknown[], rawEnded: unknown[];
  try { ({ peers: raw, ended: rawEnded = [] } = fileShape.parse(JSON.parse(text))); } catch {
    log("a2a peers: their record did not parse, so no A2A peer is in use");
    return { v: 1, peers: [] };
  }
  const ended = rawEnded.flatMap((one) => { const parsed = endedSchema.safeParse(one); return parsed.success ? [parsed.data] : []; }).slice(-ENDED_MAX);
  const peers: A2aPeer[] = [];
  let dropped = 0;
  for (const one of raw) {
    const parsed = a2aPeerSchema.safeParse(one);
    if (!parsed.success || peers.some((peer) => peer.id === parsed.data.id) || peers.length >= LINKS_MAX) { dropped += 1; continue; }
    peers.push(parsed.data);
  }
  if (dropped > 0) log(`a2a peers: ${dropped} entries did not parse or were over the limit, so they are not in use`);
  return { v: 1, peers, ...(ended.length ? { ended } : {}) };
}

export function writeA2aPeers(dataDir: string, file: A2aPeersFile): void {
  const peers = file.peers.map((peer) => a2aPeerSchema.parse(peer));
  if (peers.length > LINKS_MAX) throw new Error("too many A2A peers");
  const ended = (file.ended ?? []).map((one) => endedSchema.parse(one)).slice(-ENDED_MAX);
  ensurePrivateDir(linkedServersDir(dataDir));
  writeFileAtomic(join(linkedServersDir(dataDir), FILE), JSON.stringify({ v: 1, peers, ...(ended.length ? { ended } : {}) }), { mode: 0o600 });
}

/** A new inbound token. Only the hash goes into the record; the token is shown once. */
export function newA2aToken(): { token: string; hash: string } {
  const token = `${A2A_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashSecret(token) };
}

/** Security invariant: every stored hash is compared, with no early exit, so the time does not tell which peer is near. */
export function peerByToken(file: A2aPeersFile, token: string | null | undefined): A2aPeer | undefined {
  if (!token || !TOKEN.test(token)) return undefined;
  const hash = hashSecret(token);
  let found: A2aPeer | undefined;
  for (const peer of file.peers) if (peer.tokenHash && sameHash(peer.tokenHash, hash)) found = peer;
  return found;
}

/** The ids the A2A peers use, so a new link id of either kind is new in both records. */
export const a2aPeerIds = (file: A2aPeersFile): string[] => file.peers.map((peer) => peer.id);

/** Stage 1 links and A2A peers share one maximum, LINKS_MAX. */
export const linksInUse = (stage1Links: readonly unknown[], file: A2aPeersFile): number => stage1Links.length + file.peers.length;
export const linksFull = (stage1Links: readonly unknown[], file: A2aPeersFile): boolean => linksInUse(stage1Links, file) >= LINKS_MAX;
