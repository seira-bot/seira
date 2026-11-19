import type { AppEnv } from "./env";

export const WINDOW_SECONDS = 3600;
export const PER_INSTALL_LIMIT = 5;
export const DUPLICATE_SECONDS = 24 * 3600;

interface Bucket {
  count: number;
  oldest: number | null;
}

async function bucketOf(env: AppEnv, nowSeconds: number, installHash?: string): Promise<Bucket> {
  const since = nowSeconds - WINDOW_SECONDS;
  const statement = installHash
    ? env.DB.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM reports WHERE install_hash = ? AND created_at > ?").bind(installHash, since)
    : env.DB.prepare("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM reports WHERE created_at > ?").bind(since);
  const row = await statement.first<Bucket>();
  return { count: Number(row?.count ?? 0), oldest: row?.oldest ?? null };
}

/** Seconds to wait when this install or all installs sent too many reports in the last hour, else null. */
export async function reportRetryAfter(env: AppEnv, installHash: string, nowSeconds: number): Promise<number | null> {
  const globalLimit = Number(env.GLOBAL_HOURLY_LIMIT) || 120;
  for (const [bucket, limit] of [
    [await bucketOf(env, nowSeconds, installHash), PER_INSTALL_LIMIT],
    [await bucketOf(env, nowSeconds), globalLimit],
  ] as const) {
    if (bucket.count >= limit) return Math.max(1, (bucket.oldest ?? nowSeconds) + WINDOW_SECONDS - nowSeconds);
  }
  return null;
}

export async function recentDuplicate(env: AppEnv, installHash: string, payloadHash: string, nowSeconds: number) {
  const row = await env.DB.prepare(
    "SELECT id FROM reports WHERE install_hash = ? AND payload_hash = ? AND created_at > ? AND issue_number IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(installHash, payloadHash, nowSeconds - DUPLICATE_SECONDS)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Takes one slot of both hourly limits in a single statement, so parallel requests cannot all pass the check. */
export async function reserveReport(
  env: AppEnv,
  row: { id: string; installHash: string; payloadHash: string; fingerprint: string },
  nowSeconds: number,
) {
  const since = nowSeconds - WINDOW_SECONDS;
  const result = await env.DB.prepare(
    `INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at)
     SELECT ?, ?, ?, ?, NULL, NULL, ?
     WHERE (SELECT COUNT(*) FROM reports WHERE install_hash = ? AND created_at > ?) < ?
       AND (SELECT COUNT(*) FROM reports WHERE created_at > ?) < ?`,
  )
    .bind(row.id, row.installHash, row.payloadHash, row.fingerprint, nowSeconds, row.installHash, since, PER_INSTALL_LIMIT, since, Number(env.GLOBAL_HOURLY_LIMIT) || 120)
    .run();
  return result.meta.changes > 0;
}
