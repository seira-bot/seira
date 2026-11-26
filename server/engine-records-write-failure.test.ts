import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";

vi.mock("node:fs", { spy: true });
vi.resetModules();
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
const { ENGINE_RUNS_DIR, engineRunTag, recordEngine, resetEngineRecordsForTest, startEngineRecords } = await import("./engine-records.ts");

const folders: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  vi.mocked(writeFileSync).mockRestore();
  resetEngineRecordsForTest();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

/** A full disk creates the file, then fails to fill it. */
function fillDisk(): void {
  vi.mocked(writeFileSync).mockImplementation((target) => {
    real.writeFileSync(target, "");
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });
}

async function startRun() {
  const dir = mkdtempSync(join(tmpdir(), "seira-engine-records-full-"));
  folders.push(dir);
  await startEngineRecords(dir, () => {}, null);
  return join(dir, ENGINE_RUNS_DIR, engineRunTag()!);
}

function engine(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

describe.skipIf(process.platform === "win32")("engine records on a full disk", () => {
  it("leaves no empty or partial file when a record cannot be written", async () => {
    const run = await startRun();
    const child = engine();
    fillDisk();
    recordEngine(child, null);
    expect(readdirSync(run)).toEqual(["server.json"]);
  });

  it("keeps the record that is already on disk when a rewrite fails", async () => {
    const run = await startRun();
    const child = engine();
    recordEngine(child, "first");
    const file = join(run, `${child.pid}.json`);
    const saved = readFileSync(file, "utf8");
    expect(JSON.parse(saved)).toMatchObject({ pid: child.pid, start: "first" });
    fillDisk();
    recordEngine(child, "second");
    expect(readFileSync(file, "utf8")).toBe(saved);
    expect(readdirSync(run).sort()).toEqual([`${child.pid}.json`, "server.json"].sort());
  });

  it("leaves no empty server record when the run folder cannot be started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-engine-records-full-"));
    folders.push(dir);
    fillDisk();
    const log = vi.fn();
    await startEngineRecords(dir, log, null);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not write"));
    const runs = readdirSync(join(dir, ENGINE_RUNS_DIR));
    for (const name of runs) expect(readdirSync(join(dir, ENGINE_RUNS_DIR, name))).toEqual([]);
  });
});
