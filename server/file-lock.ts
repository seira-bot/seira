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
// - The file names its holder (process id, start time, token). Every owner (a lock holder, or a process that is removing
//   a lock) is `alive`, `dead` or `unknown`. Only `dead` lets another process recover what the owner held; `alive` and
//   `unknown` (a holder text that is not the whole identity, no start time to compare, a process that cannot be judged)
//   wait until the deadline and then stop with an error. The identity is checked field by field before anything else:
//   a text that is short, long, or has a field in the wrong form is `unknown`, never `dead`. A lock is taken over only when it is older than `staleMs` AND its holder is dead.
// - Giving a lock back and taking over a stale lock are the same step: `removeLock`. A process that removes the lock with
//   text X first publishes a claim file for X that names itself. Only the claim holder reads the lock again, and it
//   removes the lock only while it still holds X. A claim is never removed while its owner is alive or unknown; a claim
//   of a dead owner stays in its place and the next process uses the next claim slot, so no process ever removes a claim
//   that another process may hold now. The claims of X are cleared once X is gone (X holds a unique token, so no
//   process claims X again for good).
// - Every wait has an end: each loop checks the deadline, and any error that is not "the file is not there" ends the
//   wait with an error. The deadlines use a monotonic clock, so a change of the wall clock does not lengthen or cut a wait.
// The processes must share one process table: a holder in another container or host looks gone after `staleMs`.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

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

/** Milliseconds on a clock that never goes back and does not follow changes of the wall clock. Used for every wait. */
const tick = () => performance.now();
const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const codeOf = (error: unknown) => Reflect.get(Object(error), "code");
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const MAX_CLAIMS = 32;
/** The name of claim slot `slot` for removing the lock `file` that holds `text`. Exported for the tests. */
export const claimOf = (file: string, text: string, slot = 0) => `${file}.${hashOf(text)}.${slot}.claim`;

/** The start time that Linux keeps for a process, so that a reused process id does not look like the old holder. */
function startOf(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return started !== undefined && /^[0-9]+$/.test(started) ? started : "-";
  } catch {
    return "-";
  }
}

interface Holder { pid: number; started: string }

/** The whole identity of a holder, and nothing else: `<pid> <start time or -> <token>` and one line end. */
const IDENTITY = /^([1-9][0-9]{0,9}) (-|[0-9]{1,20}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/;
const MAX_PID = 2_147_483_647;

/** The identity in `text`, or null when `text` is not exactly one complete identity (a short, long or changed text is not judged). */
function holderOf(text: string): Holder | null {
  const found = IDENTITY.exec(text);
  const pid = found ? Number(found[1]) : 0;
  return found && pid <= MAX_PID ? { pid, started: found[2]! } : null;
}

type Owner = "alive" | "dead" | "unknown";

/** `dead` only when the process is known to be gone, or when its id now belongs to another process. */
function ownerState(text: string): Owner {
  const holder = holderOf(text);
  if (!holder) return "unknown";
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if (codeOf(error) === "ESRCH") return "dead";
  }
  const now = startOf(holder.pid);
  if (holder.started === "-" || now === "-") return "unknown";
  return now === holder.started ? "alive" : "dead";
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

/** Old, and its holder is dead. A lock that names no valid holder is never stale: it is not proof that the lock is free.
 * The age is a file time (wall clock) by nature; it only adds to the check, the owner must be known to be dead as well. */
function stale(seen: Seen, staleMs: number): boolean {
  return Date.now() - seen.mtimeMs > staleMs && ownerState(seen.text) === "dead";
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

/** Removes the lock `file` only while it holds `text`. "busy": another process, or one that cannot be judged, is removing a lock with this text. */
function removeLock(file: string, text: string): Removal {
  const mine = holderText();
  const dead: string[] = [];
  let claim = "";
  for (let slot = 0, tries = 0; !claim; tries += 1) {
    if (slot >= MAX_CLAIMS || tries >= 2 * MAX_CLAIMS) return "busy";
    const name = claimOf(file, text, slot);
    if (publish(name, mine)) {
      claim = name;
      break;
    }
    const other = look(name);
    if (!other) continue; // Cleared since: try this slot again.
    if (ownerState(other.text) !== "dead") return "busy";
    dead.push(name);
    slot += 1;
  }
  try {
    // Only the holder of the claim removes a lock with this text, so the text that is read here is still there at the unlink.
    if (look(file)?.text !== text) return "kept";
    unlinkSync(file);
    return "removed";
  } catch (error) {
    if (codeOf(error) === "ENOENT") return "kept";
    throw error;
  } finally {
    for (const name of [...dead, claim]) {
      try {
        unlinkSync(name);
      } catch {
        // Gone already.
      }
    }
  }
}

/** Takes the lock and returns the step that gives it back; calling that step again does nothing. */
export function acquireFileLock(file: string, options: FileLockOptions = {}): () => void {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = tick() + waitMs;
  const own = holding.get(file);
  let text = own?.text ?? "";
  if (!own) {
    text = holderText();
    for (;;) {
      if (publish(file, text)) break;
      const seen = look(file);
      if (seen && stale(seen, staleMs)) removeLock(file, seen.text);
      if (tick() >= deadline) {
        const unknown = seen && ownerState(seen.text) === "unknown";
        throw new Error(`another process holds ${file}; try again${unknown ? " (its holder cannot be judged; remove the file by hand only when no Seira process runs)" : ""}`);
      }
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
    const end = tick() + waitMs;
    while (removeLock(file, text) === "busy") {
      if (tick() >= end) throw new Error(`could not give back ${file}; another process is changing it`);
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
