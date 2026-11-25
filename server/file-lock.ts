// A lock between the processes that share one data folder, such as the server and `seira access add`. The lock is a file
// that one process creates with the "wx" flag: the create fails when the file exists, so only one process holds it. The
// wait is synchronous because the code that needs it (a check and a write that no other process may split) is synchronous
// too, and the part it covers is a few small file reads and writes.
//
// Security: a process never removes or replaces a lock that a live process holds, and never gives back a lock that
// another process holds now.
// - The file names its holder (process id, start time, token). A lock is stale only when it is older than `staleMs` AND
//   its holder is gone. A slow or paused holder keeps its lock; a waiter times out instead of taking it.
// - Only the holder of the takeover guard may remove a stale lock, and it re-reads the lock under the guard: a lock that
//   changed since it was judged stale is left alone.
// - Giving a lock back removes the file only when it still holds this process's token.
// The processes must share one process table: a holder in another container or host looks gone after `staleMs`.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface FileLockOptions {
  /** A lock file older than this, whose holder is gone, is a crashed process's. Default 10 seconds. */
  staleMs?: number;
  /** How long to wait for another process before giving up. Default 15 seconds. */
  waitMs?: number;
}

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 5;

/** The locks this process holds, with how many times each was taken: one code path may take a lock it already holds. */
const holding = new Map<string, { depth: number; text: string }>();

const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const codeOf = (error: unknown) => Reflect.get(Object(error), "code");

/** The start time that Linux keeps for a process, so that a reused process id does not look like the old holder. */
function startOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "-";
  } catch {
    return "-";
  }
}

interface Holder { pid: number; started: string }

function holderOf(text: string): Holder | null {
  const [pid, started, token] = text.trim().split(" ");
  const id = Number(pid);
  return Number.isSafeInteger(id) && id > 0 && started && token ? { pid: id, started } : null;
}

function alive(holder: Holder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (codeOf(error) === "ESRCH") return false;
  }
  const now = startOf(holder.pid);
  return holder.started === "-" || now === "-" || now === holder.started;
}

type Seen = { text: string; mtimeMs: number } | null;

function look(file: string): Seen {
  try {
    return { text: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** A file that nobody wrote a holder into (a crash between create and write) is judged by its age alone. */
function stale(seen: NonNullable<Seen>, staleMs: number): boolean {
  if (Date.now() - seen.mtimeMs <= staleMs) return false;
  const holder = holderOf(seen.text);
  return !holder || !alive(holder);
}

function create(file: string, text: string): boolean {
  try {
    const descriptor = openSync(file, "wx", 0o600);
    try {
      writeSync(descriptor, text);
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
    return false;
  }
}

/** Removes the file only while it still holds `text`. */
function removeIfSame(file: string, text: string): void {
  try {
    if (readFileSync(file, "utf8") === text) unlinkSync(file);
  } catch {
    // Gone already, or not ours to read.
  }
}

/** Removes the stale lock `seen`, and only if it is still there unchanged. False when another process holds the guard. */
function takeOver(file: string, seen: NonNullable<Seen>, staleMs: number): boolean {
  const guard = `${file}.takeover`;
  const text = `${process.pid} ${startOf(process.pid)} ${randomUUID()}\n`;
  if (!create(guard, text)) {
    const other = look(guard);
    if (other && stale(other, staleMs)) removeIfSame(guard, other.text);
    return false;
  }
  try {
    if (look(file)?.text !== seen.text) return true;
    const grave = `${file}.${createHash("sha256").update(text).digest("hex").slice(0, 16)}.stale`;
    renameSync(file, grave);
    // The lock that moved is not the one judged stale: put it back at once, never over a lock that exists now.
    if (readFileSync(grave, "utf8") !== seen.text) {
      try {
        linkSync(grave, file);
      } catch {
        // A lock exists again: leave it.
      }
    }
    unlinkSync(grave);
  } catch {
    // Another process changed the lock: the loop looks again.
  } finally {
    removeIfSame(guard, text);
  }
  return true;
}

/** Takes the lock and returns the step that gives it back; calling that step again does nothing. */
export function acquireFileLock(file: string, options: FileLockOptions = {}): () => void {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const own = holding.get(file);
  let text = own?.text ?? "";
  if (!own) {
    text = `${process.pid} ${startOf(process.pid)} ${randomUUID()}\n`;
    while (!create(file, text)) {
      const seen = look(file);
      if (!seen) continue;
      if (stale(seen, staleMs) && takeOver(file, seen, staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`another process holds ${file}; try again`);
      sleep(POLL_MS);
    }
  }
  holding.set(file, { depth: (own?.depth ?? 0) + 1, text });
  let given = false;
  return () => {
    if (given) return;
    given = true;
    const state = holding.get(file);
    if (state && state.depth > 1) {
      holding.set(file, { ...state, depth: state.depth - 1 });
      return;
    }
    holding.delete(file);
    removeIfSame(file, text);
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
