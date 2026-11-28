import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import sweepOldTestFolders from "./global-setup.ts";
import { TEST_RUN_ID_VARIABLE, TEST_TMP_PREFIX, testTmpRoot } from "./test-tmp.ts";

describe("global setup", () => {
  it("gives the run an id, and its teardown deletes the folders of that run, also one that a skipped file left", () => {
    const saved = process.env[TEST_RUN_ID_VARIABLE];
    let otherRun: string | undefined;
    try {
      const teardown = sweepOldTestFolders();
      const runId = process.env[TEST_RUN_ID_VARIABLE];
      expect(runId).toMatch(/^[0-9a-f]{6}$/);
      expect(runId).not.toBe(saved);

      // What a worker leaves when every test of its file is skipped: the folder and the home inside it.
      const left = mkdtempSync(join(testTmpRoot(), `${TEST_TMP_PREFIX}${runId}-`));
      mkdirSync(join(left, "seira-test-home-inner"));
      writeFileSync(join(left, "seira-test-home-inner", "file.txt"), "x");
      otherRun = mkdtempSync(join(testTmpRoot(), `${TEST_TMP_PREFIX}ffffff-`));

      teardown();

      expect(existsSync(left)).toBe(false);
      expect(existsSync(otherRun)).toBe(true);
      expect(process.env[TEST_RUN_ID_VARIABLE]).toBeUndefined();
    } finally {
      if (otherRun) rmSync(otherRun, { recursive: true, force: true });
      if (saved === undefined) delete process.env[TEST_RUN_ID_VARIABLE];
      else process.env[TEST_RUN_ID_VARIABLE] = saved;
    }
  });

  it("gives another id to each run", () => {
    const saved = process.env[TEST_RUN_ID_VARIABLE];
    try {
      const first = sweepOldTestFolders();
      const firstId = process.env[TEST_RUN_ID_VARIABLE];
      first();
      const second = sweepOldTestFolders();
      const secondId = process.env[TEST_RUN_ID_VARIABLE];
      second();
      expect(firstId).not.toBe(secondId);
    } finally {
      if (saved === undefined) delete process.env[TEST_RUN_ID_VARIABLE];
      else process.env[TEST_RUN_ID_VARIABLE] = saved;
    }
  });
});
