import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

  it("waits for a lock that another process holds and then gives up", () => {
    const file = lockFile();
    writeFileSync(file, "99999\n");
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(existsSync(file)).toBe(true);
  });

  it("takes over a lock that a crashed process left behind", () => {
    const file = lockFile();
    writeFileSync(file, "99999\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 10_000 });
    expect(existsSync(file)).toBe(true);
    release();
    expect(existsSync(file)).toBe(false);
  });
});
