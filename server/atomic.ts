// Temp file, fsync, rename: rename(2) is atomic on one filesystem, so a reader sees the whole old or the whole new file.
// The fsync (F_FULLFSYNC on macOS, ~4 ms) is what `durable: false` drops: a crash still never tears the file, only a power
// loss can leave it empty.
import { randomUUID } from "node:crypto";
import {
  close,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open, unlink } from "node:fs/promises";

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

const tempPathFor = (path: string): string => `${path}.${process.pid}.${randomUUID()}.tmp`;

function writeWhole(path: string, data: string | Uint8Array, options: AtomicWriteOptions): void {
  const tmp = tempPathFor(path);
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
 * the file, souls and settings included), and so does an exit while a save writes behind. This removes those in `dir` for
 * each of `files` when the process in the name is gone. A temp file of a live process, and of this process (none of its
 * saves is under way at the start, but a pid can come back in a container), stays; so does anything that is not a
 * regular file. Returns the names removed. One that cannot be removed stays for the next start.
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

/** The temp file of a whole-file write, written and synced on libuv's thread pool; the caller renames or discards it. */
async function writeTemp(path: string, data: string, options: AtomicWriteOptions): Promise<string> {
  const tmp = tempPathFor(path);
  const handle = await open(tmp, "w", options.mode);
  try {
    await handle.writeFile(data);
    if (options.durable !== false) await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await handle.close();
  return tmp;
}

/** Promises still on their way to the disk that no file waits on: an appended line's fsync, a dropped temp file's removal. */
const settling = new Set<Promise<void>>();

/** Counts `done`, which must not reject, as a write on its way to the disk until it settles: see writesBehindSettled. */
export function settleBehind(done: Promise<void>): void {
  settling.add(done);
  void done.then(() => settling.delete(done));
}

function discardTemp(tmp: string): void {
  settleBehind(unlink(tmp).catch(() => {}));
}

const BEHIND_RETRY_MS = 1_000;
const BEHIND_RETRIES = 5;
const behind = new Set<OwnedFile>();
let flushesBehindAtExit = false;

/**
 * Finishes every write behind (OwnedFile.deferWrites) now, synchronously: the newest text asked for lands, synced, and
 * no older one lands after it. `path` limits this to one file. Runs at every exit, a crash's included: each text was
 * taken whole when it was asked for (at the end of a pass, server/save-batch.ts), so it never holds half a change. Only a
 * kill or a power loss in the few milliseconds a write behind takes can lose it; the file then holds the state before.
 */
export function flushWritesBehind(path?: string): void {
  for (const file of Array.from(behind)) {
    if (path !== undefined && file.path !== path) continue;
    try {
      file.flush();
    } catch (error) {
      console.error("a save could not be finished; the next save of the file writes it", error);
    }
  }
}

/** Resolves once no write behind and no appended line is still on its way to the disk. */
export async function writesBehindSettled(): Promise<void> {
  for (;;) {
    const running = [...Array.from(behind, (file) => file.running), ...settling].filter((done) => done !== undefined);
    if (!running.length) return;
    await Promise.allSettled(running);
  }
}

/** A file only this process writes while it runs: a save whose text equals the last one written (or read at load) is
 * skipped without reading the disk back. */
export class OwnedFile {
  private last: string | undefined;
  readonly path: string;
  private readonly options: AtomicWriteOptions;
  /** The newest text asked for behind that no write has started on yet. */
  private wanted: string | undefined;
  private writing: { text: string; generation: number; done: Promise<void> } | undefined;
  /** Every synchronous write moves this on: a write behind that started before one finds it changed and never lands. */
  private generation = 0;
  private deferring = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(path: string, options: AtomicWriteOptions = {}) {
    this.path = path;
    this.options = options;
  }

  loaded(text: string): void {
    this.last = text;
  }

  get running(): Promise<void> | undefined {
    return this.writing?.done;
  }

  write(text: string): boolean {
    if (this.deferring) return this.writeBehind(text);
    this.dropBehind();
    if (text === this.last) return false;
    writeFileAtomic(this.path, text, this.options);
    this.last = text;
    return true;
  }

  /**
   * Writes of this file made while `run` runs return at once and reach the disk a moment later: the same temp file, fsync
   * and rename as `write`, with the write and the fsync on libuv's thread pool, so the server goes on meanwhile. One write
   * at a time, each of the newest text asked for; a synchronous `write` after it always wins. Until it lands the file holds
   * the text before, whole.
   */
  deferWrites(run: () => void): void {
    const was = this.deferring;
    this.deferring = true;
    try {
      run();
    } finally {
      this.deferring = was;
    }
  }

  /** Writes the newest text asked for behind now, synchronously; see flushWritesBehind. */
  flush(): void {
    const text = this.newest();
    this.dropBehind();
    if (text === undefined || text === this.last) return;
    writeFileAtomic(this.path, text, this.options);
    this.last = text;
  }

  /** The newest text asked for behind that a synchronous write has not superseded. */
  private newest(): string | undefined {
    return this.wanted ?? (this.writing?.generation === this.generation ? this.writing.text : undefined);
  }

  private writeBehind(text: string): boolean {
    if (text === (this.newest() ?? this.last)) return false;
    this.wanted = text;
    behind.add(this);
    if (!flushesBehindAtExit) {
      flushesBehindAtExit = true;
      process.on("exit", () => flushWritesBehind());
    }
    if (!this.writing && !this.retry) this.next();
    return true;
  }

  private dropBehind(): void {
    this.generation += 1;
    this.wanted = undefined;
    this.failures = 0;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    if (!this.writing) behind.delete(this);
  }

  private next(): void {
    const text = this.wanted;
    if (text === undefined) {
      if (!this.retry) behind.delete(this);
      return;
    }
    this.wanted = undefined;
    const generation = this.generation;
    const done = writeTemp(this.path, text, this.options).then(
      (tmp) => this.landed(tmp, text, generation),
      (error: unknown) => this.failed(error, text, generation),
    );
    this.writing = { text, generation, done };
  }

  private landed(tmp: string, text: string, generation: number): void {
    this.writing = undefined;
    if (generation !== this.generation) {
      discardTemp(tmp);
    } else {
      try {
        timeBlocking("saves", () => renameWithRetry(tmp, this.path));
      } catch (error) {
        discardTemp(tmp);
        this.failed(error, text, generation);
        return;
      }
      this.last = text;
      this.failures = 0;
    }
    this.next();
  }

  private failed(error: unknown, text: string, generation: number): void {
    this.writing = undefined;
    if (generation === this.generation) {
      this.failures += 1;
      console.error("a save failed; it is tried again", error);
      this.wanted ??= text;
      // After BEHIND_RETRIES failures in a row the text waits for the file's next save or the exit, instead of a timer.
      if (this.failures <= BEHIND_RETRIES) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.next();
        }, BEHIND_RETRY_MS);
        this.retry.unref?.();
      }
      return;
    }
    this.next();
  }
}

/**
 * Adds `line` and a newline to the end of `path` in one write (and a newline before it when the file does not end in
 * one), so every reader, in this process or another, sees it at once; the fsync follows on libuv's thread pool. A crash
 * cannot touch what the file held before, and a power loss before the fsync loses only this line. A write that fails
 * part way is cut back off. Returns false, having changed nothing, when the name is a link, has more than one link,
 * belongs to another user or cannot be opened, so the caller replaces the file whole, which writes no further than the
 * name; and on Windows, which has no O_NOFOLLOW.
 */
export function appendLine(path: string, line: string, mode: number): boolean {
  if (process.platform === "win32") return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  } catch {
    return false; // a link (ELOOP), a folder, a file this process may not open: the whole-file write says what is wrong
  }
  let size = 0;
  try {
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
      closeSync(fd);
      return false;
    }
    if ((stat.mode & 0o777 & ~mode) !== 0) fchmodSync(fd, mode);
    size = stat.size;
    const last = Buffer.alloc(1);
    const lead = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a ? "\n" : "";
    const bytes = Buffer.from(`${lead}${line}\n`);
    timeBlocking("saves", () => {
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    });
  } catch (error) {
    try {
      ftruncateSync(fd, size);
    } catch {
    }
    closeSync(fd);
    throw error;
  }
  const synced = new Promise<void>((resolve) => {
    fsync(fd, (error) => {
      if (error) console.error("an appended line could not be synced to the disk", error);
      close(fd, () => resolve());
    });
  });
  settleBehind(synced);
  return true;
}
