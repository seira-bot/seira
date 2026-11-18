import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { TEST_HOME_PREFIX, TEST_RUN_ID_VARIABLE, TEST_TMP_PREFIX, testTmpPrefix, useTestTmp } from "./test-tmp.ts";

describe("the temp folder of a test file", () => {
  it("is a folder that the setup file made for this file", () => {
    expect(basename(tmpdir()).startsWith(TEST_TMP_PREFIX)).toBe(true);
    expect(existsSync(tmpdir())).toBe(true);
  });

  it("is the folder on every variable that tmpdir() reads", () => {
    for (const name of ["TMPDIR", "TEMP", "TMP"]) expect(process.env[name]).toBe(tmpdir());
  });

  it("carries the id that global setup gave to this run", () => {
    expect(process.env[TEST_RUN_ID_VARIABLE]).toMatch(/^[0-9a-f]{6}$/);
    expect(basename(tmpdir()).startsWith(testTmpPrefix())).toBe(true);
    expect(basename(tmpdir())).toMatch(new RegExp(`^${TEST_TMP_PREFIX}${process.env[TEST_RUN_ID_VARIABLE]}-`));
  });

  it("holds the throwaway home, and is not inside it", () => {
    expect(basename(homedir()).startsWith(TEST_HOME_PREFIX)).toBe(true);
    expect(homedir().startsWith(tmpdir() + sep)).toBe(true);
    expect(tmpdir().startsWith(homedir() + sep)).toBe(false);
  });

  it("holds the folders that the code under test makes with mkdtemp", () => {
    const made = mkdtempSync(join(tmpdir(), "omb-leak-check-"));
    expect(made.startsWith(tmpdir() + sep)).toBe(true);
  });
});

describe("useTestTmp", () => {
  it("moves tmpdir() into a new folder and puts it back on remove", async () => {
    const before = { tmpdir: tmpdir(), TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const scratch = useTestTmp();
    try {
      expect(tmpdir()).toBe(scratch.path);
      expect(scratch.path.startsWith(before.tmpdir + sep)).toBe(true);
      expect(basename(scratch.path).startsWith(TEST_TMP_PREFIX)).toBe(true);
      writeFileSync(join(scratch.path, "leftover.txt"), "x");
    } finally {
      await scratch.remove();
    }
    expect(existsSync(scratch.path)).toBe(false);
    expect(tmpdir()).toBe(before.tmpdir);
    expect({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual({
      TMPDIR: before.TMPDIR,
      TEMP: before.TEMP,
      TMP: before.TMP,
    });
  });

  it("removes a variable that was not set before", async () => {
    const saved = process.env.TMP;
    delete process.env.TMP;
    const scratch = useTestTmp();
    try {
      expect(process.env.TMP).toBe(scratch.path);
    } finally {
      await scratch.remove();
      if (saved !== undefined) process.env.TMP = saved;
    }
    // Checked after remove(): the variable is gone again, not set to the string "undefined".
    if (saved === undefined) expect(process.env.TMP).toBeUndefined();
  });
});

describe("testTmpPrefix", () => {
  it("adds the id of the run to the prefix, and uses the plain prefix without one", () => {
    expect(testTmpPrefix("a1b2c3")).toBe(`${TEST_TMP_PREFIX}a1b2c3-`);
    expect(testTmpPrefix("")).toBe(TEST_TMP_PREFIX);
  });

  it("names the folder of useTestTmp with the id of the run", async () => {
    const saved = process.env[TEST_RUN_ID_VARIABLE];
    process.env[TEST_RUN_ID_VARIABLE] = "a1b2c3";
    const scratch = useTestTmp();
    try {
      expect(basename(scratch.path).startsWith(`${TEST_TMP_PREFIX}a1b2c3-`)).toBe(true);
    } finally {
      await scratch.remove();
      if (saved === undefined) delete process.env[TEST_RUN_ID_VARIABLE];
      else process.env[TEST_RUN_ID_VARIABLE] = saved;
    }
  });

  it("names the folder with the plain prefix when no run id is set", async () => {
    const saved = process.env[TEST_RUN_ID_VARIABLE];
    delete process.env[TEST_RUN_ID_VARIABLE];
    const scratch = useTestTmp();
    try {
      expect(basename(scratch.path)).toMatch(new RegExp(`^${TEST_TMP_PREFIX}[A-Za-z0-9]{6}$`));
    } finally {
      await scratch.remove();
      if (saved !== undefined) process.env[TEST_RUN_ID_VARIABLE] = saved;
    }
  });
});
