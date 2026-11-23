import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { beginRestoreBeat, endRestoreBeat, restoreBeat, restoreInProgress, withRestoreBeat } from "./restore-progress.ts";

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
    beginRestoreBeat(dir);
    const file = join(dir, ".backups", "restore-progress");
    const first = readFileSync(file, "utf8");
    const at = Number(first);
    restoreBeat(() => at + 500);
    expect(readFileSync(file, "utf8")).toBe(first);
    restoreBeat(() => at + 3_000);
    expect(readFileSync(file, "utf8")).toBe(`${at + 3_000}\n`);
  });

  it("ends the beat when a restore fails, so a later backup copy does not look like a restore", () => {
    const dir = dataDir();
    expect(() => withRestoreBeat(dir, () => {
      expect(restoreInProgress(dir)).toBe(true);
      throw new Error("bad backup");
    })).toThrow("bad backup");
    expect(restoreInProgress(dir)).toBe(false);
    restoreBeat(() => Date.now() + 10_000);
    expect(existsSync(join(dir, ".backups", "restore-progress"))).toBe(false);
  });

  it("does nothing outside a restore", () => {
    const dir = dataDir();
    restoreBeat();
    expect(restoreInProgress(dir)).toBe(false);
  });
});
