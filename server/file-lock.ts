// A lock between the processes that share one data folder, such as the server and `seira access add`. It is a file that
// one process creates with the "wx" flag: the create fails when the file exists, so only one process holds it. The wait is
// synchronous because the code that needs it (a check and a write that no other process may split) is synchronous too, and
// the part it covers is a few small file reads and writes.
//
// A lock that a crashed process left behind is taken over after `staleMs`. Two processes that both find the same old lock
// at the same moment can both take it over; that needs a crash and a collision within the same few milliseconds.
import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface FileLockOptions {
  /** A lock file older than this is a crashed process's. Default 10 seconds. */
  staleMs?: number;
  /** How long to wait for another process before giving up. Default 15 seconds. */
  waitMs?: number;
}

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 5;

/** The locks this process holds, with how many times each was taken: one code path may take a lock it already holds. */
const holding = new Map<string, number>();

const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Takes the lock and returns the step that gives it back; calling that step again does nothing. */
export function acquireFileLock(file: string, options: FileLockOptions = {}): () => void {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const depth = holding.get(file);
  if (depth === undefined) {
    for (;;) {
      try {
        const descriptor = openSync(file, "wx", 0o600);
        try {
          writeSync(descriptor, `${process.pid}\n`);
        } finally {
          closeSync(descriptor);
        }
        break;
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
      }
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) {
          const grave = `${file}.${randomUUID()}.stale`;
          renameSync(file, grave);
          unlinkSync(grave);
          continue;
        }
      } catch {
        // The holder gave it back while we looked: try to take it at once.
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`another process holds ${file}; try again`);
      sleep(POLL_MS);
    }
  }
  holding.set(file, (depth ?? 0) + 1);
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const left = (holding.get(file) ?? 1) - 1;
    if (left > 0) {
      holding.set(file, left);
      return;
    }
    holding.delete(file);
    try {
      unlinkSync(file);
    } catch {
      // Already gone: a takeover removed it.
    }
  };
}

/** Runs `run` while this process holds the lock. */
export function withFileLock<T>(file: string, run: () => T, options?: FileLockOptions): T {
  const release = acquireFileLock(file, options);
  try {
    return run();
  } finally {
    release();
  }
}
