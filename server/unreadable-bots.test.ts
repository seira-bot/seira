import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verificationServerArgs, verificationServerEnvironment } from "../scripts/control-seira.ts";
import type { ModelSelection } from "./contracts.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { openStoreOrExit, UnreadableBotsError } from "./unreadable-bots.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const BOTS = join(DATA_DIR, "bots.json");
const NAMES = ["Ada", "Bram", "Cleo"];
const copies = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("bots.json.damaged-"));
const canLockFiles = process.platform !== "win32" && process.getuid?.() !== 0;

/** The faults of one bots.json: the half of a whole file, an empty file, text that is not JSON, a file this user cannot read. */
const FAULTS: Array<{ name: string; unreadable?: boolean; damage: (whole: string) => string }> = [
  { name: "half file", damage: (whole) => whole.slice(0, Math.floor(whole.length / 2)) },
  { name: "empty file", damage: () => "" },
  { name: "text that is not JSON", damage: () => "not json at all, only text from outside" },
  { name: "valid JSON that is not a list", damage: () => "{\"bots\":[]}" },
  { name: "mode 000", unreadable: true, damage: (whole) => whole },
];

function wholeFile(): string {
  const store = new Store(selection);
  for (const name of NAMES) store.createBot({ name });
  return readFileSync(BOTS, "utf8");
}

describe("a bots.json that does not load", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(BOTS)) chmodSync(BOTS, 0o600); });

  for (const fault of FAULTS) {
    it.skipIf(fault.unreadable && !canLockFiles)(`stops the Store and keeps the bytes of a ${fault.name}`, () => {
      const damaged = fault.damage(wholeFile());
      writeFileSync(BOTS, damaged);
      if (fault.unreadable) chmodSync(BOTS, 0o000);
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        for (let start = 0; start < 2; start++) expect(() => new Store(selection)).toThrow(UnreadableBotsError);
      } finally {
        log.mockRestore();
      }

      chmodSync(BOTS, 0o600);
      expect(readFileSync(BOTS, "utf8")).toBe(damaged);
      expect(copies(DATA_DIR)).toHaveLength(fault.unreadable ? 0 : 1);
      if (!fault.unreadable) expect(readFileSync(join(DATA_DIR, copies(DATA_DIR)[0]!), "utf8")).toBe(damaged);
    });
  }

  it.skipIf(!canLockFiles)("keeps every bot of a file that is read-only (mode 444)", () => {
    wholeFile();
    chmodSync(BOTS, 0o444);

    const store = new Store(selection);

    expect(store.bots.map((bot) => bot.name)).toEqual(expect.arrayContaining(NAMES));
    expect(copies(DATA_DIR)).toEqual([]);
  });

  it("starts a first Store on a data folder that has no bots.json, with the default bot", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
  });

  it("puts the error code, never the content of the file, in the message", () => {
    writeFileSync(BOTS, "SECRET-MARKER {");

    let message = "";
    try { new Store(selection); } catch (error) { message = (error as Error).message; }

    expect(message).toContain("bots.json cannot be read");
    expect(message).not.toContain("SECRET-MARKER");
    expect(message).not.toContain("\n");
  });

  it("prints one line and exits with code 1, and passes on any other error", () => {
    writeFileSync(BOTS, "[");
    const printed: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { printed.push(String(line)); });
    const exit = vi.fn((code: number): never => { throw new Error(`exit ${code}`); });
    try {
      expect(() => openStoreOrExit(() => new Store(selection), exit)).toThrow("exit 1");
      expect(() => openStoreOrExit(() => { throw new RangeError("other"); }, exit)).toThrow("other");
    } finally {
      spy.mockRestore();
    }
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/^The server did not start: bots\.json cannot be read/);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("the server process on a bots.json that does not load", () => {
  const folders: string[] = [];
  const children: ChildProcess[] = [];
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => waitForExit(child, { signal: "SIGKILL" })));
    await Promise.all(folders.splice(0).map(async (dir) => {
      try { chmodSync(join(dir, "bots.json"), 0o600); } catch {}
      await removeTempDir(dir);
    }));
  });

  for (const fault of FAULTS) {
    it.skipIf(fault.unreadable && !canLockFiles)(`exits with one line, writes nothing and takes no request (${fault.name})`, async () => {
      const damaged = fault.damage(wholeFile());
      const dir = mkdtempSync(join(tmpdir(), "seira-bots-fault-"));
      folders.push(dir);
      writeFileSync(join(dir, "bots.json"), damaged);
      if (fault.unreadable) chmodSync(join(dir, "bots.json"), 0o000);
      const port = await unusedPort();
      const env = verificationServerEnvironment(process.env, dir, port);
      const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

      expect(code).toBe(1);
      expect(output.split("\n").filter((line) => /bots\.json cannot be read/.test(line))).toHaveLength(1);
      expect(output).not.toMatch(/\n\s+at /);
      await expect(fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
      const file = join(dir, "bots.json");
      expect(statSync(file).size).toBe(Buffer.byteLength(damaged));
      chmodSync(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe(damaged);
      expect(readdirSync(dir).filter((name) => name.startsWith("bots.json.damaged-"))).toHaveLength(fault.unreadable ? 0 : 1);
    }, 90_000);
  }
});
