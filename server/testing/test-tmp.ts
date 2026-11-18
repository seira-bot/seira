// One temp folder per test file for everything the test and the code under test put in tmpdir(): the file's
// afterAll deletes it, so no omb-* folder outlives the file. It sits in the real temp folder, not in the
// throwaway home, so paths keep the "under /tmp, not under $HOME" shape that product code and tests expect.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTempDir } from "./cleanup.ts";

/** Only the suite makes folders with these prefixes: the sweep in stale-test-dirs.ts deletes these and nothing else. */
export const TEST_HOME_PREFIX = "omb-test-home-";
export const TEST_TMP_PREFIX = "omb-test-tmp-";

// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows, each time it is called.
const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;

export interface TestTmp {
  path: string;
  /** Puts the variables back and deletes the folder. */
  remove(): Promise<void>;
}

export function useTestTmp(): TestTmp {
  const path = mkdtempSync(join(tmpdir(), TEST_TMP_PREFIX));
  const before = TEMP_VARIABLES.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_VARIABLES) process.env[name] = path;
  return {
    path,
    async remove() {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await removeTempDir(path);
    },
  };
}
