// A process of server/file-lock.test.ts that takes the lock and gives it back until another process kills it, so that it
// ends at any point of publishing or giving back. Argument: lock file. The lock goes stale after 25 ms.
import { acquireFileLock } from "../file-lock.ts";

const [lockFile] = process.argv.slice(2).map(String);
for (;;) acquireFileLock(String(lockFile), { staleMs: 25, waitMs: 30_000 })();
