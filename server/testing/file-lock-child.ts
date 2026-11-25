// One process of server/file-lock-race.test.ts. It takes the lock round after round and adds one to a counter that it reads
// and writes with no other protection. With `crashAt`, it ends while it holds the lock, as a crashed process would.
// Arguments: lock file, counter file, rounds, crashAt (-1 for never). The lock goes stale after 25 ms.
import { readFileSync, writeFileSync } from "node:fs";

import { acquireFileLock } from "../file-lock.ts";

const [lockFile, counter, rounds, crashAt] = process.argv.slice(2).map(String);
for (let round = 0; round < Number(rounds); round += 1) {
  const release = acquireFileLock(String(lockFile), { staleMs: 25, waitMs: 30_000 });
  const count = Number(readFileSync(String(counter), "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, round % 7 === 0 ? 40 : 1);
  writeFileSync(String(counter), String(count + 1));
  if (round === Number(crashAt)) process.exit(0);
  release();
}
