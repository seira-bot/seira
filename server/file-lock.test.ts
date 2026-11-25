import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireFileLock, withFileLock } from "./file-lock.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "seira-lock-"));
  dirs.push(dir);
  return join(dir, "x.lock");
}

describe("a lock between processes", () => {
  it("is a file while it is held and gone when it is given back, and giving it back twice does nothing", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    expect(existsSync(file)).toBe(true);
    const again = acquireFileLock(file);
    release();
    expect(existsSync(file)).toBe(true);
    again();
    expect(existsSync(file)).toBe(false);
    release();
    again();
    expect(existsSync(file)).toBe(false);
  });

  it("gives the lock back when the work throws", () => {
    const file = lockFile();
    expect(() => withFileLock(file, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(file)).toBe(false);
  });

  it("waits for a lock that a live process holds and then gives up", () => {
    const file = lockFile();
    writeFileSync(file, `${process.ppid} - holder\n`);
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - holder\n`);
  });

  it("never takes a lock from a live process, however old the lock is", () => {
    const file = lockFile();
    writeFileSync(file, `${process.ppid} - holder\n`);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - holder\n`);
  });

  it("takes over an old lock whose holder is gone", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    ageOf(file, 60_000);
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 10_000 });
    expect(readFileSync(file, "utf8")).toContain(`${process.pid} `);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("does not take over a lock whose holder is gone until it is old", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toContain("holder");
  });

  it("takes over an old lock that names no holder", () => {
    const file = lockFile();
    writeFileSync(file, "");
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!existsSync("/proc/self/stat"))("treats a reused process id as a holder that is gone", () => {
    const file = lockFile();
    writeFileSync(file, `${process.pid} 1 holder\n`);
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a lock alone that another process holds when this process gives its own back", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    writeFileSync(file, `${process.ppid} - other\n`);
    release();
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - other\n`);
  });

  it("does not remove a lock while another process holds the takeover guard", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    ageOf(file, 60_000);
    writeFileSync(`${file}.takeover`, `${process.ppid} - guard\n`);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toContain("holder");
  });

  it("clears a takeover guard that a crashed process left behind", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    writeFileSync(`${file}.takeover`, `${gonePid()} - guard\n`);
    ageOf(file, 60_000);
    ageOf(`${file}.takeover`, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.takeover`)).toBe(false);
  });
});

function ageOf(file: string, ms: number): void {
  const old = new Date(Date.now() - ms);
  utimesSync(file, old, old);
}

/** The id of a process that has ended. */
function gonePid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no process id");
  return pid;
}
