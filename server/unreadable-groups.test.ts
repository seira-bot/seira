import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verificationServerArgs, verificationServerEnvironment } from "../scripts/control-seira.ts";
import type { ModelSelection } from "./contracts.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { UnreadableBotsError } from "./unreadable-bots.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const GROUPS = join(DATA_DIR, "groups.json");
const ROOMS = ["Alpha", "Beta"];
const copies = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("groups.json.damaged-"));
const canLockFiles = process.platform !== "win32" && process.getuid?.() !== 0;
const roomsOnDisk = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as Array<{ name: string }>).map((room) => room.name);

/** The faults of one groups.json: the half of a whole file, an empty file, text that is not JSON, JSON that is not a list of rooms, a file this user cannot read. */
const FAULTS: Array<{ name: string; unreadable?: boolean; damage: (whole: string) => string }> = [
  { name: "half file", damage: (whole) => whole.slice(0, Math.floor(whole.length / 2)) },
  { name: "empty file", damage: () => "" },
  { name: "text that is not JSON", damage: () => "not json at all, only text from outside" },
  { name: "valid JSON that is not a list", damage: () => "{\"groups\":[]}" },
  { name: "list with an element that has no id (null)", damage: () => "[{\"id\":null,\"name\":\"x\"}]" },
  { name: "list with an element that is a number", damage: () => "[7]" },
  { name: "list with an element that is a text", damage: () => "[\"text\"]" },
  { name: "list with an element that is null", damage: () => "[null]" },
  { name: "list with an element that is a list", damage: () => "[[]]" },
  { name: "list with an empty id", damage: () => "[{\"id\":\"\",\"name\":\"x\"}]" },
  { name: "list with an id that is a number", damage: () => "[{\"id\":3,\"name\":\"x\"}]" },
  { name: "list with one good element and one bad element", damage: (whole) => whole.replace(/\]\s*$/, ",7]") },
  { name: "mode 000", unreadable: true, damage: (whole) => whole },
];

/** A data folder with two bots and two rooms; returns the text of groups.json. */
function wholeFile(): string {
  const store = new Store(selection);
  const [ada, bram] = ["Ada", "Bram"].map((name) => store.createBot({ name }));
  for (const name of ROOMS) store.createGroup(name, [ada!.id, bram!.id]);
  return readFileSync(GROUPS, "utf8");
}

describe("a groups.json that does not load", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(GROUPS)) chmodSync(GROUPS, 0o600); });

  for (const fault of FAULTS) {
    it.skipIf(fault.unreadable && !canLockFiles)(`stops the Store and keeps the bytes of a ${fault.name}`, () => {
      const damaged = fault.damage(wholeFile());
      writeFileSync(GROUPS, damaged);
      if (fault.unreadable) chmodSync(GROUPS, 0o000);

      for (let start = 0; start < 2; start++) expect(() => new Store(selection)).toThrow(UnreadableBotsError);

      chmodSync(GROUPS, 0o600);
      expect(readFileSync(GROUPS, "utf8")).toBe(damaged);
      expect(copies(DATA_DIR)).toHaveLength(fault.unreadable ? 0 : 1);
      if (!fault.unreadable) expect(readFileSync(join(DATA_DIR, copies(DATA_DIR)[0]!), "utf8")).toBe(damaged);
    });
  }

  it.skipIf(!canLockFiles)("keeps every room of a file that is read-only (mode 444), also after one room write", () => {
    wholeFile();
    chmodSync(GROUPS, 0o444);

    const store = new Store(selection);
    expect(store.groups.map((room) => room.name).sort()).toEqual(ROOMS);
    store.createGroup("Gamma", store.bots.map((bot) => bot.id));

    expect(roomsOnDisk(GROUPS).sort()).toEqual([...ROOMS, "Gamma"]);
    expect(copies(DATA_DIR)).toEqual([]);
  });

  it("starts with bots and no groups.json, and with neither file", () => {
    const store = new Store(selection);
    store.createBot({ name: "Ada" });
    rmSync(GROUPS, { force: true });
    expect(new Store(selection).bots).toHaveLength(1);

    rmSync(DATA_DIR, { recursive: true, force: true });
    expect(new Store(selection).groups).toEqual([]);
  });

  it("puts the error code, never the content of the file, in the message", () => {
    writeFileSync(GROUPS, "SECRET-MARKER {");

    let message = "";
    try { new Store(selection); } catch (error) { message = (error as Error).message; }

    expect(message).toMatch(/^The server did not start: groups\.json cannot be read/);
    expect(message).not.toContain("SECRET-MARKER");
    expect(message).not.toContain("\n");
  });
});

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("the server process on a groups.json that does not load", () => {
  const folders: string[] = [];
  const children: ChildProcess[] = [];
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => waitForExit(child, { signal: "SIGKILL" })));
    await Promise.all(folders.splice(0).map(async (dir) => {
      try { chmodSync(join(dir, "groups.json"), 0o600); } catch {}
      await removeTempDir(dir);
    }));
  });

  for (const fault of FAULTS) {
    it.skipIf(fault.unreadable && !canLockFiles)(`exits with one line, writes nothing and takes no room write (${fault.name})`, async () => {
      const damaged = fault.damage(wholeFile());
      const dir = mkdtempSync(join(tmpdir(), "seira-groups-fault-"));
      folders.push(dir);
      copyFileSync(join(DATA_DIR, "bots.json"), join(dir, "bots.json"));
      writeFileSync(join(dir, "groups.json"), damaged);
      if (fault.unreadable) chmodSync(join(dir, "groups.json"), 0o000);
      const port = await unusedPort();
      const env = verificationServerEnvironment(process.env, dir, port);
      const child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));

      expect(code).toBe(1);
      expect(output.split("\n").filter((line) => /groups\.json cannot be read/.test(line))).toHaveLength(1);
      expect(output).not.toMatch(/\n\s+at /);
      await expect(fetch(`http://127.0.0.1:${port}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
      const file = join(dir, "groups.json");
      expect(statSync(file).size).toBe(Buffer.byteLength(damaged));
      chmodSync(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe(damaged);
      expect(readdirSync(dir).filter((name) => name.startsWith("groups.json.damaged-"))).toHaveLength(fault.unreadable ? 0 : 1);
    }, 90_000);
  }
});
