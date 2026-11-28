import { acquireDataDirLease, describeDataDirLease } from "./data-dir-lease.mjs";

export const BOOT_LEASE_WAIT_MS = 90_000;
export const BOOT_LEASE_RETRY_MS = 1_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function holderText(describe, dataDir) {
  try {
    const holder = describe(dataDir);
    return holder.pid === undefined ? `lease ${holder.state}` : `process ${holder.pid} (lease ${holder.state})`;
  } catch (error) {
    return `unknown holder (${error?.message ?? error})`;
  }
}

/**
 * @template T
 * @param {string} dataDir
 * @param {Record<string, unknown>} options passed to the acquire function
 * @param {{
 *   acquire?: (dataDir: string, options: Record<string, unknown>) => T,
 *   describe?: (dataDir: string) => { state: string, pid?: number },
 *   waitMs?: number,
 *   retryMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} [deps]
 * @returns {Promise<T>}
 */
export async function acquireDataDirLeaseWhenFree(dataDir, options, {
  acquire = acquireDataDirLease,
  describe = describeDataDirLease,
  waitMs = BOOT_LEASE_WAIT_MS,
  retryMs = BOOT_LEASE_RETRY_MS,
  now = Date.now,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  const startedAt = now();
  let waiting = false;
  const seconds = () => Math.round((now() - startedAt) / 1000);
  for (;;) {
    try {
      const lease = acquire(dataDir, options);
      if (waiting) log(`data folder lease acquired after waiting ${seconds()}s`);
      return lease;
    } catch (error) {
      if (error?.busy !== true) throw error;
      if (now() - startedAt >= waitMs) {
        log(`data folder still held by ${holderText(describe, dataDir)} after ${seconds()}s; giving up`);
        throw error;
      }
      if (!waiting) {
        waiting = true;
        log(`data folder held by ${holderText(describe, dataDir)}; waiting up to ${Math.round(waitMs / 1000)}s`);
      }
      await sleep(retryMs);
    }
  }
}
