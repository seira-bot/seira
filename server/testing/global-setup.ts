// Runs once per vitest run, before any test file; the function it returns runs once after the last one.
import { randomBytes } from "node:crypto";

import { removeRunTestDirs, sweepStaleTestDirs } from "./stale-test-dirs.ts";
import { TEST_RUN_ID_VARIABLE } from "./test-tmp.ts";

function warn(failed: ReadonlyArray<{ path: string; reason: string }>): void {
  for (const { path, reason } of failed) console.warn(`test cleanup could not remove ${path}: ${reason}`);
}

export default function sweepOldTestFolders(): () => void {
  warn(sweepStaleTestDirs().failed);
  // The workers start after this and inherit the id, which goes into the name of the folder of each test file.
  const runId = randomBytes(3).toString("hex");
  process.env[TEST_RUN_ID_VARIABLE] = runId;
  return () => {
    delete process.env[TEST_RUN_ID_VARIABLE];
    warn(removeRunTestDirs(runId).failed);
  };
}
