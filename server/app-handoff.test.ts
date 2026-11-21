import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handoffAfterRestart, handoffAtStart, HANDOFF_ENV, HEALTH_WAIT_MS, type CopyProcess, type HandoffDeps } from "./app-handoff.ts";
import { backupData, backupFolder, copyDir, readAppState, realDeps, writeAppState } from "./app-update.ts";
import { serveUntilStopped, type CliOptions } from "./cli.ts";
import { RESTART_EXIT_CODE } from "./restart.ts";
import { writeFakeCopy } from "./testing/fake-app-copies.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Started { cli: string; argv: string[]; env: NodeJS.ProcessEnv; exit(code: number): void; killed: NodeJS.Signals[] }

function harness(options: { own?: string; health?: Array<string | null>; env?: NodeJS.ProcessEnv; failBackup?: boolean; exitOnKill?: boolean; yieldWhileWaiting?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "seira-handoff-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), '{"before":true}');
  writeFakeCopy(copyDir(dataDir, "0.1.151"), "0.1.151");
  let clock = 0;
  const started: Started[] = [];
  const answers = [...(options.health ?? [])];
  const logs: string[] = [];
  let signal: ((signal: NodeJS.Signals) => void) | undefined;
  const real = realDeps();
  const deps: HandoffDeps = {
    dataDir, port: 4321, own: options.own ?? "0.1.150", argv: ["serve", "--port", "4321"], env: options.env ?? {},
    app: { ...real, now: () => 1_800_000_000_000 + clock, exec: options.failBackup ? async () => ({ code: 2, out: "" }) : real.exec },
    start: (cli, argv, env): CopyProcess => {
      let done!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { done = resolve; });
      const entry: Started = { cli, argv, env, killed: [], exit: (code) => done(code) };
      started.push(entry);
      return { exited, kill: (name) => { entry.killed.push(name); if (options.exitOnKill !== false) done(0); } };
    },
    health: async () => (answers.length > 1 ? answers.shift()! : answers[0] ?? null),
    sleep: async (ms) => { clock += ms; if (options.yieldWhileWaiting) await new Promise((resolve) => setTimeout(resolve, 2)); },
    now: () => clock,
    onSignal: (handler) => { signal = handler; return () => { signal = undefined; }; },
    log: (line) => logs.push(line),
  };
  const pend = (extra: Record<string, unknown> = {}) => writeAppState(dataDir, { failed: [], pending: { from: "0.1.150", to: "0.1.151", dir: copyDir(dataDir, "0.1.151"), at: 1_800_000_000_000, by: "admin", ...extra } });
  return { root, dataDir, deps, started, logs, pend, send: (name: NodeJS.Signals) => signal?.(name), clock: () => clock };
}

describe("after the server stopped for an update", () => {
  it("keeps the new version when it answers with its own version, and records updated (AC-04)", async () => {
    const h = harness({ health: [null, null, "0.1.150", "0.1.151"] });
    h.pend({ by: "automatic" });
    const run = handoffAfterRestart(h.deps);
    await until(() => h.logs.some((line) => line.includes("is done")));
    h.started[0]!.exit(0);
    expect(await run).toBe(0);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]!.argv).toEqual(["serve", "--port", "4321"]);
    expect(h.started[0]!.env[HANDOFF_ENV]).toBe("restart");
    const state = readAppState(h.dataDir);
    expect(state.pending).toBeUndefined();
    expect(state.current).toEqual({ version: "0.1.151", dir: copyDir(h.dataDir, "0.1.151") });
    expect(state.last).toMatchObject({ outcome: "updated", from: "0.1.150", to: "0.1.151", automatic: true, local: true });
    expect(readdirSync(backupFolder(h.dataDir)).filter((name) => name.endsWith(".tgz"))).toHaveLength(1);
  });

  it("stops the new version, puts the data back and keeps the old version when it exits (AC-05)", async () => {
    const h = harness({ health: [null] });
    h.pend();
    h.deps.start = ((original) => (cli, argv, env) => {
      const child = original(cli, argv, env);
      writeFileSync(join(h.dataDir, "config.json"), '{"migrated":true}');
      writeFileSync(join(h.dataDir, "from-new-version"), "x");
      h.started[h.started.length - 1]!.exit(3);
      return child;
    })(h.deps.start);
    expect(await handoffAfterRestart(h.deps)).toBeNull();
    expect(readFileSync(join(h.dataDir, "config.json"), "utf8")).toBe('{"before":true}');
    expect(existsSync(join(h.dataDir, "from-new-version"))).toBe(false);
    const state = readAppState(h.dataDir);
    expect(state.failed).toEqual(["0.1.151"]);
    expect(state.pending).toBeUndefined();
    expect(state.current).toBeUndefined();
    expect(state.last).toMatchObject({ outcome: "rolled-back", from: "0.1.150", target: "0.1.151", local: true });
  });

  it("gives the new version 5 minutes, then stops it and goes back (AC-05)", async () => {
    const h = harness({ health: ["0.1.150"] });
    h.pend();
    expect(await handoffAfterRestart(h.deps)).toBeNull();
    expect(h.clock()).toBeGreaterThanOrEqual(HEALTH_WAIT_MS);
    expect(h.started[0]!.killed).toEqual(["SIGTERM"]);
    expect(readAppState(h.dataDir)).toMatchObject({ failed: ["0.1.151"], last: { outcome: "rolled-back" } });
    expect(readFileSync(join(h.dataDir, "config.json"), "utf8")).toBe('{"before":true}');
  });

  it("kills a copy that ignores the stop for 30 seconds", async () => {
    const h = harness({ health: [null], exitOnKill: false });
    h.pend();
    const run = handoffAfterRestart({ ...h.deps, stopGraceMs: 5 });
    await until(() => h.started[0]?.killed.includes("SIGKILL") === true);
    expect(h.started[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    h.started[0]!.exit(0);
    expect(await run).toBeNull();
  });

  it("does not go back when a person stops the server while it waits", async () => {
    const h = harness({ health: [null], yieldWhileWaiting: true });
    h.pend();
    const run = handoffAfterRestart(h.deps);
    await until(() => h.started.length > 0);
    h.send("SIGTERM");
    h.started[0]!.exit(0);
    expect(await run).toBe(0);
    expect(h.started[0]!.killed).toEqual(["SIGTERM"]);
    expect(readAppState(h.dataDir).failed).toEqual([]);
    expect(readFileSync(join(h.dataDir, "config.json"), "utf8")).toBe('{"before":true}');
  });

  it("starts nothing when the data cannot be copied first, and keeps the old version", async () => {
    const h = harness({ failBackup: true });
    h.pend();
    expect(await handoffAfterRestart(h.deps)).toBeNull();
    expect(h.started).toEqual([]);
    expect(readAppState(h.dataDir)).toMatchObject({ last: { outcome: "not-changed" } });
    expect(readAppState(h.dataDir).pending).toBeUndefined();
  });

  it("starts nothing for a copy that is missing, outside app/, or not newer", async () => {
    const missing = harness();
    writeAppState(missing.dataDir, { failed: [], pending: { from: "0.1.150", to: "0.1.160", dir: copyDir(missing.dataDir, "0.1.160"), at: 1, by: "admin" } });
    expect(await handoffAfterRestart(missing.deps)).toBeNull();
    const outside = harness();
    writeFakeCopy(join(outside.root, "elsewhere"), "0.1.151");
    writeAppState(outside.dataDir, { failed: [], pending: { from: "0.1.150", to: "0.1.151", dir: join(outside.root, "elsewhere"), at: 1, by: "admin" } });
    expect(await handoffAfterRestart(outside.deps)).toBeNull();
    const same = harness({ own: "0.1.151" });
    same.pend();
    expect(await handoffAfterRestart(same.deps)).toBeNull();
    for (const h of [missing, outside, same]) {
      expect(h.started).toEqual([]);
      expect(readAppState(h.dataDir).pending).toBeUndefined();
    }
  });

  it("is nothing without a pending update", async () => {
    const h = harness();
    expect(await handoffAfterRestart(h.deps)).toBeNull();
    expect(h.started).toEqual([]);
  });
});

describe("at a fresh start", () => {
  it("runs the newest healthy copy with the same options and returns its exit code (AC-07)", async () => {
    const h = harness();
    writeAppState(h.dataDir, { failed: [], current: { version: "0.1.151", dir: copyDir(h.dataDir, "0.1.151") } });
    const run = handoffAtStart(h.deps);
    await until(() => h.started.length > 0);
    h.started[0]!.exit(7);
    expect(await run).toBe(7);
    expect(h.started[0]!.cli).toBe(join(copyDir(h.dataDir, "0.1.151"), "node_modules", "@seira-bot", "seira", "cli.js"));
    expect(h.started[0]!.argv).toEqual(["serve", "--port", "4321"]);
    expect(h.started[0]!.env[HANDOFF_ENV]).toBe("start");
    expect(existsSync(backupFolder(h.dataDir))).toBe(false);
  });

  it("runs this version when the copy is outside app/, missing, not newer, or this is already a copy (AC-08)", async () => {
    const outside = harness();
    writeFakeCopy(join(outside.root, "elsewhere"), "0.1.151");
    writeAppState(outside.dataDir, { failed: [], current: { version: "0.1.151", dir: join(outside.root, "elsewhere") } });
    const missing = harness();
    writeAppState(missing.dataDir, { failed: [], current: { version: "0.1.160", dir: copyDir(missing.dataDir, "0.1.160") } });
    const older = harness({ own: "0.1.152" });
    writeAppState(older.dataDir, { failed: [], current: { version: "0.1.151", dir: copyDir(older.dataDir, "0.1.151") } });
    const nested = harness({ env: { [HANDOFF_ENV]: "start" } });
    writeAppState(nested.dataDir, { failed: [], current: { version: "0.1.151", dir: copyDir(nested.dataDir, "0.1.151") } });
    const none = harness();
    for (const h of [outside, missing, older, nested, none]) {
      expect(await handoffAtStart(h.deps)).toBeNull();
      expect(h.started).toEqual([]);
    }
  });

  it("finishes an update the server did not finish before it hands off", async () => {
    const h = harness({ health: ["0.1.151"] });
    h.pend();
    const run = handoffAtStart(h.deps);
    await until(() => h.logs.some((line) => line.includes("is done")));
    h.started[0]!.exit(0);
    expect(await run).toBe(0);
    expect(readAppState(h.dataDir).current?.version).toBe("0.1.151");
  });
});

describe("one launcher runs every handoff", () => {
  const ref = (h: ReturnType<typeof harness>, version: string) => ({ version, dir: copyDir(h.dataDir, version) });
  const later = (h: ReturnType<typeof harness>, version: string) => writeFakeCopy(copyDir(h.dataDir, version), version);
  const pendingFor = (h: ReturnType<typeof harness>, from: string, to: string) => ({ from, to, dir: copyDir(h.dataDir, to), at: 1_800_000_000_000, by: "admin" as const });

  it("starts the next copy itself when the running copy asks for a restart: one level, not two", async () => {
    const h = harness({ health: ["0.1.152"] });
    later(h, "0.1.152");
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151") });
    const run = handoffAtStart(h.deps);
    await until(() => h.started.length === 1);
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151"), pending: pendingFor(h, "0.1.151", "0.1.152") });
    h.started[0]!.exit(RESTART_EXIT_CODE);
    await until(() => h.started.length === 2);
    expect(h.started[1]!.cli).toBe(join(copyDir(h.dataDir, "0.1.152"), "node_modules", "@seira-bot", "seira", "cli.js"));
    expect(h.started[1]!.env[HANDOFF_ENV]).toBe("restart");
    await until(() => h.logs.some((line) => line.includes("is done")));
    h.started[1]!.exit(0);
    expect(await run).toBe(0);
    expect(h.started).toHaveLength(2);
    expect(readAppState(h.dataDir).current?.version).toBe("0.1.152");
  });

  it("returns a restart that asks for no update to the caller as the copy's own exit code", async () => {
    const h = harness();
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151") });
    const run = handoffAtStart(h.deps);
    await until(() => h.started.length === 1);
    h.started[0]!.exit(RESTART_EXIT_CODE);
    expect(await run).toBe(RESTART_EXIT_CODE);
    expect(h.started).toHaveLength(1);
  });

  it("runs the current copy, not this older version, after the next copy rolled back", async () => {
    const h = harness({ health: [null] });
    later(h, "0.1.152");
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151") });
    const real = h.deps.start;
    h.deps.start = (cli, argv, env) => {
      const child = real(cli, argv, env);
      if (h.started.length === 2) h.started[1]!.exit(3);
      return child;
    };
    const run = handoffAtStart(h.deps);
    await until(() => h.started.length === 1);
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151"), pending: pendingFor(h, "0.1.151", "0.1.152") });
    h.started[0]!.exit(RESTART_EXIT_CODE);
    await until(() => h.started.length === 3);
    expect(h.started[2]!.cli).toBe(join(copyDir(h.dataDir, "0.1.151"), "node_modules", "@seira-bot", "seira", "cli.js"));
    expect(h.started[2]!.env[HANDOFF_ENV]).toBe("restart");
    h.started[2]!.exit(0);
    expect(await run).toBe(0);
    expect(readAppState(h.dataDir)).toMatchObject({ failed: ["0.1.152"], current: { version: "0.1.151" }, last: { outcome: "rolled-back" } });
  });

  it("runs the current copy after an update was dropped because the data could not be copied", async () => {
    const h = harness({ failBackup: true });
    later(h, "0.1.152");
    writeAppState(h.dataDir, { failed: [], current: ref(h, "0.1.151"), pending: pendingFor(h, "0.1.151", "0.1.152") });
    const run = handoffAfterRestart(h.deps);
    await until(() => h.started.length === 1);
    expect(h.started[0]!.cli).toBe(join(copyDir(h.dataDir, "0.1.151"), "node_modules", "@seira-bot", "seira", "cli.js"));
    h.started[0]!.exit(0);
    expect(await run).toBe(0);
    expect(readAppState(h.dataDir)).toMatchObject({ last: { outcome: "not-changed" } });
  });

  it("does not start a handoff in a launcher that a copy started: it returns the restart code", async () => {
    const h = harness({ env: { [HANDOFF_ENV]: "restart" } });
    later(h, "0.1.152");
    let runs = 0;
    const run = async () => {
      runs++;
      writeAppState(h.dataDir, { failed: [], pending: pendingFor(h, "0.1.151", "0.1.152") });
      return RESTART_EXIT_CODE;
    };
    const options = { command: "serve", port: 4321, dataDir: h.dataDir, pair: true, json: false } as unknown as CliOptions;
    expect(await serveUntilStopped(options, run, Date.now, h.deps)).toBe(RESTART_EXIT_CODE);
    expect(runs).toBe(1);
    expect(h.started).toEqual([]);
    expect(readAppState(h.dataDir).pending).toBeDefined();
  });

  it("keeps the restart loop for a restart that left no update pending", async () => {
    const h = harness({ env: { [HANDOFF_ENV]: "restart" } });
    let runs = 0;
    const run = async () => (++runs === 1 ? RESTART_EXIT_CODE : 0);
    const options = { command: "serve", port: 4321, dataDir: h.dataDir, pair: true, json: false } as unknown as CliOptions;
    expect(await serveUntilStopped(options, run, Date.now, h.deps)).toBe(0);
    expect(runs).toBe(2);
  });
});

describe("a launcher that was stopped while it waited for the new version", () => {
  it("puts back the first backup, and takes no new one (the new version may have changed the data)", async () => {
    const h = harness({ health: [null] });
    const first = await backupData(h.dataDir, "0.1.150", h.deps.app);
    expect(first.ok).toBe(true);
    writeFileSync(join(h.dataDir, "config.json"), '{"changedByNewVersion":true}');
    h.pend({ backup: first.ok ? first.file : "" });
    h.deps.start = ((original) => (cli, argv, env) => {
      const child = original(cli, argv, env);
      h.started[h.started.length - 1]!.exit(3);
      return child;
    })(h.deps.start);
    expect(await handoffAfterRestart(h.deps)).toBeNull();
    expect(readdirSync(backupFolder(h.dataDir)).filter((name) => name.endsWith(".tgz"))).toHaveLength(1);
    expect(readFileSync(join(h.dataDir, "config.json"), "utf8")).toBe('{"before":true}');
    expect(readAppState(h.dataDir)).toMatchObject({ failed: ["0.1.151"], last: { outcome: "rolled-back" } });
  });

  it("takes a new backup when the recorded one is gone or is not in the backup folder", async () => {
    const h = harness({ health: ["0.1.151"] });
    h.pend({ backup: join(h.dataDir, "elsewhere.tgz") });
    const run = handoffAfterRestart(h.deps);
    await until(() => h.logs.some((line) => line.includes("is done")));
    h.started[0]!.exit(0);
    await run;
    expect(readdirSync(backupFolder(h.dataDir)).filter((name) => name.endsWith(".tgz"))).toHaveLength(1);
  });
});

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(done()).toBe(true);
}
