// Temp file, fsync, rename: rename(2) is atomic on one filesystem, so a reader sees the whole old or the whole new file.
// The fsync (F_FULLFSYNC on macOS, ~4 ms) is what `durable: false` drops: a crash still never tears the file, only a power
// loss can leave it empty.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { join } from "node:path";

import { timeBlocking } from "./perf/loop-stalls.ts";

export type AtomicWriteOptions = {
  mode?: number;
  /** false skips the fsync. Default true. */
  durable?: boolean;
};

/** Windows refuses a rename onto a path while anything (a virus scanner, the indexer) holds a handle, as EPERM or EACCES
 * that would succeed a moment later, so those are retried (~155 ms worst case); everything else throws. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  // Node has no synchronous sleep: Atomics.wait on a shared buffer blocks without spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(
  tmp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  timeBlocking("saves", () => writeWhole(path, data, options));
}

function writeWhole(path: string, data: string | Uint8Array, options: AtomicWriteOptions): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Permissions go on the temp inode itself, so a broader-permission file is never visible before a chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    if (options.durable !== false) fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to someone else. Only ESRCH says that it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * A crash or a kill between the temp file and the rename leaves `<file>.<pid>.<uuid>.tmp` behind (it holds a whole copy of
 * the file, souls and settings included). This removes those in `dir` for each of `files` when the process in the name is
 * gone. A temp file of a live process, and of this process (a save here is synchronous, so none is under way at the start
 * but a pid can come back in a container), stays; so does anything that is not a regular file. Returns the names removed.
 * One that cannot be removed stays for the next start.
 */
export function removeDeadTempFiles(
  dir: string,
  files: readonly string[],
  isAlive: (pid: number) => boolean = processIsAlive,
): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(.+)\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u.exec(entry.name);
    if (!match || !files.includes(match[1]!)) continue;
    const pid = Number(match[2]);
    if (pid === process.pid || isAlive(pid)) continue;
    try {
      unlinkSync(join(dir, entry.name));
      removed.push(entry.name);
    } catch {
    }
  }
  return removed;
}

/** Any doubt answers false, so this check is never why a save fails; it reads the disk, since a restore or hand edit may have changed it. */
function holdsExactly(path: string, data: string, mode: number | undefined): boolean {
  let fd: number | null = null;
  try {
    if (process.platform === "win32") {
      // No O_NOFOLLOW on Windows; a reparse point is replaced, not read.
      if (!lstatSync(path).isFile()) return false;
      fd = openSync(path, "r");
    } else {
      // Inspect the inode the open landed on, so a swap cannot pass as a match; O_NONBLOCK keeps a planted FIFO from hanging the open.
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== Buffer.byteLength(data)) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return false;
    // Windows reports 0o666 for any writable file; its mode bits mean nothing.
    if (mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777 & ~mode) !== 0) return false;
    return readFileSync(fd).equals(Buffer.from(data));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

export function writeFileAtomicIfChanged(path: string, data: string, options: AtomicWriteOptions = {}): boolean {
  if (holdsExactly(path, data, options.mode)) return false;
  writeFileAtomic(path, data, options);
  return true;
}

/** A file only this process writes while it runs: a save whose text equals the last one written (or read at load) is
 * skipped without reading the disk back. */
export class OwnedFile {
  private last: string | undefined;
  readonly path: string;
  private readonly options: AtomicWriteOptions;

  constructor(path: string, options: AtomicWriteOptions = {}) {
    this.path = path;
    this.options = options;
  }

  loaded(text: string): void {
    this.last = text;
  }

  write(text: string): boolean {
    if (text === this.last) return false;
    writeFileAtomic(this.path, text, this.options);
    this.last = text;
    return true;
  }
}
