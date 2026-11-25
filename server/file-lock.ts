// A lock between the processes that share one data folder, such as the server and `seira access add`. The lock is a file
// that a process publishes with `link`: the link fails when the file exists, so only one process holds it. The wait is
// synchronous because the code that needs it (a check and a write that no other process may split) is synchronous too, and
// the part it covers is a few small file reads and writes.
//
// Security: a process never removes or replaces a lock that a live process holds, and never gives back a lock that
// another process holds now.
// - Publishing is one step. The holder text goes into a private temporary file first, and `link` puts the whole file in
//   place. The lock file never exists without a full holder text, so a process that ends at any point leaves either no
//   lock or a complete one.
// - The file names its holder (process id, start time, token). A lock is stale only when it is older than `staleMs` AND
//   its holder is gone. When this cannot be told (no start time, no right to signal the process) the holder counts as
//   alive: the waiter times out instead of taking the lock.
// - Giving a lock back and taking over a stale lock are the same step: `removeLock`. It claims the lock text with a
//   hard link under a name made from that text, so only one process at a time can remove a lock with that text. It reads
//   the text again through the claim and removes the lock only when it is the text that the caller named. A lock that
//   changed in the meantime is never removed. A claim that a crashed process left is cleared after `staleMs`.
// - Every wait has an end: each loop checks the deadline, and any error that is not "the file is not there" ends the
//   wait with an error. A lock that cannot be judged is never taken.
// The processes must share one process table: a holder in another container or host looks gone after `staleMs`.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

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
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The name that a process claims to remove the lock `file` that holds `text`. Exported for the tests. */
export const claimOf = (file: string, text: string) => `${file}.${hashOf(text)}.claim`;

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

/** False only when the holder is known to be gone. Anything that cannot be told counts as alive. */
function alive(holder: Holder): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (codeOf(error) === "ESRCH") return false;
  }
  const now = startOf(holder.pid);
  return holder.started === "-" || now === "-" || now === holder.started;
}

type Seen = { text: string; mtimeMs: number };

/** What the file holds now, or null when it is not there. Any other error is thrown: a lock that cannot be read is not judged. */
function look(file: string): Seen | null {
  try {
    return { text: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** A file that names no holder (written by something else) is judged by its age alone. */
function stale(seen: Seen, staleMs: number): boolean {
  if (Date.now() - seen.mtimeMs <= staleMs) return false;
  const holder = holderOf(seen.text);
  return !holder || !alive(holder);
}

const holderText = () => `${process.pid} ${startOf(process.pid)} ${randomUUID()}\n`;

/** Puts `file` in place with all of `text` in it, in one step. False when the file exists. */
function publish(file: string, text: string): boolean {
  const temp = `${file}.${randomUUID()}.tmp`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeSync(descriptor, text);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temp);
    throw error;
  }
  closeSync(descriptor);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Gone already.
    }
  }
}

type Removal = "removed" | "kept" | "busy";

/** Removes the lock `file` only while it holds `text`. "busy": another process is removing a lock with this text now. */
function removeLock(file: string, text: string, staleMs: number): Removal {
  const claim = claimOf(file, text);
  try {
    linkSync(file, claim);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return "kept";
    if (code !== "EEXIST") throw error;
    // A claim from a process that ended: after `staleMs` nobody is removing the lock with it.
    const left = look(claim);
    if (left && Date.now() - left.mtimeMs > staleMs) {
      try {
        unlinkSync(claim);
      } catch {
        // Cleared by another process.
      }
    }
    return "busy";
  }
  try {
    // The claim is the lock file that was at the path when the link was made. Nobody removes that file while the claim
    // exists, so what the claim holds is what the path holds.
    if (readFileSync(claim, "utf8") !== text) return "kept";
    unlinkSync(file);
    return "removed";
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "kept";
    throw error;
  } finally {
    try {
      unlinkSync(claim);
    } catch {
      // Gone already.
    }
  }
}

/** Takes the lock and returns the step that gives it back; calling that step again does nothing. */
export function acquireFileLock(file: string, options: FileLockOptions = {}): () => void {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const own = holding.get(file);
  let text = own?.text ?? "";
  if (!own) {
    text = holderText();
    for (;;) {
      if (publish(file, text)) break;
      const seen = look(file);
      if (seen && stale(seen, staleMs)) removeLock(file, seen.text, staleMs);
      if (Date.now() >= deadline) throw new Error(`another process holds ${file}; try again`);
      sleep(POLL_MS);
    }
  }
  holding.set(file, { depth: (own?.depth ?? 0) + 1, text });
  let given = false;
  return () => {
    if (given) return;
    const state = holding.get(file);
    if (state && state.depth > 1) {
      given = true;
      holding.set(file, { ...state, depth: state.depth - 1 });
      return;
    }
    // A process that is removing a lock with this text now (it judged this process gone) makes this wait; the wait ends.
    const end = Date.now() + waitMs;
    while (removeLock(file, text, staleMs) === "busy") {
      if (Date.now() >= end) throw new Error(`could not give back ${file}; another process is changing it`);
      sleep(POLL_MS);
    }
    given = true;
    holding.delete(file);
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
