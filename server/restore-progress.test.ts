import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { beginRestoreBeat, endRestoreBeat, restoreBeat, restoreInProgress } from "./restore-progress.ts";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seira-restore-progress-"));
  mkdirSync(join(dir, ".backups"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  endRestoreBeat();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restore progress marker", () => {
  it("is fresh while a restore beats and gone when it ends", () => {
    const dir = dataDir();
    expect(restoreInProgress(dir)).toBe(false);
    beginRestoreBeat(dir);
    expect(restoreInProgress(dir)).toBe(true);
    endRestoreBeat();
    expect(restoreInProgress(dir)).toBe(false);
    expect(existsSync(join(dir, ".backups", "restore-progress"))).toBe(false);
  });

  it("goes stale when the server that wrote it died", () => {
    const dir = dataDir();
    beginRestoreBeat(dir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".backups", "restore-progress"), old, old);
    expect(restoreInProgress(dir)).toBe(false);
  });

  it("writes at most once every two seconds and writes again after that", () => {
    const dir = dataDir();
    let now = 1_000_000;
    beginRestoreBeat(dir);
    const file = join(dir, ".backups", "restore-progress");
    const first = readFileSync(file, "utf8");
    restoreBeat(() => now);
    const second = readFileSync(file, "utf8");
    restoreBeat(() => now + 500);
    expect(readFileSync(file, "utf8")).toBe(second);
    restoreBeat(() => now + 3_000);
    expect(readFileSync(file, "utf8")).not.toBe(second);
    expect(second).not.toBe(first);
  });

  it("does nothing outside a restore", () => {
    const dir = dataDir();
    restoreBeat();
    expect(restoreInProgress(dir)).toBe(false);
  });
});
