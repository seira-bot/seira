import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { realHandoffDeps, type CopyProcess, type HandoffDeps } from "./app-handoff.ts";
import { copyDir, prepareUpdate, readAppState, realDeps, writeAppState, type AppUpdateDeps } from "./app-update.ts";
import { serveUntilStopped, type CliOptions } from "./cli.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { fakeNpmExec, freePort, writeFakeCopy, type FakeMode } from "./testing/fake-app-copies.ts";

const roots: string[] = [];
const children: CopyProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const KEPT = new Set(["app", "tools", "logs", ".backups"]);

/** Every file of the data folder that an update must give back, with its bytes. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === base && KEPT.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(path, base));
    else out[path.slice(base.length)] = readFileSync(path, "utf8");
  }
  return out;
}

async function fixture(modes: Record<string, FakeMode>, options: { own?: string; healthWaitMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seira-e2e-update-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "threads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), '{"theme":"dark","keep":"me"}');
  writeFileSync(join(dataDir, "threads", "t1.json"), '{"messages":["hello"]}');
  writeFileSync(join(dataDir, "environment-id"), "env-1\n");
  const port = await freePort();
  const own = options.own ?? "0.1.150";
  const argv = ["serve", "--port", String(port), "--data-dir", dataDir];
  const handoff: HandoffDeps = { ...realHandoffDeps({ dataDir, port, own, argv, log: () => {} }), env: {}, healthWaitMs: options.healthWaitMs ?? 8_000, stopGraceMs: 3_000 };
  const started: CopyProcess[] = [];
  const realStart = handoff.start;
  handoff.start = (cli, args, env) => {
    const child = realStart(cli, args, env);
    started.push(child);
    children.push(child);
    return child;
  };
  const app: AppUpdateDeps = { ...realDeps(), exec: fakeNpmExec(modes), npmOnPath: () => true };
  const options_ = { command: "serve", port, dataDir, tailscale: false, tunnel: false, client: false, pair: true, json: false } as CliOptions;
  const health = async (): Promise<string | null> => {
    try { return ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { version: string }).version; } catch { return null; }
  };
  return { root, dataDir, port, own, handoff, started, app, options: options_, health };
}

async function until(done: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !(await done())) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await done()).toBe(true);
}

describe("an update from one fake package copy to another", () => {
  it("A to B: the copy answers with its own version, is kept, and the outcome is updated (AC-04)", async () => {
    const f = await fixture({ "0.1.151": "ok" });
    let ownRuns = 0;
    const run = async () => {
      ownRuns++;
      const prepared = await prepareUpdate({ dataDir: f.dataDir, from: f.own, to: "0.1.151", by: "automatic" }, f.app);
      expect(prepared.ok).toBe(true);
      return RESTART_EXIT_CODE;
    };
    const launcher = serveUntilStopped(f.options, run, Date.now, f.handoff);
    await until(async () => (await f.health()) === "0.1.151");
    await until(() => readAppState(f.dataDir).last?.outcome === "updated");
    expect(readAppState(f.dataDir)).toMatchObject({ current: { version: "0.1.151" }, last: { outcome: "updated", automatic: true }, failed: [] });
    expect(readAppState(f.dataDir).pending).toBeUndefined();
    expect(ownRuns).toBe(1);
    f.started[0]!.kill("SIGTERM");
    expect(await launcher).toBe(0);
  });

  it("A to a broken C that exits: the old version runs again and the data is what it was (AC-05)", async () => {
    const f = await fixture({ "0.1.152": "exit" });
    const before = snapshot(f.dataDir);
    let ownRuns = 0;
    const run = async () => {
      ownRuns++;
      if (ownRuns > 1) return 0;
      expect((await prepareUpdate({ dataDir: f.dataDir, from: f.own, to: "0.1.152", by: "admin" }, f.app)).ok).toBe(true);
      return RESTART_EXIT_CODE;
    };
    expect(await serveUntilStopped(f.options, run, Date.now, f.handoff)).toBe(0);
    expect(ownRuns).toBe(2);
    expect(snapshot(f.dataDir)).toEqual(before);
    expect(existsSync(join(f.dataDir, "written-by-0.1.152"))).toBe(false);
    expect(readAppState(f.dataDir)).toMatchObject({ failed: ["0.1.152"], last: { outcome: "rolled-back", from: f.own, target: "0.1.152" } });
    expect(readAppState(f.dataDir).current).toBeUndefined();
    const aside = readdirSync(join(f.dataDir, ".backups", "update")).find((name) => name.startsWith("failed-"));
    expect(readFileSync(join(f.dataDir, ".backups", "update", aside!, "config.json"), "utf8")).toBe('{"migratedBy":"0.1.152"}');
  });

  it("A to a C that answers with another version: it is stopped after the wait, and the data is what it was (AC-05)", async () => {
    const f = await fixture({ "0.1.153": "wrong" }, { healthWaitMs: 2_500 });
    const before = snapshot(f.dataDir);
    let ownRuns = 0;
    const run = async () => {
      ownRuns++;
      if (ownRuns > 1) return 0;
      expect((await prepareUpdate({ dataDir: f.dataDir, from: f.own, to: "0.1.153", by: "admin" }, f.app)).ok).toBe(true);
      return RESTART_EXIT_CODE;
    };
    expect(await serveUntilStopped(f.options, run, Date.now, f.handoff)).toBe(0);
    expect(snapshot(f.dataDir)).toEqual(before);
    expect(await f.health()).toBeNull();
    expect(readAppState(f.dataDir)).toMatchObject({ failed: ["0.1.153"], last: { outcome: "rolled-back" } });
  });

  it("A to a C that never answers: it is stopped after the wait, and the data is what it was (AC-05)", async () => {
    const f = await fixture({ "0.1.154": "hang" }, { healthWaitMs: 2_000 });
    const before = snapshot(f.dataDir);
    let ownRuns = 0;
    const run = async () => {
      ownRuns++;
      if (ownRuns > 1) return 0;
      expect((await prepareUpdate({ dataDir: f.dataDir, from: f.own, to: "0.1.154", by: "admin" }, f.app)).ok).toBe(true);
      return RESTART_EXIT_CODE;
    };
    expect(await serveUntilStopped(f.options, run, Date.now, f.handoff)).toBe(0);
    expect(snapshot(f.dataDir)).toEqual(before);
    expect(readAppState(f.dataDir).failed).toEqual(["0.1.154"]);
  });

  it("a fresh start runs the newest healthy copy with the same options (AC-07)", async () => {
    const f = await fixture({});
    writeFakeCopy(copyDir(f.dataDir, "0.1.151"), "0.1.151");
    writeAppState(f.dataDir, { failed: [], current: { version: "0.1.151", dir: copyDir(f.dataDir, "0.1.151") } });
    let ownRuns = 0;
    const launcher = serveUntilStopped(f.options, async () => { ownRuns++; return 0; }, Date.now, f.handoff);
    await until(async () => (await f.health()) === "0.1.151");
    expect(readFileSync(join(f.dataDir, "starts.log"), "utf8")).toBe("start 0.1.151\n");
    f.started[0]!.kill("SIGTERM");
    expect(await launcher).toBe(0);
    expect(ownRuns).toBe(0);
  });

  it("a recorded copy outside app/ is never run: the own version runs (AC-08)", async () => {
    const f = await fixture({});
    writeFakeCopy(join(f.root, "elsewhere"), "0.1.151");
    writeAppState(f.dataDir, { failed: [], current: { version: "0.1.151", dir: join(f.root, "elsewhere") } });
    let ownRuns = 0;
    expect(await serveUntilStopped(f.options, async () => { ownRuns++; return 0; }, Date.now, f.handoff)).toBe(0);
    expect(ownRuns).toBe(1);
    expect(f.started).toEqual([]);
    expect(existsSync(join(f.dataDir, "starts.log"))).toBe(false);
  });
});
