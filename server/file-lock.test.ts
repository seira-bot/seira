import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireFileLock, claimOf, withFileLock } from "./file-lock.ts";
import { removeTempDir } from "./testing/cleanup.ts";

/** A complete holder text, as the lock writes it: process id, start time (or "-"), token, one line end. */
const TOKEN = "0b6f1c9e-3d4a-4b7e-8c21-5a9d0e7f6b34";
const ident = (pid: number, started = "-", token = TOKEN) => `${pid} ${started} ${token}\n`;
const LOOP_CHILD = fileURLToPath(new URL("./testing/file-lock-loop-child.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    writeFileSync(file, ident(process.ppid));
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(readFileSync(file, "utf8")).toBe(ident(process.ppid));
  });

  it("never takes a lock from a live process, however old the lock is", () => {
    const file = lockFile();
    writeFileSync(file, ident(process.ppid));
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(ident(process.ppid));
  });

  it("takes over an old lock whose holder is gone", () => {
    const file = lockFile();
    writeFileSync(file, ident(gonePid()));
    ageOf(file, 60_000);
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 10_000 });
    expect(readFileSync(file, "utf8")).toContain(`${process.pid} `);
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("does not take over a lock whose holder is gone until it is old", () => {
    const file = lockFile();
    writeFileSync(file, ident(gonePid()));
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 60_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toContain(TOKEN);
  });

  it.each(["", "garbage", "0 - x", "12 -\n"])("never takes an old lock that names no valid holder (%j), and says why", (text) => {
    const file = lockFile();
    writeFileSync(file, text);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds .*cannot be judged/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it.skipIf(!existsSync("/proc/self/stat"))("treats a reused process id as a holder that is gone", () => {
    const file = lockFile();
    writeFileSync(file, ident(process.pid, "1"));
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a lock alone that another process holds when this process gives its own back", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    writeFileSync(file, ident(process.ppid));
    release();
    expect(readFileSync(file, "utf8")).toBe(ident(process.ppid));
  });

  it("does not remove a stale lock while another process, alive, is removing a lock with the same text", () => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), ident(process.ppid));
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it.each(["", "garbage", "0 - x"])("does not remove a stale lock while the claim names no valid owner (%j): the claim is never cleared", (claimText) => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), claimText);
    ageOf(claimOf(file, text), 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readFileSync(claimOf(file, text), "utf8")).toBe(claimText);
  });

  it("takes over the stale lock when the owner of the claim is dead, with no wait for the claim to age, and leaves no claim", () => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), ident(gonePid()));
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 10_000 });
    expect(readFileSync(file, "utf8")).toContain(`${process.pid} `);
    release();
    expect(readdirSync(dirname(file))).toEqual([]);
  });

  it("uses the next claim slot after the dead owners of the earlier slots, and never removes their claim files while it works", () => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    for (const slot of [0, 1, 2]) writeFileSync(claimOf(file, text, slot), ident(gonePid()));
    writeFileSync(claimOf(file, text, 3), ident(process.ppid));
    expect(() => acquireFileLock(file, { waitMs: 80, staleMs: 10_000 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(text);
    for (const slot of [0, 1, 2, 3]) expect(existsSync(claimOf(file, text, slot))).toBe(true);
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
    const text = ident(gonePid());
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
    const other = ident(process.ppid);
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
    writeFileSync(claimOf(file, text), ident(process.ppid));
    const started = Date.now();
    expect(() => release()).toThrow(/could not give back/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(file, "utf8")).toBe(text);
    unlinkSync(claimOf(file, text));
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("removes the lock when the claim of a crashed process is in the way, and clears that claim", () => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 500, staleMs: 50 });
    const claim = claimOf(file, readFileSync(file, "utf8"));
    writeFileSync(claim, ident(gonePid()));
    release();
    expect(readdirSync(dirname(file))).toEqual([]);
  });

  it("does not remove the lock while the claim names an owner that cannot be judged", () => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 80, staleMs: 10 });
    const text = readFileSync(file, "utf8");
    writeFileSync(claimOf(file, text), "garbage");
    ageOf(claimOf(file, text), 3_600_000);
    expect(() => release()).toThrow(/could not give back/);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe("a lock whose holder cannot be judged", () => {
  it("is not taken when the holder names no start time and the process exists", () => {
    const file = lockFile();
    writeFileSync(file, ident(process.ppid));
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds/);
  });

  it("is not taken when the process is not ours to signal", () => {
    const file = lockFile();
    writeFileSync(file, ident(1));
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
    for (const text of [ident(process.ppid), "", "garbage"]) {
      const file = lockFile();
      writeFileSync(file, text);
      const started = Date.now();
      expect(() => acquireFileLock(file, { waitMs: 100, staleMs: 3_600_000 })).toThrow(/another process holds/);
      expect(Date.now() - started).toBeLessThan(1_500);
    }
  });

  it("ends when a stale lock cannot be removed", () => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), ident(process.ppid));
    const started = Date.now();
    expect(() => acquireFileLock(file, { waitMs: 100, staleMs: 10_000 })).toThrow(/another process holds/);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

/** Holder texts that look like the identity of a dead process to a loose reader, and are not the whole identity. */
function incompleteIdentities(gone: number): Array<[string, string]> {
  return [
    ["no line end", `${gone} - ${TOKEN}`],
    ["two line ends", `${ident(gone)}\n`],
    ["a carriage return", `${gone} - ${TOKEN}\r\n`],
    ["a leading space", ` ${ident(gone)}`],
    ["a double space", `${gone}  - ${TOKEN}\n`],
    ["an extra field", `${gone} - ${TOKEN} extra\n`],
    ["no token", `${gone} -\n`],
    ["a token cut short", `${gone} - ${TOKEN.slice(0, 20)}\n`],
    ["a token that is not a uuid", `${gone} - holder\n`],
    ["a token in capitals", ident(gone, "-", TOKEN.toUpperCase())],
    ["a start time that is not a number", ident(gone, "abc")],
    ["a negative start time", ident(gone, "-1")],
    ["a start time of 40 digits", ident(gone, "9".repeat(40))],
    ["a process id with a fraction", ident(gone).replace(`${gone} `, `${gone}.0 `)],
    ["a process id in hexadecimal", ident(gone).replace(`${gone} `, `0x${gone.toString(16)} `)],
    ["a process id with an exponent", ident(gone).replace(`${gone} `, `${gone}e0 `)],
    ["a process id with a sign", ident(gone).replace(`${gone} `, `+${gone} `)],
    ["a process id of zero", ident(0)],
    ["a process id that wraps to a live one", ident(2 ** 32 + gone)],
    ["a process id over the largest", ident(99_999_999_999)],
    ["a process id with a leading zero", ident(gone).replace(`${gone} `, `0${gone} `)],
    ["empty", ""],
    ["only spaces", "   \n"],
  ];
}

describe("a holder text that is not the whole identity", () => {
  const forms = incompleteIdentities(gonePid());

  it.each(forms)("is never judged dead as a lock holder: %s", (_name, text) => {
    const file = lockFile();
    writeFileSync(file, text);
    ageOf(file, 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds .*cannot be judged/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readdirSync(dirname(file))).toEqual(["x.lock"]);
  });

  it.each(forms)("is never judged dead as the owner of a claim, so the stale lock stays: %s", (_name, claimText) => {
    const file = lockFile();
    const text = ident(gonePid());
    writeFileSync(file, text);
    ageOf(file, 60_000);
    writeFileSync(claimOf(file, text), claimText);
    ageOf(claimOf(file, text), 3_600_000);
    expect(() => acquireFileLock(file, { waitMs: 60, staleMs: 10 })).toThrow(/another process holds/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readFileSync(claimOf(file, text), "utf8")).toBe(claimText);
  });

  it.each(forms)("is never judged dead as the owner of a claim when this process gives its lock back: %s", (_name, claimText) => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 60, staleMs: 10 });
    const text = readFileSync(file, "utf8");
    writeFileSync(claimOf(file, text), claimText);
    ageOf(claimOf(file, text), 3_600_000);
    expect(() => release()).toThrow(/could not give back/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(readFileSync(claimOf(file, text), "utf8")).toBe(claimText);
  });

  it("is taken over when the same identity is complete and its process is gone", () => {
    const file = lockFile();
    writeFileSync(file, ident(gonePid()));
    ageOf(file, 60_000);
    acquireFileLock(file, { waitMs: 500, staleMs: 10_000 })();
    expect(existsSync(file)).toBe(false);
  });

  it("is judged by the text the lock writes: the holder text of this process is a complete identity", () => {
    const file = lockFile();
    const release = acquireFileLock(file);
    expect(readFileSync(file, "utf8")).toMatch(/^[1-9][0-9]* (-|[0-9]+) [0-9a-f-]{36}\n$/);
    release();
  });
});

describe("the deadlines", () => {
  /** A wall clock that jumps one hour forward at every reading. */
  const jumpForward = () => {
    let reading = 0;
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 3_600_000 * (reading += 1));
  };

  it("do not follow the wall clock when it jumps forward while a lock is awaited", () => {
    const file = lockFile();
    writeFileSync(file, ident(process.ppid));
    jumpForward();
    const started = performance.now();
    expect(() => acquireFileLock(file, { waitMs: 150, staleMs: 3_600_000_000 })).toThrow(/another process holds/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("do not follow the wall clock when it jumps forward while a lock is given back", () => {
    const file = lockFile();
    const release = acquireFileLock(file, { waitMs: 150, staleMs: 3_600_000_000 });
    const text = readFileSync(file, "utf8");
    writeFileSync(claimOf(file, text), ident(process.ppid));
    jumpForward();
    const started = performance.now();
    expect(() => release()).toThrow(/could not give back/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
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
