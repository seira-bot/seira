import { DAY_MS, HOUR_MS, HTTPError } from "./common";
import type { AppEnv } from "./env";

export interface Counter {
  subject: string;
  action: string;
  limit: number;
  /** The length of the fixed window: an hour, or a UTC day. */
  windowMs: number;
}

export const hourly = (subject: string, action: string, limit: number): Counter => ({ subject, action, limit, windowMs: HOUR_MS });
export const daily = (subject: string, action: string, limit: number): Counter => ({ subject, action, limit, windowMs: DAY_MS });

/** A positive whole number from a variable, or the default. */
export function limitVar(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const windowStart = (counter: Counter, now: number) => Math.floor(now / counter.windowMs) * counter.windowMs;
const secondsToEnd = (counter: Counter, now: number) => Math.max(1, Math.ceil((windowStart(counter, now) + counter.windowMs - now) / 1000));

/**
 * Takes one slot of every counter, or none. The first read finds a full counter without spending the others.
 * The take is one batch of guarded upserts, so parallel requests cannot pass a full counter.
 * Throws HTTPError 429 with `retry-after` when a counter is full.
 */
export async function takeAll(env: AppEnv, counters: Counter[], now: number): Promise<void> {
  const reads = await env.DB.batch(
    counters.map((counter) =>
      env.DB.prepare("SELECT count FROM action_limits WHERE subject = ? AND action = ? AND window_start = ?").bind(counter.subject, counter.action, windowStart(counter, now)),
    ),
  );
  for (const [index, counter] of counters.entries()) {
    const row = reads[index]?.results[0] as { count: number } | undefined;
    if (row && row.count >= counter.limit) throw new HTTPError(429, "rate_limited", secondsToEnd(counter, now));
  }
  const takes = await env.DB.batch(
    counters.map((counter) =>
      env.DB.prepare(
        `INSERT INTO action_limits (subject, action, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(subject, action, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`,
      ).bind(counter.subject, counter.action, windowStart(counter, now), counter.limit),
    ),
  );
  for (const [index, counter] of counters.entries()) {
    if (takes[index]?.meta.changes === 0) throw new HTTPError(429, "rate_limited", secondsToEnd(counter, now));
  }
}

/** Adds one to a counter without a limit and answers the new count. */
export async function bump(env: AppEnv, counter: Counter, now: number): Promise<number> {
  const start = windowStart(counter, now);
  const [, read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO action_limits (subject, action, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(subject, action, window_start) DO UPDATE SET count = count + 1`,
    ).bind(counter.subject, counter.action, start),
    env.DB.prepare("SELECT count FROM action_limits WHERE subject = ? AND action = ? AND window_start = ?").bind(counter.subject, counter.action, start),
  ]);
  return Number((read?.results[0] as { count: number } | undefined)?.count ?? 0);
}
