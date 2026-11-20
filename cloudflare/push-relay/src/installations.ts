import { z } from "zod";

import { DAY_MS, HOUR_MS, HTTPError, errorResponse, hmacHex, json, noContent, randomBase64url, readJson, sha256Hex, timingSafeEqualHex } from "./common";
import type { AppEnv, Deps } from "./env";
import { rateKeyOf } from "./ip";
import { daily, limitVar, takeAll } from "./limits";

export const CREDENTIAL_PREFIX = "seira_install_";
export const CREDENTIAL_TTL_MS = 90 * DAY_MS;
const CREDENTIAL = /^seira_install_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

const enrollSchema = z.strictObject({ v: z.literal(1) });

async function newCredential(now: number) {
  const lookupId = randomBase64url(16);
  const raw = `${CREDENTIAL_PREFIX}${lookupId}.${randomBase64url(32)}`;
  return { lookupId, raw, secretHash: await sha256Hex(raw), createdAt: now, expiresAt: now + CREDENTIAL_TTL_MS };
}

type NewCredential = Awaited<ReturnType<typeof newCredential>>;

const insertCredential = (env: AppEnv, installationId: string, credential: NewCredential) =>
  env.DB.prepare(
    "INSERT INTO installation_credentials (lookup_id, installation_id, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(credential.lookupId, installationId, credential.secretHash, credential.createdAt, credential.expiresAt);

/** POST /v1/push/enroll: an installation and its first credential, with no account. */
export async function enroll(request: Request, env: AppEnv, deps: Deps): Promise<Response> {
  if (env.ENROLL_PAUSED === "true" || !env.IP_HASH_KEY) return errorResponse(503, "enroll_unavailable");
  const ip = request.headers.get("cf-connecting-ip");
  const ipKey = ip ? rateKeyOf(ip) : "unknown";
  if (!(await env.ENROLL_LIMITER.limit({ key: ipKey })).success) return errorResponse(429, "rate_limited", 60);
  if (!enrollSchema.safeParse(await readJson(request)).success) throw new HTTPError(400, "invalid_request");

  const now = deps.now();
  await takeAll(
    env,
    [
      daily(`ip:${await hmacHex(env.IP_HASH_KEY, ipKey)}`, "enroll", limitVar(env.ENROLL_PER_IP_DAILY, 5)),
      daily("global", "enroll", limitVar(env.ENROLL_GLOBAL_DAILY, 2000)),
    ],
    now,
  );

  const installationId = crypto.randomUUID();
  const credential = await newCredential(now);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO installations (id, created_at, last_seen_at) VALUES (?, ?, ?)").bind(installationId, now, now),
    insertCredential(env, installationId, credential),
  ]);
  return json({ installationId, credential: credential.raw, expiresAt: credential.expiresAt }, 201);
}

export interface Caller {
  installationId: string;
  lookupId: string;
  blockedUntil: number | null;
}

interface CredentialRow {
  installation_id: string;
  lookup_id: string;
  secret_hash: string;
  blocked_until: number | null;
}

/** The installation for the Bearer credential, or HTTPError 401. Records the use at most once an hour. */
export async function authenticate(request: Request, env: AppEnv, deps: Deps): Promise<Caller> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const parsed = bearer?.match(CREDENTIAL);
  if (!bearer || !parsed) throw new HTTPError(401, "unauthorized");
  const now = deps.now();
  const row = await env.DB.prepare(
    `SELECT c.installation_id, c.lookup_id, c.secret_hash, i.blocked_until
       FROM installation_credentials c JOIN installations i ON i.id = c.installation_id
      WHERE c.lookup_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?`,
  )
    .bind(parsed[1]!, now)
    .first<CredentialRow>();
  if (!row || !timingSafeEqualHex(await sha256Hex(bearer), row.secret_hash)) throw new HTTPError(401, "unauthorized");
  await env.DB.prepare("UPDATE installations SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
    .bind(now, row.installation_id, now - HOUR_MS)
    .run();
  return { installationId: row.installation_id, lookupId: row.lookup_id, blockedUntil: row.blocked_until };
}

/** POST /v1/installations/self/credentials/rotate: a new credential. The old one stops working in the same batch. */
export async function rotate(caller: Caller, env: AppEnv, deps: Deps): Promise<Response> {
  const now = deps.now();
  const credential = await newCredential(now);
  await env.DB.batch([
    env.DB.prepare("UPDATE installation_credentials SET revoked_at = ? WHERE lookup_id = ? AND revoked_at IS NULL").bind(now, caller.lookupId),
    insertCredential(env, caller.installationId, credential),
  ]);
  return json({ credential: credential.raw, expiresAt: credential.expiresAt });
}

/** Deletes the installation, its credentials, and its tokens. The foreign keys cascade; the batch is explicit as well. */
export function deleteInstallationStatements(env: AppEnv, where: string, ...values: unknown[]) {
  return [
    env.DB.prepare(`DELETE FROM push_devices WHERE installation_id IN (SELECT id FROM installations WHERE ${where})`).bind(...values),
    env.DB.prepare(`DELETE FROM installation_credentials WHERE installation_id IN (SELECT id FROM installations WHERE ${where})`).bind(...values),
    env.DB.prepare(`DELETE FROM installations WHERE ${where}`).bind(...values),
  ];
}

export async function deleteSelf(caller: Caller, env: AppEnv): Promise<Response> {
  await env.DB.batch(deleteInstallationStatements(env, "id = ?", caller.installationId));
  return noContent();
}
