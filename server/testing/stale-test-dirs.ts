// A run that is killed (out of memory, a memory limit, a dropped SSH session) never reaches its afterAll hooks and
// leaves its throwaway folders behind. Each run sweeps the old ones. Other omb-* folders are not ours to delete: the
// installed app keeps its sockets in omb-companion-origin-* and omb-ssh-* for longer than any run.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEST_HOME_PREFIX, TEST_TMP_PREFIX } from "./test-tmp.ts";

/** Longer than the longest full run, so a folder this old belongs to no run that is still going. */
export const STALE_TEST_DIR_MS = 4 * 60 * 60 * 1000;

export interface SweepOptions {
  now?: number;
  maxAgeMs?: number;
  /** The user whose folders are swept. Skipped on Windows, which has no uid. */
  uid?: number | undefined;
  remove?: (path: string) => void;
}

export interface SweepResult {
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
}

export function sweepStaleTestDirs(base: string = tmpdir(), options: SweepOptions = {}): SweepResult {
  const { now = Date.now(), maxAgeMs = STALE_TEST_DIR_MS, uid = process.getuid?.(), remove = (path) => rmSync(path, { recursive: true, force: true }) } = options;
  const result: SweepResult = { removed: [], failed: [] };
  let names: string[];
  try { names = readdirSync(base); } catch { return result; }

  for (const name of names) {
    if (!name.startsWith(TEST_HOME_PREFIX) && !name.startsWith(TEST_TMP_PREFIX)) continue;
    const path = join(base, name);
    try {
      // lstat: a symlink or a plain file with a matching name is not a folder this suite made.
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || now - stat.mtimeMs < maxAgeMs) continue;
      remove(path);
      result.removed.push(path);
    } catch (error) {
      result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
