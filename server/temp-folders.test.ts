import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  makeOwnedTempFolder,
  ORPHAN_MIN_AGE_MS,
  releaseOwnedTempFolder,
  removeOwnedTempFolder,
  sweepOrphanedTempFolders,
} from "./temp-folders.ts";

const PREFIX = "omb-sweep-check-";
const DEAD = 2_147_483_000;
const MINUTE = 60 * 1000;

/** A folder in `base` whose mtime is `ageMs` before `now`. */
function folder(base: string, name: string, now: number, ageMs: number): string {
  const path = join(base, name);
  mkdirSync(path);
  const when = new Date(now - ageMs);
  utimesSync(path, when, when);
  return path;
}

function fixture() {
  // The setup file moved tmpdir() into a folder that this file deletes at the end.
  return { base: mkdtempSync(join(tmpdir(), "sweep-base-")), now: Date.now() };
}

describe("makeOwnedTempFolder", () => {
  it("makes a folder in tmpdir() whose name carries the id of this process", () => {
    const path = makeOwnedTempFolder(PREFIX);
    expect(path.startsWith(tmpdir() + sep)).toBe(true);
    expect(basename(path)).toMatch(new RegExp(`^${PREFIX}${process.pid}-[A-Za-z0-9]{6}$`));
    expect(existsSync(path)).toBe(true);
    releaseOwnedTempFolder(path);
  });

  it("removes the folder when the process exits, and not a folder that the caller released", () => {
    const script = fileURLToPath(new URL("./testing/exit-owned-folder.mjs", import.meta.url));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", script], { encoding: "utf8", env: process.env });
    expect(run.status, run.stderr).toBe(0);
    const { kept, released, removed } = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as { kept: string; released: string; removed: string };
    expect(existsSync(kept)).toBe(false);
    // The caller took charge of this one, so it is still there after the exit.
    expect(existsSync(released)).toBe(true);
    // The caller removed this one with the helper and someone else made a folder at its path: the hook leaves that folder.
    expect(existsSync(removed)).toBe(true);
  });
});

describe("removeOwnedTempFolder", () => {
  it("removes the folder with its content, and says so", () => {
    const path = makeOwnedTempFolder(PREFIX);
    mkdirSync(join(path, "deep"));
    writeFileSync(join(path, "deep", "mcp.json"), "{}");

    expect(removeOwnedTempFolder(path)).toBe(true);

    expect(existsSync(path)).toBe(false);
  });

  it("accepts a folder that is already gone", () => {
    const path = makeOwnedTempFolder(PREFIX);
    expect(removeOwnedTempFolder(path)).toBe(true);
    expect(removeOwnedTempFolder(path)).toBe(true);
  });
});

describe("sweepOrphanedTempFolders", () => {
  const dead = () => false;

  it("removes an old folder whose owner is gone, and keeps one whose owner runs", () => {
    const { base, now } = fixture();
    const gone = folder(base, `${PREFIX}${DEAD}-abc123`, now, 2 * ORPHAN_MIN_AGE_MS);
    const running = folder(base, `${PREFIX}${DEAD + 1}-abc123`, now, 2 * ORPHAN_MIN_AGE_MS);

    const result = sweepOrphanedTempFolders(PREFIX, { dir: base, now, isAlive: (pid) => pid === DEAD + 1 });

    expect(result.removed).toEqual([gone]);
    expect(result.failed).toEqual([]);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(running)).toBe(true);
  });

  it("removes the content of the folder, not only the folder", () => {
    const { base, now } = fixture();
    const old = folder(base, `${PREFIX}${DEAD}-full12`, now, 2 * ORPHAN_MIN_AGE_MS);
    mkdirSync(join(old, "deep"));
    writeFileSync(join(old, "deep", "file.json"), "{}");
    const when = new Date(now - 2 * ORPHAN_MIN_AGE_MS);
    utimesSync(old, when, when);

    sweepOrphanedTempFolders(PREFIX, { dir: base, now, isAlive: dead });

    expect(existsSync(old)).toBe(false);
  });

  it("keeps the folder of this process, whatever the liveness check says", () => {
    const { base, now } = fixture();
    const mine = folder(base, `${PREFIX}${process.pid}-mine12`, now, 2 * ORPHAN_MIN_AGE_MS);

    const result = sweepOrphanedTempFolders(PREFIX, { dir: base, now, isAlive: dead });

    expect(result.removed).toEqual([]);
    expect(existsSync(mine)).toBe(true);
  });

  it("uses an age of 10 minutes: 1 ms short stays, exactly 10 minutes goes", () => {
    const { base, now } = fixture();
    const shortOfIt = folder(base, `${PREFIX}${DEAD}-short1`, now, ORPHAN_MIN_AGE_MS - 1);
    const exact = folder(base, `${PREFIX}${DEAD}-exact1`, now, ORPHAN_MIN_AGE_MS);

    const result = sweepOrphanedTempFolders(PREFIX, { dir: base, now, isAlive: dead });

    expect(result.removed).toEqual([exact]);
    expect(existsSync(shortOfIt)).toBe(true);
  });

  it("keeps what is not a folder of this kind, however old", () => {
    const { base, now } = fixture();
    const target = folder(base, "target-dir", now, 48 * 60 * MINUTE);
    const file = join(base, `${PREFIX}${DEAD}-file12`);
    writeFileSync(file, "x");
    const link = join(base, `${PREFIX}${DEAD}-link12`);
    symlinkSync(target, link);
    const old = new Date(now - 48 * 60 * MINUTE);
    utimesSync(file, old, old);
    const kept = [
      folder(base, `${PREFIX}abc123`, now, 48 * 60 * MINUTE), // a name without an owner: an older version, or another tool
      folder(base, `${PREFIX}${DEAD}-toolong1`, now, 48 * 60 * MINUTE),
      folder(base, `x${PREFIX}${DEAD}-abc123`, now, 48 * 60 * MINUTE),
      folder(base, `omb-other-kind-${DEAD}-abc123`, now, 48 * 60 * MINUTE),
    ];

    const result = sweepOrphanedTempFolders(PREFIX, { dir: base, now, isAlive: dead });

    expect(result.removed).toEqual([]);
    for (const path of [file, link, target, ...kept]) expect(existsSync(path)).toBe(true);
  });

  it("keeps a folder of another user", () => {
    const { base, now } = fixture();
    const theirs = folder(base, `${PREFIX}${DEAD}-theirs`, now, 48 * 60 * MINUTE);
    const owner = process.getuid?.();
    // A host without user ids (Windows) skips the owner check by design.
    if (owner === undefined) return;

    const result = sweepOrphanedTempFolders(PREFIX, { dir: base, now, uid: owner + 1, isAlive: dead });

    expect(result.removed).toEqual([]);
    expect(existsSync(theirs)).toBe(true);
  });

  it("reports a folder that it cannot remove, and still removes the others", () => {
    const { base, now } = fixture();
    const stuck = folder(base, `${PREFIX}${DEAD}-stuck1`, now, 2 * ORPHAN_MIN_AGE_MS);
    const free = folder(base, `${PREFIX}${DEAD}-free12`, now, 2 * ORPHAN_MIN_AGE_MS);

    const result = sweepOrphanedTempFolders(PREFIX, {
      dir: base,
      now,
      isAlive: dead,
      remove: (path) => {
        if (path === stuck) throw new Error("EBUSY: resource busy");
      },
    });

    expect(result.removed).toEqual([free]);
    expect(result.failed).toEqual([{ path: stuck, reason: "EBUSY: resource busy" }]);
  });

  it.skipIf(process.platform === "win32")("treats a process that it cannot signal as running, and one that does not exist as gone", () => {
    const { base, now } = fixture();
    // Process 1 exists on every host that has one; a refused signal (EPERM) must not make it look gone.
    const init = folder(base, `${PREFIX}1-init12`, now, 2 * ORPHAN_MIN_AGE_MS);
    const none = folder(base, `${PREFIX}${DEAD}-none12`, now, 2 * ORPHAN_MIN_AGE_MS);

    sweepOrphanedTempFolders(PREFIX, { dir: base, now });

    expect(existsSync(init)).toBe(true);
    expect(existsSync(none)).toBe(false);
  });

  it("returns nothing for a folder that does not exist", () => {
    const { base } = fixture();
    expect(sweepOrphanedTempFolders(PREFIX, { dir: join(base, "missing") })).toEqual({ removed: [], failed: [] });
  });
});
