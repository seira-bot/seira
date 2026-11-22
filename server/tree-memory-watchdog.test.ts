import { afterEach, describe, expect, it, vi } from "vitest";
import type { FootprintOwner } from "./perf/bot-footprint.ts";
import type { ProcessRow } from "./perf/process-buckets.ts";
import { createTreeMemoryWatchdog, type TreeMemoryStop, type TreeMemoryWatchdogOptions } from "./tree-memory-watchdog.ts";

const MB = 1024 * 1024;
const row = (pid: number, ppid: number, name: string, mb: number): ProcessRow => ({ pid, ppid, name, cpuMs: 0, rssBytes: mb * MB, start: `s${pid}` });
const engine = (pid: number, ...botIds: string[]): FootprintOwner => ({ pid, botIds, kind: "engine" });

function setup(initial: ProcessRow[], owners: FootprintOwner[], extra: Partial<TreeMemoryWatchdogOptions> = {}) {
  const state = { rows: initial, t: 0, budget: 500 * MB as number | null };
  const signals: Array<[number, string]> = [];
  const stops: TreeMemoryStop[] = [];
  const dog = createTreeMemoryWatchdog({
    list: () => state.rows,
    owners: () => owners,
    budgetBytes: () => state.budget,
    signal: (pid, signal) => { signals.push([pid, signal]); return true; },
    onStop: (event) => stops.push(event),
    now: () => state.t,
    serverPid: 1,
    ...extra,
  });
  const at = async (t: number) => { state.t = t; await dog.tick(); };
  return { state, signals, stops, dog, at };
}

const botA = [row(100, 1, "engine", 300), row(101, 100, "worker", 600), row(102, 100, "helper", 100)];

describe("tree memory watchdog", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("does nothing under budget", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    state.budget = 2000 * MB;
    await at(0);
    await at(60_000);
    expect(signals).toEqual([]);
  });

  it("does nothing when over for less than 10 seconds", async () => {
    const { signals, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    await at(8_000);
    expect(signals).toEqual([]);
  });

  it("stops the largest non-engine process after 10 seconds over", async () => {
    const { signals, stops, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    await at(10_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
    expect(stops).toEqual([{ botId: "bot-a", pid: 101, root: 100, name: "worker", bytes: 600 * MB, totalBytes: 1000 * MB, budgetBytes: 500 * MB }]);
  });

  it("tells the bots' memory at the last look, and null when the list was not read", async () => {
    const { state, dog, at } = setup(botA, [engine(100, "bot-a")]);
    expect(dog.used()).toBeNull();
    state.budget = 2000 * MB;
    await at(0);
    expect(dog.used()).toBe(1000 * MB);
    state.rows = null as unknown as ProcessRow[];
    await at(2_000);
    expect(dog.used()).toBeNull();
  });

  it("stops at the first check over budget when the machine has less than 1 GiB available (AC-07b)", async () => {
    const free = { bytes: 900 * MB as number | null };
    const { signals, at } = setup(botA, [engine(100, "bot-a")], { available: () => free.bytes });
    await at(0);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("still waits 10 seconds when the machine has 1 GiB or more available, or the amount is unknown", async () => {
    for (const bytes of [1024 * MB, null]) {
      const { signals, at } = setup(botA, [engine(100, "bot-a")], { available: () => bytes });
      await at(0);
      await at(8_000);
      expect(signals).toEqual([]);
      await at(10_000);
      expect(signals).toEqual([[101, "SIGTERM"]]);
    }
  });

  it("does not stop a second process while the first stop is pending, even with little memory available", async () => {
    const { signals, at } = setup(botA, [engine(100, "bot-a")], { available: () => 0 });
    await at(0);
    await at(2_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("does nothing under budget when the machine has little memory available", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")], { available: () => 0 });
    state.budget = 2000 * MB;
    await at(0);
    expect(signals).toEqual([]);
  });

  it("never stops an engine root, even when it is the largest", async () => {
    const rows = [row(100, 1, "engine", 900), row(101, 100, "worker", 100)];
    const { signals, at } = setup(rows, [engine(100, "bot-a")]);
    await at(0);
    await at(10_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("stops nothing in a bot whose only processes are engine roots", async () => {
    const { signals, stops, at } = setup([row(100, 1, "engine", 900)], [engine(100, "bot-a")]);
    await at(0);
    await at(30_000);
    expect(signals).toEqual([]);
    expect(stops).toEqual([]);
  });

  it("picks the bot with the most memory", async () => {
    const rows = [...botA, row(200, 1, "engine", 100), row(201, 200, "worker", 150)];
    const { stops, at } = setup(rows, [engine(100, "bot-a"), engine(200, "bot-b")]);
    await at(0);
    await at(10_000);
    expect(stops.map((stop) => [stop.botId, stop.pid])).toEqual([["bot-a", 101]]);
  });

  it("never stops the server or pid 1", async () => {
    const rows = [row(100, 1, "engine", 300), row(101, 100, "server", 600), row(102, 100, "helper", 100)];
    const { signals, at } = setup(rows, [engine(100, "bot-a")], { serverPid: 101 });
    await at(0);
    await at(10_000);
    expect(signals).toEqual([[102, "SIGTERM"]]);
    const init = setup([row(100, 1, "engine", 300), row(1, 100, "launchd", 900)], [engine(100, "bot-a")], { serverPid: 5 });
    await init.at(0);
    await init.at(10_000);
    expect(init.signals).toEqual([]);
  });

  it("restarts the clock after a dip under budget", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    state.rows = [row(100, 1, "engine", 100)];
    await at(6_000);
    state.rows = botA;
    await at(8_000);
    await at(14_000);
    expect(signals).toEqual([]);
    await at(18_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("needs another full interval over budget before the next stop", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    await at(10_000);
    state.rows = [row(100, 1, "engine", 300), row(102, 100, "helper", 400), row(103, 100, "worker", 50)];
    await at(14_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
    await at(20_000);
    expect(signals).toEqual([[101, "SIGTERM"], [102, "SIGTERM"]]);
  });

  it("sends SIGKILL after the grace time while the process is still listed", async () => {
    const { signals, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    await at(10_000);
    await at(12_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
    await at(13_000);
    expect(signals).toEqual([[101, "SIGTERM"], [101, "SIGKILL"]]);
    await at(14_000);
    expect(signals).toHaveLength(2);
  });

  it("sends no SIGKILL when the process is gone or the pid has another name", async () => {
    const gone = setup(botA, [engine(100, "bot-a")]);
    await gone.at(0);
    await gone.at(10_000);
    gone.state.rows = botA.filter((r) => r.pid !== 101);
    await gone.at(14_000);
    expect(gone.signals).toEqual([[101, "SIGTERM"]]);

    const reused = setup(botA, [engine(100, "bot-a")]);
    await reused.at(0);
    await reused.at(10_000);
    reused.state.rows = botA.map((r) => (r.pid === 101 ? { ...r, name: "other" } : r));
    await reused.at(14_000);
    expect(reused.signals).toEqual([[101, "SIGTERM"]]);
  });

  it("does nothing with a null or zero budget", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    state.budget = null;
    await at(0);
    await at(60_000);
    state.budget = 0;
    await at(120_000);
    expect(signals).toEqual([]);
  });

  it("skips a tick when the list is null", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    state.rows = null as unknown as ProcessRow[];
    await at(0);
    await at(60_000);
    expect(signals).toEqual([]);
  });

  it("starts the 10 seconds again after a check without a list (AC-07)", async () => {
    const { state, signals, at } = setup(botA, [engine(100, "bot-a")]);
    await at(0);
    await at(4_000);
    state.rows = null as unknown as ProcessRow[];
    await at(6_000);
    state.rows = botA;
    await at(120_000);
    expect(signals).toEqual([]);
    await at(130_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("sends no SIGKILL to a process that has the pid now, or after a check without a list", async () => {
    const reused = setup(botA, [engine(100, "bot-a")]);
    await reused.at(0);
    await reused.at(10_000);
    reused.state.rows = botA.map((r) => (r.pid === 101 ? { ...r, start: "later" } : r));
    await reused.at(14_000);
    expect(reused.signals).toEqual([[101, "SIGTERM"]]);

    const unlisted = setup(botA, [engine(100, "bot-a")]);
    await unlisted.at(0);
    await unlisted.at(10_000);
    unlisted.state.rows = null as unknown as ProcessRow[];
    await unlisted.at(12_000);
    unlisted.state.rows = botA;
    await unlisted.at(14_000);
    expect(unlisted.signals).toEqual([[101, "SIGTERM"]]);
  });

  it("sends no SIGKILL to a process that is no longer bot work", async () => {
    const owners = [engine(100, "bot-a")];
    const { state, signals, at } = setup(botA, owners);
    await at(0);
    await at(10_000);
    state.rows = [row(100, 1, "engine", 300), row(101, 1, "worker", 600)];
    await at(14_000);
    expect(signals).toEqual([[101, "SIGTERM"]]);
  });

  it("never stops the engine that a launcher root started", async () => {
    const helper = [row(100, 1, "seira-job-fence.exe", 5), row(101, 100, "node.exe", 900), row(102, 101, "python.exe", 200)];
    const { signals, stops, at } = setup(helper, [engine(100, "bot-a")]);
    await at(0);
    await at(10_000);
    expect(signals).toEqual([[102, "SIGTERM"]]);
    expect(stops[0]).toMatchObject({ pid: 102, root: 100 });

    const shim = [row(200, 1, "powershell.exe", 60), row(201, 200, "node.exe", 900), row(202, 200, "conhost.exe", 10)];
    const alone = setup(shim, [engine(200, "bot-a")]);
    await alone.at(0);
    await alone.at(10_000);
    await alone.at(30_000);
    expect(alone.signals).toEqual([]);
    alone.state.rows = [...shim, row(203, 201, "python.exe", 300)];
    await alone.at(32_000);
    expect(alone.signals).toEqual([[203, "SIGTERM"]]);
  });

  it("with a calm interval lists less often while bot work is well under the budget", async () => {
    let lists = 0;
    const { state, at } = setup(botA, [engine(100, "bot-a")], { calmMs: 10_000, list: () => { lists += 1; return state.rows; } });
    state.budget = 2000 * MB;
    await at(0);
    await at(2_000);
    await at(8_000);
    expect(lists).toBe(1);
    await at(10_000);
    expect(lists).toBe(2);
    state.budget = 1200 * MB;
    await at(12_000);
    await at(14_000);
    expect(lists).toBe(4);
  });

  it("with a calm interval still lists at every check when the machine is short of memory", async () => {
    let lists = 0;
    const { state, at } = setup(botA, [engine(100, "bot-a")], { calmMs: 10_000, available: () => 1024 * MB, list: () => { lists += 1; return state.rows; } });
    state.budget = 2000 * MB;
    await at(0);
    await at(2_000);
    expect(lists).toBe(2);
  });

  it("reports botId null for a shared process", async () => {
    const rows = [row(100, 1, "engine", 300), row(101, 100, "worker", 700)];
    const { stops, at } = setup(rows, [engine(100, "bot-a", "bot-b")]);
    await at(0);
    await at(10_000);
    expect(stops.map((stop) => [stop.botId, stop.pid])).toEqual([[null, 101]]);
  });

  it("never lets ticks overlap", async () => {
    let release: (rows: ProcessRow[]) => void = () => undefined;
    let calls = 0;
    const dog = createTreeMemoryWatchdog({
      list: () => { calls += 1; return new Promise<ProcessRow[]>((resolve) => { release = resolve; }); },
      owners: () => [],
      budgetBytes: () => 1,
      signal: () => true,
      serverPid: 1,
    });
    const first = dog.tick();
    const second = dog.tick();
    await second;
    expect(calls).toBe(1);
    release([]);
    await first;
    const third = dog.tick();
    expect(calls).toBe(2);
    release([]);
    await third;
  });

  it("keeps running when a tick throws", async () => {
    const dog = createTreeMemoryWatchdog({ list: () => { throw new Error("ps failed"); }, owners: () => [], budgetBytes: () => 1, serverPid: 1 });
    await expect(dog.tick()).resolves.toBeUndefined();
  });

  it("start runs a tick every interval and stop ends it", async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => []);
    const dog = createTreeMemoryWatchdog({ list, owners: () => [], budgetBytes: () => 1, intervalMs: 2000, serverPid: 1 });
    dog.start();
    dog.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(list).toHaveBeenCalledTimes(2);
    dog.stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
