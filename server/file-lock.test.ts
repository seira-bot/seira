import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { acquireFileLock, claimOf, withFileLock } from "./file-lock.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const LOOP_CHILD = fileURLToPath(new URL("./testing/file-lock-loop-child.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "seira-lock-"));
  dirs.push(dir);
  return join(dir, "x.lock");
}

describe("a lock between processes", () => {
  it("is a file while it is held and gone when it is given back, and giving it back twice does nothing", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    expect(existsSync(file)).toBe(true);
    const again = acquireFileLock(file);
    release();
    expect(existsSync(file)).toBe(true);
    again();
    expect(existsSync(file)).toBe(false);
    release();
    again();
    expect(existsSync(file)).toBe(false);
  });

  it("gives the lock back when the work throws", () => {
    const file = lockFile();
    expect(() => withFileLock(file, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(file)).toBe(false);
  });

  it("waits for a lock that a live process holds and then gives up", () => {
    const file = lockFile();
    writeFileSync(file, `${process.ppid} - holder\n`);
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - holder\n`);
  });

  it("never takes a lock from a live process, however old the lock is", () => {
    const file = lockFile();
    writeFileSync(file, `${process.ppid} - holder\n`);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - holder\n`);
  });

  it("takes over an old lock whose holder is gone", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    ageOf(file, 60_000);
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 10_000 });
    expect(readFileSync(file, "utf8")).toContain(`${process.pid} `);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("does not take over a lock whose holder is gone until it is old", () => {
    const file = lockFile();
    writeFileSync(file, `${gonePid()} - holder\n`);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toContain("holder");
  });

  it("takes over an old lock that names no holder", () => {
    const file = lockFile();
    writeFileSync(file, "");
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!existsSync("/proc/self/stat"))("treats a reused process id as a holder that is gone", () => {
    const file = lockFile();
    writeFileSync(file, `${process.pid} 1 holder\n`);
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a lock alone that another process holds when this process gives its own back", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    writeFileSync(file, `${process.ppid} - other\n`);
    release();
    expect(readFileSync(file, "utf8")).toBe(`${process.ppid} - other\n`);
  });

  it("does not remove a stale lock while another process is removing a lock with the same text", () => {
    const file = lockFile();
    const text = `${gonePid()} - holder\n`;
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), `${process.ppid} - claim\n`);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("clears a claim that a crashed process left behind, then takes over the stale lock", () => {
    const file = lockFile();
    const text = `${gonePid()} - holder\n`;
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), `${gonePid()} - claim\n`);
    ageOf(claimOf(file, text), 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(claimOf(file, text))).toBe(false);
  });

  it("leaves no claim or temporary file after a take and a give back", () => {
    const file = lockFile();
    acquireFileLock(file)();
    expect(readdirSync(dirname(file))).toEqual([]);
  });
});

describe("publishing a lock", () => {
  it.skipIf(process.platform === "win32")("never shows a lock file without a full holder text, even to a process that reads it at every moment", () => {
    const file = lockFile();
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", LOOP_CHILD, file], { stdio: "ignore" });
    const seen = new Set<string>();
    const until = Date.now() + 1_500;
    while (Date.now() < until) {
      try {
        seen.add(readFileSync(file, "utf8"));
      } catch (error) {
        if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
      }
    }
    child.kill("SIGKILL");
    expect(seen.size).toBeGreaterThan(0);
    for (const text of seen) expect(text).toMatch(/^\d+ \S+ [0-9a-f-]{36}\n$/u);
  });

  it.skipIf(process.platform === "win32")("recovers within the wait after a process is killed at any point of taking or giving back the lock", async () => {
    const file = lockFile();
    for (let round = 0; round < 12; round += 1) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", LOOP_CHILD, file], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 150 + ((round * 37) % 90)));
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("close", resolve));
      const started = Date.now();
      acquireFileLock(file, { staleMs: 25, waitMs: 5_000 })();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(existsSync(file)).toBe(false);
    }
  }, 60_000);

  it("leaves no lock when the process ends after it wrote the temporary file and before it linked it", () => {
    const file = lockFile();
    writeFileSync(`${file}.${"0".repeat(8)}.tmp`, `${gonePid()} - half\n`);
    const release = acquireFileLock(file, { waitMs: 200 });
    expect(readFileSync(file, "utf8")).toContain(`${process.pid} `);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a complete lock when the process ends after it linked the file, and the next process takes it over", () => {
    const file = lockFile();
    const text = `${gonePid()} - holder\n`;
    writeFileSync(`${file}.${"1".repeat(8)}.tmp`, text);
    linkSync(`${file}.${"1".repeat(8)}.tmp`, file);
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });
});

describe("giving a lock back", () => {
  it("never removes a lock that another process took after this process was judged gone", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    const other = `${process.ppid} - other\n`;
    unlinkSync(file);
    writeFileSync(file, other);
    release();
    expect(readFileSync(file, "utf8")).toBe(other);
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith(".claim"))).toEqual([]);
  });

  it("does not remove the lock while another process holds the claim, and gives up when the wait ends", () => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 80, staleMs: 60_000 });
    const text = readFileSync(file, "utf8");
    writeFileSync(claimOf(file, text), `${process.ppid} - claim\n`);
    const started = Date.now();
    expect(() => release()).toThrow(/could not give back/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(file, "utf8")).toBe(text);
    unlinkSync(claimOf(file, text));
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("removes the lock after the claim of a crashed process is old", () => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 50 });
    const claim = claimOf(file, readFileSync(file, "utf8"));
    writeFileSync(claim, `${gonePid()} - claim\n`);
    ageOf(claim, 60_000);
    release();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(claim)).toBe(false);
  });
});

describe("a lock whose holder cannot be judged", () => {
  it("is not taken when the holder names no start time and the process exists", () => {
    const file = lockFile();
    writeFileSync(file, `${process.ppid} - holder\n`);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds/);
  });

  it("is not taken when the process is not ours to signal", () => {
    const file = lockFile();
    writeFileSync(file, `1 - holder\n`);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds/);
  });

  it("stops with an error, and quickly, when the lock cannot be read", () => {
    const file = lockFile();
    mkdirSync(file);
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 5_000 })).toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(statSync(file).isDirectory()).toBe(true);
  });
});

describe("the wait", () => {
  it("ends at the time asked, whatever state the lock is in", () => {
    for (const text of [`${process.ppid} - holder\n`, "", "garbage"]) {
      const file = lockFile();
      writeFileSync(file, text);
      const started = Date.now();
      expect(() => acquireFileLock(file, { waitMs: 100, staleMs: 3_600_000 })).toThrow(/another process holds/);
      expect(Date.now() - started).toBeLessThan(1_500);
    }
  });

  it("ends when a stale lock cannot be removed", () => {
    const file = lockFile();
    const text = `${gonePid()} - holder\n`;
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), `${process.ppid} - claim\n`);
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 100, staleMs: 10_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

function ageOf(file: string, ms: number): void {
  const old = new Date(Date.now() - ms);
  utimesSync(file, old, old);
}

/** The id of a process that has ended. */
function gonePid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no process id");
  return pid;
}
