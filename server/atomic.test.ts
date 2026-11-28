import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spied, not replaced: every call still reaches the real filesystem, and the
// tests can count the fsyncs and reads a save costs. The shared test setup
// has already loaded atomic.ts (through config.ts) against the real module,
// so load a fresh copy that sees the spies.
vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });
vi.resetModules();
const spied = await import("node:fs");
const spiedPromises = await import("node:fs/promises");
const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
const { appendLine, flushWritesBehind, OwnedFile, removeDeadTempFiles, renameWithRetry, writeFileAtomic, writeFileAtomicIfChanged, writesBehindSettled } =
  await import("./atomic.ts");

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    chmodSync(p, 0o644);

    writeFileAtomic(p, "new", { mode: 0o600 });

    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

// fsync is F_FULLFSYNC on macOS (~4 ms of blocked event loop), and several per-turn saves rewrite identical bytes.
describe("writeFileAtomic durability", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
    vi.mocked(spied.fsyncSync).mockClear();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fsyncs by default", () => {
    writeFileAtomic(join(dir, "x.json"), "a");
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("still replaces atomically without the fsync when durable is false", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old");
    vi.mocked(spied.fsyncSync).mockClear();
    writeFileAtomic(p, "new", { durable: false });
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});

describe("writeFileAtomicIfChanged", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const clearSpies = () => {
    vi.mocked(spied.fsyncSync).mockClear();
    vi.mocked(spied.readFileSync).mockClear();
  };

  it("leaves the file alone when it already holds exactly these bytes", () => {
    const p = join(dir, "x.json");
    const data = JSON.stringify({ msg: "café — 日本語" });
    writeFileAtomic(p, data, { mode: 0o600 });
    const before = statSync(p);
    clearSpies();

    expect(writeFileAtomicIfChanged(p, data, { mode: 0o600 })).toBe(false);

    const after = statSync(p);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("writes and fsyncs when the bytes differ", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"unread":true}');
    clearSpies();
    // Same length, different bytes: only the read can tell.
    expect(writeFileAtomicIfChanged(p, '{"unread":fals}')).toBe(true);
    expect(readFileSync(p, "utf8")).toBe('{"unread":fals}');
    expect(spied.fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("does not read the old contents when the size already differs", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "short");
    clearSpies();
    expect(writeFileAtomicIfChanged(p, "a longer replacement")).toBe(true);
    expect(spied.readFileSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("a longer replacement");
  });

  it("writes a file that does not exist yet", () => {
    const p = join(dir, "new.json");
    expect(writeFileAtomicIfChanged(p, "fresh", { mode: 0o600 })).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("fresh");
  });

  it("passes durable through to the write", () => {
    const p = join(dir, "x.json");
    clearSpies();
    writeFileAtomicIfChanged(p, "token", { durable: false });
    expect(spied.fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(p, "utf8")).toBe("token");
  });

  it.skipIf(process.platform === "win32")("rewrites identical bytes whose permissions are broader than requested", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "same");
    chmodSync(p, 0o644);
    expect(writeFileAtomicIfChanged(p, "same", { mode: 0o600 })).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("replaces a symlink holding identical bytes instead of following it", () => {
    const target = join(dir, "elsewhere.json");
    const p = join(dir, "x.json");
    writeFileSync(target, "same");
    symlinkSync(target, p);
    expect(writeFileAtomicIfChanged(p, "same")).toBe(true);
    expect(lstatSync(p).isSymbolicLink()).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("same");
    expect(readFileSync(target, "utf8")).toBe("same");
  });

  it.skipIf(process.platform === "win32")("does not hang on a FIFO planted at the path", () => {
    const p = join(dir, "x.json");
    execFileSync("mkfifo", [p]);
    expect(writeFileAtomicIfChanged(p, "data")).toBe(true);
    expect(lstatSync(p).isFile()).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("data");
  });

  it("still fails like writeFileAtomic when the path cannot be replaced", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomicIfChanged(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

// Windows refuses a rename onto a path while a virus scanner or the indexer holds a handle for a few milliseconds.
describe("renameWithRetry", () => {
  function failing(times: number, code: string) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      rename: () => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
      },
    };
  }

  it("survives a transient EPERM instead of losing the write", () => {
    const stub = failing(3, "EPERM");
    expect(() => renameWithRetry("a.tmp", "a", stub.rename)).not.toThrow();
    expect(stub.calls).toBe(4);
  });

  it("retries EACCES and EBUSY the same way", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const stub = failing(1, code);
      expect(() => renameWithRetry("a.tmp", "a", stub.rename)).not.toThrow();
      expect(stub.calls).toBe(2);
    }
  });

  it("gives up rather than retrying forever", () => {
    const stub = failing(Number.MAX_SAFE_INTEGER, "EPERM");
    expect(() => renameWithRetry("a.tmp", "a", stub.rename)).toThrow(/EPERM/);
    expect(stub.calls).toBe(6); // first attempt plus five backoffs
  });

  it("does not retry an error that will never clear", () => {
    // Busy-waiting on a missing directory or a cross-device rename would hide
    // a real bug behind a delay and still fail.
    for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
      const stub = failing(Number.MAX_SAFE_INTEGER, code);
      expect(() => renameWithRetry("a.tmp", "a", stub.rename)).toThrow(new RegExp(code));
      expect(stub.calls).toBe(1);
    }
  });
});

describe("removeDeadTempFiles", () => {
  const uuid = "0b9c3a52-7d1e-4f6a-9b2c-5e8d1a3f7c60";
  const deadPid = 4_000_001;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const touch = (name: string) => writeFileSync(join(dir, name), "{}");
  const gone = (pid: number) => pid === deadPid;

  it("removes the temp file of a process that is gone and keeps the file itself", () => {
    touch("bots.json");
    touch(`bots.json.${deadPid}.${uuid}.tmp`);

    expect(removeDeadTempFiles(dir, ["bots.json"], (pid) => !gone(pid))).toEqual([`bots.json.${deadPid}.${uuid}.tmp`]);
    expect(readdirSync(dir)).toEqual(["bots.json"]);
  });

  it("keeps the temp file of a live process and of this process", () => {
    const live = `bots.json.4000002.${uuid}.tmp`;
    const mine = `bots.json.${process.pid}.${uuid}.tmp`;
    touch(live);
    touch(mine);

    expect(removeDeadTempFiles(dir, ["bots.json"], (pid) => pid !== deadPid)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([live, mine].sort());
  });

  it("leaves other files, other names and anything that is not a regular file", () => {
    const others = [`groups.json.${deadPid}.${uuid}.tmp`, `bots.json.${deadPid}.tmp`, `bots.json.${deadPid}.${uuid}.tmp.bak`, `notes.${deadPid}.${uuid}.tmp`];
    others.forEach(touch);
    mkdirSync(join(dir, `bots.json.${deadPid}.${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}.tmp`));

    expect(removeDeadTempFiles(dir, ["bots.json"], () => false)).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(others.length + 1);
  });

  it("handles every name it is given, and a folder that is not there", () => {
    touch(`bots.json.${deadPid}.${uuid}.tmp`);
    touch(`groups.json.${deadPid}.${uuid}.tmp`);

    expect(removeDeadTempFiles(dir, ["bots.json", "groups.json"], () => false)).toHaveLength(2);
    expect(removeDeadTempFiles(join(dir, "missing"), ["bots.json"], () => false)).toEqual([]);
  });

  it("says a process that cannot be asked about is alive, as EPERM does", () => {
    touch(`bots.json.${deadPid}.${uuid}.tmp`);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      expect(removeDeadTempFiles(dir, ["bots.json"])).toEqual([]);
      kill.mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      expect(removeDeadTempFiles(dir, ["bots.json"])).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });
});

// A chat turn's bookkeeping is written behind (server/registry-store.ts): the text is taken whole at the end of a pass and
// lands, synced, a moment later while the server goes on. What must never happen: a torn file, an older text over a newer
// one, or a pass's text lost at an exit that runs handlers.
describe("OwnedFile writes behind", () => {
  let dir: string, p: string;
  /** The syncs of temp files written behind, which run on libuv's thread pool, not through fsyncSync. */
  let syncs = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
    p = join(dir, "x.json");
    vi.mocked(spied.renameSync).mockClear();
    syncs = 0;
    vi.mocked(spiedPromises.open).mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = () => {
        syncs += 1;
        return sync();
      };
      return handle;
    });
  });
  afterEach(async () => {
    await writesBehindSettled();
    vi.mocked(spiedPromises.open).mockImplementation(realOpen);
    rmSync(dir, { recursive: true, force: true });
  });
  const behind = (file: InstanceType<typeof OwnedFile>, text: string) => file.deferWrites(() => file.write(text));

  it("keeps the whole old file until the new text lands, synced, with no temp file left", async () => {
    const file = new OwnedFile(p, { mode: 0o600 });
    file.write("old");
    vi.mocked(spied.fsyncSync).mockClear();
    behind(file, "new");
    expect(readFileSync(p, "utf8"), "the call returns before the write").toBe("old");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["x.json"]);
    expect(spied.fsyncSync, "the fsync ran off the event loop").not.toHaveBeenCalled();
    expect(syncs).toBe(1);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("writes the newest of the texts asked for while one is on its way, once", async () => {
    const file = new OwnedFile(p);
    behind(file, "1");
    behind(file, "2");
    behind(file, "3");
    behind(file, "3");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8")).toBe("3");
    expect(spied.renameSync).toHaveBeenCalledTimes(2);
    behind(file, "3");
    expect(file.running, "the text on disk is not written again").toBeUndefined();
  });

  it("never lands an older text over a synchronous write made after it", async () => {
    const file = new OwnedFile(p);
    file.write("a");
    behind(file, "b");
    behind(file, "c");
    file.write("d");
    expect(readFileSync(p, "utf8")).toBe("d");
    flushWritesBehind(p);
    expect(readFileSync(p, "utf8"), "an exit or a load does not bring the older text back").toBe("d");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8")).toBe("d");
    expect(readdirSync(dir)).toEqual(["x.json"]);
    file.write("a");
    behind(file, "b");
    file.write("a");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8"), "the same text written again still wins").toBe("a");
  });

  it("writes the newest text at once when flushed, as an exit and a fresh load do", async () => {
    const file = new OwnedFile(p);
    file.write("a");
    behind(file, "b");
    behind(file, "c");
    flushWritesBehind(join(dir, "other.json"));
    expect(readFileSync(p, "utf8"), "another file's flush leaves this one").toBe("a");
    flushWritesBehind(p);
    expect(readFileSync(p, "utf8")).toBe("c");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8")).toBe("c");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("leaves the old file whole when a write fails, and tries it again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const file = new OwnedFile(p);
      file.write("old");
      vi.mocked(spied.renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
      });
      behind(file, "new");
      await writesBehindSettled();
      expect(readFileSync(p, "utf8")).toBe("old");
      expect(readdirSync(dir)).toEqual(["x.json"]);
      expect(error).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await writesBehindSettled();
      expect(readFileSync(p, "utf8")).toBe("new");
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });

  it("skips the fsync when durable is false", async () => {
    behind(new OwnedFile(p, { durable: false }), "x");
    await writesBehindSettled();
    expect(readFileSync(p, "utf8")).toBe("x");
    expect(syncs).toBe(0);
  });

  it.skipIf(process.platform === "win32")("finishes at an exit, a fatal one too, and a kill leaves the old file whole", () => {
    const child = join(dir, "child.mjs");
    writeFileSync(child, `
      const { OwnedFile } = await import(process.argv[2]);
      const [, , , path, how] = process.argv;
      const file = new OwnedFile(path, { mode: 0o600 });
      file.write("old");
      file.deferWrites(() => file.write("new"));
      if (how === "kill") process.kill(process.pid, "SIGKILL");
      else if (how === "throw") setImmediate(() => { throw new Error("boom"); });
      else process.exit(Number(how));
    `);
    const run = (how: string) => {
      const out = join(dir, `${how}.json`);
      try {
        execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", child, new URL("./atomic.ts", import.meta.url).href, out, how], { stdio: "ignore" });
      } catch {
      }
      return out;
    };
    for (const how of ["0", "1", "70", "throw"]) expect(readFileSync(run(how), "utf8"), `exit ${how}`).toBe("new");
    const killed = run("kill");
    expect(readFileSync(killed, "utf8")).toBe("old");
    // An exit leaves the temp file of the write that was on its way; the next start removes it.
    removeDeadTempFiles(dir, ["0.json", "1.json", "70.json", "throw.json", "kill.json"]);
    expect(readdirSync(dir).sort()).toEqual(["0.json", "1.json", "70.json", "child.mjs", "kill.json", "throw.json"]);
  });
});

describe("appendLine", () => {
  let dir: string, p: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-atomic-"));
    p = join(dir, "log.md");
  });
  afterEach(async () => {
    await writesBehindSettled();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("adds the line in place, after a newline the file lacked, owner-only", async () => {
    expect(appendLine(p, "- one", 0o600)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("- one\n");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    writeFileSync(p, "- one\n- two");
    chmodSync(p, 0o644);
    const inode = statSync(p).ino;
    expect(appendLine(p, "- three", 0o600)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("- one\n- two\n- three\n");
    expect(statSync(p).ino, "the file is not replaced").toBe(inode);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    await writesBehindSettled();
    expect(readdirSync(dir)).toEqual(["log.md"]);
  });

  it.skipIf(process.platform === "win32")("refuses a link, a second name or a FIFO, and changes nothing", () => {
    const target = join(dir, "target.md");
    writeFileSync(target, "- kept\n");
    symlinkSync(target, p);
    expect(appendLine(p, "- no", 0o600)).toBe(false);
    rmSync(p);
    linkSync(target, p);
    expect(appendLine(p, "- no", 0o600)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("- kept\n");
    rmSync(p);
    execFileSync("mkfifo", [p]);
    expect(appendLine(p, "- no", 0o600)).toBe(false);
    expect(lstatSync(p).isFIFO()).toBe(true);
  });

  it.runIf(process.platform === "win32")("leaves Windows to the whole-file write", () => {
    expect(appendLine(p, "- one", 0o600)).toBe(false);
    expect(existsSync(p)).toBe(false);
  });
});
