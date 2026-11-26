// Real processes against one lock file: they take turns to add one to a counter that nothing else protects. A lock that two
// processes hold at once, or that a waiter takes from a live holder, loses an add. One process ends while it holds the lock,
// and the others take the lock over from it all at the same time.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

const CHILD = fileURLToPath(new URL("./testing/file-lock-child.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function run(lock: string, counter: string, rounds: number, crashAt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, lock, counter, String(rounds), String(crashAt)], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
  });
}

describe.skipIf(process.platform === "win32")("a lock held by more than one process", () => {
  it("never lets two processes in, and recovers when the holder ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-lock-race-"));
    dirs.push(dir);
    const counter = join(dir, "counter");
    writeFileSync(counter, "0");
    const rounds = 40;
    const crashAt = 10;
    await Promise.all([run(join(dir, "x.lock"), counter, rounds, -1), run(join(dir, "x.lock"), counter, rounds, -1), run(join(dir, "x.lock"), counter, rounds, -1), run(join(dir, "x.lock"), counter, rounds, -1), run(join(dir, "x.lock"), counter, rounds, crashAt)]);
    expect(Number(readFileSync(counter, "utf8"))).toBe(4 * rounds + crashAt + 1);
  }, 60_000);
});
