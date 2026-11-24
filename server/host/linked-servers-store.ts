// The record of this server's links to servers of other owners: <data>/linked-servers/links.json, mode 600. It keeps each
// link's far place, what that place may reach here, and on the side that issued it only the sha256 of its credential.
// Invites are kept the same way, as a hash, and each is good once for INVITE_TTL_MS.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { placeSchema, type Place } from "../bot-link/protocol.ts";
import { ensurePrivateDir } from "../data-dir.ts";
import { checkOriginText, loopbackAllowed } from "./linked-servers-egress.ts";

export const GUEST_TOKEN_PREFIX = "lsk_";
export const INVITE_TTL_MS = 15 * 60_000;
export const LINKS_MAX = 20;
/** Invites that wait to be used at one time; a new one pushes out the oldest. */
const INVITES_MAX = 20;
/** Ended links whose work may still run here; a new one pushes out the oldest. */
export const ENDED_MAX = 200;
const INVITE_PREFIX = "seira-link:";
const DIR = "linked-servers";
const FILE = "links.json";

export const APPROVAL_CAPS = ["ask", "edits", "auto"] as const;
export type ApprovalCap = typeof APPROVAL_CAPS[number];

export const LINK_ID = /^[0-9a-f]{16}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
export const botIdSchema = z.string().regex(/^[\w-]{1,128}$/u);

const linkSchema = z.object({
  id: z.string().regex(LINK_ID),
  role: z.enum(["inviter", "joiner"]),
  place: z.object(placeSchema.shape),
  exposed: z.array(botIdSchema).max(500),
  cap: z.enum(APPROVAL_CAPS),
  tokenHash: hex64.optional(),
  createdAt: z.number(),
}).refine((link) => (link.role === "inviter") === (link.tokenHash !== undefined));
const inviteSchema = z.object({ hash: hex64, expiresAt: z.number(), usedAt: z.number().optional() });
/** A link that ended while work its peer started here could still run: by its peer's key, with the cap it had then. */
const endedSchema = z.object({ key: z.string().regex(/^[0-9a-f]{8}$/u), cap: z.enum(APPROVAL_CAPS), at: z.number() });
const fileSchema = z.object({ v: z.literal(1), links: z.array(linkSchema).max(LINKS_MAX), invites: z.array(inviteSchema).max(INVITES_MAX),
  ended: z.array(endedSchema).max(ENDED_MAX).optional() });

export type StoredLink = z.infer<typeof linkSchema>;
export type LinksFile = z.infer<typeof fileSchema>;

const empty = (): LinksFile => ({ v: 1, links: [], invites: [] });

export const linkedServersDir = (dataDir: string): string => join(dataDir, DIR);

/** The folder of one link's own state. Only a well-formed link id names one. */
export function instanceDir(dataDir: string, id: string): string {
  if (!LINK_ID.test(id)) throw new Error("not a link id");
  return join(dataDir, DIR, id);
}

export function readLinks(dataDir: string, log: (line: string) => void = () => {}): LinksFile {
  let text: string;
  try { text = readFileSync(join(dataDir, DIR, FILE), "utf8"); } catch { return empty(); }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch { /* reported below */ }
  log("linked servers: their record did not parse, so no link is in use");
  return empty();
}

export function writeLinks(dataDir: string, file: LinksFile): void {
  ensurePrivateDir(join(dataDir, DIR));
  writeFileAtomic(join(dataDir, DIR, FILE), JSON.stringify(file), { mode: 0o600 });
}

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}
const newSecret = (): string => randomBytes(32).toString("base64url");
export const newToken = (): string => `${GUEST_TOKEN_PREFIX}${newSecret()}`;
export const newLinkId = (): string => randomBytes(8).toString("hex");

export function pruneInvites(file: LinksFile, now: number): void {
  file.invites = file.invites.filter((one) => one.usedAt === undefined && one.expiresAt > now).slice(-INVITES_MAX);
}

/** A new single-use code. Only its hash is kept. */
export function addInvite(file: LinksFile, now: number): { code: string; expiresAt: number } {
  pruneInvites(file, now);
  const code = newSecret(), expiresAt = now + INVITE_TTL_MS;
  file.invites = [...file.invites, { hash: hashSecret(code), expiresAt }].slice(-INVITES_MAX);
  return { code, expiresAt };
}

/** The invite this code opens, while it is unused and has not expired. */
export function liveInvite(file: LinksFile, code: string, now: number): LinksFile["invites"][number] | undefined {
  if (!SECRET.test(code)) return undefined;
  const hash = hashSecret(code);
  const found = file.invites.find((one) => sameHash(one.hash, hash));
  return found && found.usedAt === undefined && found.expiresAt > now ? found : undefined;
}

export interface Invite { origin: string; name: string; code: string }
const inviteBody = z.object({ v: z.literal(1), origin: z.string().max(300), name: z.string().max(400), code: z.string().regex(SECRET) }).strict();

export const encodeInvite = ({ origin, name, code }: Invite): string => `${INVITE_PREFIX}${Buffer.from(JSON.stringify({ v: 1, origin, name, code })).toString("base64url")}`;

export function decodeInvite(text: string): Invite | null {
  const trimmed = text.trim();
  if (trimmed.length > 4_096 || !trimmed.startsWith(INVITE_PREFIX)) return null;
  const body = trimmed.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(body)) return null;
  try {
    const parsed = inviteBody.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    return parsed.success ? { origin: parsed.data.origin, name: cleanName(parsed.data.name), code: parsed.data.code } : null;
  } catch { return null; }
}

/** Security invariant: another server is asked only at an https address that is not a local or private address literal,
 * and never at an address that carries a user name or password. Whether a name resolves to a public address is checked
 * at every connect, in `linked-servers-egress.ts`. Null for any other address. A test may allow this machine's loopback. */
export function guestOrigin(value: string, allowLoopback = loopbackAllowed()): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  try { checkOriginText(url, allowLoopback); } catch { return null; }
  return url.origin;
}

const UNSAFE = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]+/gu;

/** A name another server chose, as one line without control or direction characters, at most `max` UTF-16 units (the
 * unit the link's own place schema counts), never cut inside a character. */
export function cleanName(raw: string, max = 120): string {
  let out = "";
  for (const point of raw.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim()) {
    if (out.length + point.length > max) break;
    out += point;
  }
  return out.trim();
}

/** A far place as this server keeps it: its id as sent, its name cleaned. */
export function cleanPlace(place: Place, fallback: string): Place {
  return { id: place.id, name: cleanName(place.name) || fallback };
}
