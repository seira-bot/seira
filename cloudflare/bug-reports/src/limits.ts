import type { AppEnv } from "./env";

export const WINDOW_SECONDS = 3600;
export const PER_INSTALL_LIMIT = 5;
export const PER_IP_LIMIT = 10;
export const DEFAULT_GLOBAL_LIMIT = 30;
export const DUPLICATE_SECONDS = 24 * 3600;

interface Bucket {
  count: number;
  oldest: number | null;
}

const globalLimitOf = (env: AppEnv) => Number(env.GLOBAL_HOURLY_LIMIT) || DEFAULT_GLOBAL_LIMIT;

async function bucketOf(env: AppEnv, nowSeconds: number, by?: { column: "install_hash" | "ip_hash"; value: string }): Promise<Bucket> {
  const since = nowSeconds - WINDOW_SECONDS;
  const statement = by
    ? env.DB.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM reports WHERE ${by.column} = ? AND created_at > ?`).bind(by.value, since)
    : env.DB.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM reports WHERE created_at > ?").bind(since);
  const row = await statement.first<Bucket>();
  return { count: Number(row?.count ?? 0), oldest: row?.oldest ?? null };
}

/** Seconds to wait when this install, this IP address or all installs sent too many reports in the last hour, else null. */
export async function reportRetryAfter(env: AppEnv, installHash: string, ipHash: string, nowSeconds: number): Promise<number | null> {
  for (const [bucket, limit] of [
    [await bucketOf(env, nowSeconds, { column: "install_hash", value: installHash }), PER_INSTALL_LIMIT],
    [await bucketOf(env, nowSeconds, { column: "ip_hash", value: ipHash }), PER_IP_LIMIT],
    [await bucketOf(env, nowSeconds), globalLimitOf(env)],
  ] as const) {
    if (bucket.count >= limit) return Math.max(1, (bucket.oldest ?? nowSeconds) + WINDOW_SECONDS - nowSeconds);
  }
  return null;
}

/** The first report of this install with this payload in the last 24 hours that reached an issue, else null. */
export async function recentDuplicate(env: AppEnv, installHash: string, payloadHash: string, nowSeconds: number) {
  const row = await env.DB.prepare(
    "SELECT id, issue_number, comment_id FROM reports WHERE install_hash = ? AND payload_hash = ? AND created_at > ? AND issue_number IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(installHash, payloadHash, nowSeconds - DUPLICATE_SECONDS)
    .first<{ id: string; issue_number: number; comment_id: number | null }>();
  return row ? { id: row.id, issue: row.issue_number, joined: row.comment_id !== null } : null;
}

/** Takes one slot of all three hourly limits in a single statement, so parallel requests cannot all pass the check. */
export async function reserveReport(
  env: AppEnv,
  row: { id: string; installHash: string; ipHash: string; payloadHash: string; fingerprint: string },
  nowSeconds: number,
) {
  const since = nowSeconds - WINDOW_SECONDS;
  const result = await env.DB.prepare(
    `INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at, ip_hash)
     SELECT ?, ?, ?, ?, NULL, NULL, ?, ?
     WHERE (SELECT COUNT(*) FROM reports WHERE install_hash = ? AND created_at > ?) < ?
       AND (SELECT COUNT(*) FROM reports WHERE ip_hash = ? AND created_at > ?) < ?
       AND (SELECT COUNT(*) FROM reports WHERE created_at > ?) < ?`,
  )
    .bind(
      row.id,
      row.installHash,
      row.payloadHash,
      row.fingerprint,
      nowSeconds,
      row.ipHash,
      row.installHash,
      since,
      PER_INSTALL_LIMIT,
      row.ipHash,
      since,
      PER_IP_LIMIT,
      since,
      globalLimitOf(env),
    )
    .run();
  return result.meta.changes > 0;
}

/** The IP hash is needed only for the hourly window. Clears it from older rows. */
export async function clearOldIpHashes(env: AppEnv, nowSeconds: number) {
  await env.DB.prepare("UPDATE reports SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at <= ?")
    .bind(nowSeconds - WINDOW_SECONDS)
    .run();
}
