// One lock for every writer of who may sign in and who holds a place: the server, `seira access` and every save of
// config.json. A writer reads, changes and writes under it, so no other process can write between the read and the write.
import { join } from "node:path";

import { ensurePrivateDir } from "./data-dir.ts";
import { withFileLock, type FileLockOptions } from "./file-lock.ts";

export const PEOPLE_LOCK_FILE = "sign-in-people.lock";

export function withDataLock<T>(dataDir: string, run: () => T, options?: FileLockOptions): T {
  ensurePrivateDir(dataDir);
  return withFileLock(join(dataDir, PEOPLE_LOCK_FILE), run, options);
}
