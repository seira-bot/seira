import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { STALE_TEST_DIR_MS, removeRunTestDirs, sweepStaleTestDirs } from "./stale-test-dirs.ts";
import { TEST_HOME_PREFIX, TEST_TMP_PREFIX } from "./test-tmp.ts";

const HOUR = 60 * 60 * 1000;

/** A folder in `base` whose mtime is `ageMs` before `now`. */
function folder(base: string, name: string, now: number, ageMs: number): string {
  const path = join(base, name);
  mkdirSync(path);
  const when = new Date(now - ageMs);
  utimesSync(path, when, when);
  return path;
}

function fixture() {
  // The setup file already moved tmpdir() into a folder that this file deletes at the end.
  const base = mkdtempSync(join(tmpdir(), "sweep-base-"));
  return { base, now: Date.now() };
}

describe("sweepStaleTestDirs", () => {
  it("deletes an old folder of the suite and keeps a new one", () => {
    const { base, now } = fixture();
    const oldHome = folder(base, `${TEST_HOME_PREFIX}old`, now, 5 * HOUR);
    const oldTmp = folder(base, `${TEST_TMP_PREFIX}old`, now, 5 * HOUR);
    const newHome = folder(base, `${TEST_HOME_PREFIX}new`, now, HOUR);
    const newTmp = folder(base, `${TEST_TMP_PREFIX}new`, now, 60_000);

    const result = sweepStaleTestDirs(base, { now });

    expect(result.removed.sort()).toEqual([oldHome, oldTmp].sort());
    expect(result.failed).toEqual([]);
    expect(existsSync(oldHome)).toBe(false);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(newHome)).toBe(true);
    expect(existsSync(newTmp)).toBe(true);
  });

  it("deletes the content of an old folder, not only the folder", () => {
    const { base, now } = fixture();
    const old = folder(base, `${TEST_HOME_PREFIX}full`, now, 5 * HOUR);
    mkdirSync(join(old, ".openmausbot", "deep"), { recursive: true });
    writeFileSync(join(old, ".openmausbot", "deep", "file.txt"), "x");
    // Writing into the folder moves its mtime: put it back so it is old again.
    const when = new Date(now - 5 * HOUR);
    utimesSync(old, when, when);

    sweepStaleTestDirs(base, { now });

    expect(existsSync(old)).toBe(false);
  });

  it("keeps a folder that the suite did not make, however old", () => {
    const { base, now } = fixture();
    const kept = [
      folder(base, "omb-companion-origin-abc", now, 48 * HOUR),
      folder(base, "omb-ssh-1000-abc", now, 48 * HOUR),
      folder(base, "omb-box-check-abc", now, 48 * HOUR),
      folder(base, "omb-muse-models-abc", now, 48 * HOUR),
      folder(base, "other-dir", now, 48 * HOUR),
      folder(base, `x${TEST_HOME_PREFIX}abc`, now, 48 * HOUR),
    ];

    const result = sweepStaleTestDirs(base, { now });

    expect(result.removed).toEqual([]);
    for (const path of kept) expect(existsSync(path)).toBe(true);
  });

  it("keeps a file or a link with the name of a folder of the suite", () => {
    const { base, now } = fixture();
    const target = folder(base, "target-dir", now, 48 * HOUR);
    const file = join(base, `${TEST_TMP_PREFIX}file`);
    writeFileSync(file, "x");
    const link = join(base, `${TEST_HOME_PREFIX}link`);
    symlinkSync(target, link);
    const old = new Date(now - 48 * HOUR);
    utimesSync(file, old, old);

    const result = sweepStaleTestDirs(base, { now });

    expect(result.removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("uses an age of 4 hours: 1 ms short stays, exactly 4 hours goes", () => {
    const { base, now } = fixture();
    const shortOfIt = folder(base, `${TEST_TMP_PREFIX}short`, now, STALE_TEST_DIR_MS - 1);
    const exact = folder(base, `${TEST_TMP_PREFIX}exact`, now, STALE_TEST_DIR_MS);

    const result = sweepStaleTestDirs(base, { now });

    expect(result.removed).toEqual([exact]);
    expect(existsSync(shortOfIt)).toBe(true);
  });

  it("keeps a folder of another user", () => {
    const { base, now } = fixture();
    const theirs = folder(base, `${TEST_HOME_PREFIX}theirs`, now, 48 * HOUR);
    const owner = process.getuid?.();
    // A host without uid (Windows) skips the owner check by design.
    if (owner === undefined) return;

    // Ask for a user that is not the owner of the folder.
    const result = sweepStaleTestDirs(base, { now, uid: owner + 1 });

    expect(result.removed).toEqual([]);
    expect(existsSync(theirs)).toBe(true);
  });

  it("reports a folder that it cannot delete and still deletes the others", () => {
    const { base, now } = fixture();
    const stuck = folder(base, `${TEST_TMP_PREFIX}stuck`, now, 5 * HOUR);
    const free = folder(base, `${TEST_TMP_PREFIX}free`, now, 5 * HOUR);

    const result = sweepStaleTestDirs(base, {
      now,
      remove: (path) => {
        if (path === stuck) throw new Error("EBUSY: resource busy");
      },
    });

    expect(result.removed).toEqual([free]);
    expect(result.failed).toEqual([{ path: stuck, reason: "EBUSY: resource busy" }]);
  });

  it("returns nothing for a folder that does not exist", () => {
    const { base } = fixture();
    expect(sweepStaleTestDirs(join(base, "missing"))).toEqual({ removed: [], failed: [] });
  });
});

describe("removeRunTestDirs", () => {
  it("deletes the folders of the run, new or old, with their content", () => {
    const { base, now } = fixture();
    const fresh = folder(base, `${TEST_TMP_PREFIX}a1b2c3-fresh1`, now, 0);
    const old = folder(base, `${TEST_TMP_PREFIX}a1b2c3-old001`, now, 9 * HOUR);
    mkdirSync(join(fresh, `${TEST_HOME_PREFIX}inner`, ".openmausbot"), { recursive: true });
    writeFileSync(join(fresh, `${TEST_HOME_PREFIX}inner`, ".openmausbot", "file.txt"), "x");

    const result = removeRunTestDirs("a1b2c3", base);

    expect(result.removed.sort()).toEqual([fresh, old].sort());
    expect(result.failed).toEqual([]);
    expect(existsSync(fresh)).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  it("keeps the folders of another run, a folder without a run id, and other omb-* folders", () => {
    const { base, now } = fixture();
    const kept = [
      folder(base, `${TEST_TMP_PREFIX}d4e5f6-other1`, now, 0),
      folder(base, `${TEST_TMP_PREFIX}a1b2c3d-longer`, now, 0),
      folder(base, `${TEST_TMP_PREFIX}plain1`, now, 0),
      folder(base, `${TEST_HOME_PREFIX}a1b2c3-home01`, now, 0),
      folder(base, "omb-ssh-1000-0123456789ab", now, 0),
    ];

    expect(removeRunTestDirs("a1b2c3", base)).toEqual({ removed: [], failed: [] });
    for (const path of kept) expect(existsSync(path)).toBe(true);
  });

  it("keeps a file or a link with the name of a folder of the run", () => {
    const { base, now } = fixture();
    const target = folder(base, "target", now, 0);
    const file = join(base, `${TEST_TMP_PREFIX}a1b2c3-file01`);
    const link = join(base, `${TEST_TMP_PREFIX}a1b2c3-link01`);
    writeFileSync(file, "x");
    symlinkSync(target, link);

    expect(removeRunTestDirs("a1b2c3", base).removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("keeps a folder of another user", () => {
    const { base, now } = fixture();
    const other = folder(base, `${TEST_TMP_PREFIX}a1b2c3-other2`, now, 0);

    const result = removeRunTestDirs("a1b2c3", base, { uid: (process.getuid?.() ?? 0) + 1 });

    expect(result.removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });

  it("reports a folder that it cannot delete and still deletes the others", () => {
    const { base, now } = fixture();
    const stuck = folder(base, `${TEST_TMP_PREFIX}a1b2c3-stuck1`, now, 0);
    const free = folder(base, `${TEST_TMP_PREFIX}a1b2c3-free01`, now, 0);

    const result = removeRunTestDirs("a1b2c3", base, {
      remove: (path) => {
        if (path === stuck) throw new Error("EBUSY: resource busy");
      },
    });

    expect(result.removed).toEqual([free]);
    expect(result.failed).toEqual([{ path: stuck, reason: "EBUSY: resource busy" }]);
  });

  it("returns nothing for a folder that does not exist", () => {
    const { base } = fixture();
    expect(removeRunTestDirs("a1b2c3", join(base, "missing"))).toEqual({ removed: [], failed: [] });
  });
});
