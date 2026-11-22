import { describe, expect, it } from "vitest";

import { BotMemoryGuard, type GuardDeps } from "./bot-memory-guard.ts";
import type { ProviderAdapter, ProviderInstance, RuntimeEvent, RuntimeEventListener } from "./contracts.ts";
import type { JobFenceEvent, JobHoldOptions } from "./job-fence.ts";
import { fenceOomBotText, withMemoryFence } from "./memory-fence.ts";
import type { FootprintOwner } from "./perf/bot-footprint.ts";
import type { TreeMemoryStop, TreeMemoryWatchdogOptions } from "./tree-memory-watchdog.ts";

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const DESKTOP = { SEIRA_DESKTOP_PARENT: "1" };
const HELPER = "C:\\Seira\\resources\\job-fence\\seira-job-fence.exe";

function fakes(over: Partial<GuardDeps> & { hold?: "ready" | "fails" | "later" } = {}) {
  const state = {
    holdOptions: null as JobHoldOptions | null, limits: [] as number[], stats: 0, alive: true, primed: 0, release: null as (() => void) | null,
    dog: null as TreeMemoryWatchdogOptions | null, dogStarted: 0, dogUsed: null as number | null, logs: [] as string[], now: 0,
  };
  const deps: Partial<GuardDeps> = {
    env: DESKTOP, platform: "win32", budget: () => 4 * GIB, helper: () => HELPER, dataDir: () => "C:\\Users\\a\\.seira",
    startHold: async (options) => {
      state.holdOptions = options;
      if (over.hold === "fails") return null;
      const hold = {
        job: "Local\\Seira-bots-abc-77", pid: 77, limitBytes: () => options.limitBytes,
        setLimit: (bytes: number) => { state.limits.push(bytes); }, stats: () => { state.stats += 1; }, alive: () => state.alive, close: () => {},
      };
      if (over.hold === "later") await new Promise<void>((resolve) => { state.release = resolve; });
      return hold;
    },
    list: async () => [],
    machine: () => ({ totalBytes: 16 * GIB, availableBytes: 6 * GIB }),
    prime: async () => { state.primed += 1; },
    watchdog: (options) => { state.dog = options; return { start: () => { state.dogStarted += 1; }, stop: () => {}, used: () => state.dogUsed }; },
    now: () => state.now,
    log: (line) => { state.logs.push(line); },
    ...over,
  };
  return { state, guard: new BotMemoryGuard(deps) };
}

const event = (state: ReturnType<typeof fakes>["state"], value: JobFenceEvent) => state.holdOptions!.onEvent!(value);
const engine = (pid: number, exited = false): FootprintOwner => ({ pid, botIds: ["b1"], kind: "engine", exited });

describe("the memory limit for bots on Windows and macOS", () => {
  it("is wanted in the desktop app's server on Windows and macOS only, unless it is switched off", () => {
    expect(fakes().guard.wanted()).toBe(true);
    expect(fakes({ platform: "darwin" }).guard.wanted()).toBe(true);
    expect(fakes({ platform: "linux" }).guard.wanted()).toBe(false);
    expect(fakes({ env: {} }).guard.wanted()).toBe(false);
    expect(fakes({ env: { SEIRA_BOT_MEMORY_FENCE: "on" } }).guard.wanted()).toBe(true);
    expect(fakes({ env: { ...DESKTOP, SEIRA_BOT_MEMORY_FENCE: "off" } }).guard.wanted()).toBe(false);
    expect(fakes({ env: { ...DESKTOP, SEIRA_BOT_MEMORY_MAX_MB: "off" } }).guard.wanted()).toBe(false);
  });

  it("does nothing where it is not wanted", async () => {
    const { guard, state } = fakes({ env: {} });
    await guard.start(() => []);
    expect(state.holdOptions).toBeNull();
    expect(state.dog).toBeNull();
    expect(guard.protection()).toBe("none");
    expect(guard.active()).toBe(false);
    expect(guard.sliceKills()).toBeNull();
    expect(guard.scopeKills(5)).toBeNull();
    expect(guard.argv("C:\\node.exe", ["a"], {})).toBeNull();
    expect(guard.usedBytes()).toBeNull();
  });

  it("on Windows holds one job with the budget and starts every engine in it (AC-01, AC-02, AC-04)", async () => {
    const owners: FootprintOwner[] = [];
    const { guard, state } = fakes();
    await guard.start(() => owners);
    owners.push(engine(300));
    expect(guard.protection()).toBe("job");
    expect(state.dogStarted).toBe(1);
    expect(state.dog!.owners()).toEqual([]);
    expect(state.logs).not.toContain("a watchdog keeps all bot work under the memory limit for bots");
    expect(state.holdOptions).toMatchObject({ helper: HELPER, limitBytes: 4 * GIB });
    expect(state.holdOptions!.base).toMatch(/^Local\\Seira-bots-[0-9a-f]{10}$/);
    const spawn = guard.argv("C:\\Program Files\\nodejs\\node.exe", ["cli.js", "--print"], { PATH: "x" });
    expect(spawn).toEqual({ command: HELPER, args: ["--", "C:\\Program Files\\nodejs\\node.exe", "cli.js", "--print"], env: { PATH: "x", SEIRA_FENCE_JOB: "Local\\Seira-bots-abc-77" } });
    expect(state.limits).toEqual([4 * GIB]);
    expect(() => guard.argv("C:\\x\\claude.cmd", [], {})).toThrow(expect.objectContaining({ code: "EINVAL" }));
  });

  it("counts each program the job stopped by the engine it ran under (AC-03)", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    expect(guard.sliceKills()).toBe(0);
    expect(guard.scopeKills(500)).toBe(0);
    event(state, { event: "memory-stop", pid: 900, name: "python.exe", bytes: 3 * GIB, jobBytes: 4 * GIB, limitBytes: 4 * GIB, root: 600, helper: 500, by: 900 });
    expect(guard.sliceKills()).toBe(1);
    expect(guard.scopeKills(500)).toBe(1);
    expect(guard.scopeKills(501)).toBe(0);
    expect(state.logs.at(-1)).toContain("stopped python.exe (3072 MB)");
    event(state, { event: "memory-stop", pid: 901, name: "chrome.exe", bytes: GIB, jobBytes: 4 * GIB, limitBytes: 4 * GIB, root: 901, helper: 0, by: 901 });
    expect(guard.sliceKills()).toBe(2);
    expect(guard.scopeKills(500)).toBe(1);
  });

  it("reads the job's memory at most once a second", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    expect(guard.usedBytes()).toBeNull();
    expect(state.stats).toBe(1);
    event(state, { event: "stats", processes: 3, jobBytes: 700 * MIB, peakBytes: 900 * MIB, limitBytes: 4 * GIB });
    expect(guard.usedBytes()).toBe(700 * MIB);
    expect(state.stats).toBe(1);
    state.now = 1_000;
    guard.usedBytes();
    expect(state.stats).toBe(2);
  });

  it("falls back to the watchdog in enforce mode when the helper is missing or does not start (AC-06)", async () => {
    for (const setup of [fakes({ helper: () => null }), fakes({ hold: "fails" })]) {
      const { guard, state } = setup;
      await guard.start(() => []);
      expect(guard.protection()).toBe("watchdog");
      expect(state.dogStarted).toBe(1);
      expect(state.dog!.budgetBytes()).toBe(4 * GIB);
      expect(guard.argv("C:\\node.exe", [], {})).toBeNull();
      expect(state.logs.join("\n")).toContain("a watchdog keeps all bot work under the memory limit for bots");
    }
  });

  it("falls back to the watchdog when the helper stops after it was ready", async () => {
    const owners = [engine(300)];
    const { guard, state } = fakes();
    await guard.start(() => owners);
    state.alive = false;
    state.holdOptions!.onExit!();
    expect(guard.protection()).toBe("watchdog");
    expect(state.dogStarted).toBe(1);
    expect(state.dog!.owners()).toBe(owners);
    expect(state.dog!.budgetBytes()).toBe(4 * GIB);
    expect(guard.argv("C:\\node.exe", [], {})).toBeNull();
    expect(guard.lateStops()).toBe(false);
  });

  it("on Windows the watchdog holds every engine until the job is ready, then those that started outside it", async () => {
    const owners: FootprintOwner[] = [];
    const { guard, state } = fakes({ hold: "later" });
    const started = guard.start(() => owners);
    expect(guard.protection()).toBe("watchdog");
    expect(guard.active()).toBe(true);
    expect(state.dogStarted).toBe(1);
    expect(guard.argv("C:\\node.exe", [], {})).toBeNull();
    owners.push(engine(300));
    expect(state.dog!.owners()).toEqual(owners);
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.release!();
    await started;
    expect(guard.protection()).toBe("job");
    expect(guard.lateStops()).toBe(true);
    owners.push(engine(400));
    expect(state.dog!.owners()).toEqual([owners[0]]);
    expect(state.dog!.list()).not.toBeNull();
    event(state, { event: "stats", processes: 3, jobBytes: 3 * GIB, peakBytes: 3 * GIB, limitBytes: 4 * GIB });
    expect(state.dog!.budgetBytes()).toBe(GIB);
    state.dogUsed = 512 * MIB;
    expect(guard.usedBytes()).toBe(3 * GIB + 512 * MIB);
    owners[0] = engine(300, true);
    expect(state.dog!.owners()).toEqual([]);
    expect(state.dog!.list()).toBeNull();
    expect(guard.usedBytes()).toBe(3 * GIB);
  });

  it("reads the machine's memory once when it starts", async () => {
    const { guard, state } = fakes({ platform: "darwin" });
    await guard.start(() => []);
    expect(state.primed).toBe(1);
  });

  it("on macOS watches the bots' processes against the budget and the free memory (AC-07, AC-07b, AC-08)", async () => {
    const owners: FootprintOwner[] = [];
    const { guard, state } = fakes({ platform: "darwin", machine: () => ({ totalBytes: 16 * GIB, availableBytes: 512 * MIB }) });
    await guard.start(() => owners);
    expect(state.holdOptions).toBeNull();
    expect(guard.protection()).toBe("watchdog");
    expect(state.dog!.available!()).toBe(512 * MIB);
    expect(state.dog!.list()).toBeNull();
    owners.push(engine(300, true));
    expect(state.dog!.list()).toBeNull();
    owners.push(engine(301));
    expect(state.dog!.list()).not.toBeNull();
    expect(state.dog!.owners()).toBe(owners);
    const stop: TreeMemoryStop = { botId: "b1", pid: 333, root: 301, name: "node", bytes: 2 * GIB, totalBytes: 5 * GIB, budgetBytes: 4 * GIB };
    state.dog!.onStop!(stop);
    expect(guard.sliceKills()).toBe(1);
    expect(guard.scopeKills(301)).toBe(1);
    state.dog!.onStop!({ ...stop, root: null });
    expect(guard.sliceKills()).toBe(2);
    state.dogUsed = 3 * GIB;
    expect(guard.usedBytes()).toBe(3 * GIB);
  });

  it("starts once", async () => {
    const { guard, state } = fakes({ platform: "darwin" });
    await guard.start(() => []);
    await guard.start(() => []);
    expect(state.dogStarted).toBe(1);
  });
});

type Notice = RuntimeEvent & { turnId?: string; text?: { key: string; params?: { gb: string } } };

/** An engine adapter under the fence wrapper, driven by hand: `poll` runs the wrapper's check, `emit` sends an engine event. */
function turnHarness(fence: BotMemoryGuard, pid: number) {
  const listeners = new Set<RuntimeEventListener>(), steers: string[] = [];
  const adapter = {
    onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async () => ({}),
    enginePid: () => pid,
    steer: async (_thread: string, text: string) => { steers.push(text); return "steered" as const; },
  } as unknown as ProviderAdapter;
  let tick: (() => void) | null = null;
  const wrapped = withMemoryFence({ driverKind: "claudeAgent", adapter } as unknown as ProviderInstance, { fence, every: (_ms, fn) => { tick = fn; return () => { tick = null; }; }, log: () => {} });
  const seen: RuntimeEvent[] = [];
  wrapped.adapter.onEvent((value) => seen.push(value));
  return {
    steers,
    notices: () => (seen.filter((value) => value.type === "runtime.notice") as Notice[]).map((notice) => ({ text: notice.text, turnId: notice.turnId })),
    send: () => wrapped.adapter.sendTurn({ threadId: "t1" } as never),
    poll: () => tick?.(),
    polling: () => tick !== null,
    emit: (value: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ threadId: "t1", ...value } as RuntimeEvent); },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

const STOP = (helper: number): JobFenceEvent => ({ event: "memory-stop", pid: 900, name: "python.exe", bytes: 3 * GIB, jobBytes: 4 * GIB, limitBytes: 4 * GIB, root: 600, helper, by: 900 });

describe("telling a turn that the memory limit for bots stopped one of its programs (AC-09)", () => {
  it("on Windows steers the bot and tells the person with the same words as on Linux", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    const turn = turnHarness(guard, 500);
    await turn.send();
    turn.poll();
    event(state, STOP(500));
    turn.poll();
    await turn.settle();
    expect(turn.steers).toEqual([fenceOomBotText("4")]);
    expect(turn.notices()).toEqual([{ text: { key: "chat.notice.memoryFenceStop", params: { gb: "4" } }, turnId: undefined }]);
  });

  it("on Windows tells the person when the job's report comes after the end of the turn that the stop ended", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    const turn = turnHarness(guard, 500);
    await turn.send();
    turn.poll();
    turn.emit({ type: "turn.completed", turnId: "u1", ok: false } as Partial<RuntimeEvent>);
    expect(turn.notices()).toEqual([]);
    event(state, STOP(500));
    turn.poll();
    await turn.settle();
    expect(turn.steers).toEqual([]);
    expect(turn.notices()).toEqual([{ text: { key: "chat.notice.memoryFenceStopUntold", params: { gb: "4" } }, turnId: "u1" }]);
    expect(turn.polling()).toBe(false);
  });

  it("on Windows ends the wait after two checks when no stop comes, and does not wait after a turn that ended well", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    const failed = turnHarness(guard, 500);
    await failed.send();
    failed.emit({ type: "turn.completed", turnId: "u1", ok: false } as Partial<RuntimeEvent>);
    failed.poll();
    expect(failed.polling()).toBe(true);
    failed.poll();
    expect(failed.polling()).toBe(false);
    event(state, STOP(500));
    expect(failed.notices()).toEqual([]);

    const done = turnHarness(guard, 501);
    await done.send();
    done.emit({ type: "turn.completed", turnId: "u2", ok: true } as Partial<RuntimeEvent>);
    expect(done.polling()).toBe(false);
  });

  it("on Windows makes the last check of an ended turn when the next turn starts first", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    const turn = turnHarness(guard, 500);
    await turn.send();
    turn.emit({ type: "turn.completed", turnId: "u1", ok: false } as Partial<RuntimeEvent>);
    event(state, STOP(500));
    await turn.send();
    await turn.settle();
    expect(turn.steers).toEqual([]);
    expect(turn.notices()).toEqual([{ text: { key: "chat.notice.memoryFenceStopUntold", params: { gb: "4" } }, turnId: "u1" }]);
  });

  it("on macOS steers the bot and tells the person when the watchdog stops a program of the turn's engine", async () => {
    const { guard, state } = fakes({ platform: "darwin" });
    await guard.start(() => []);
    expect(guard.lateStops()).toBe(false);
    const turn = turnHarness(guard, 301);
    await turn.send();
    turn.poll();
    state.dog!.onStop!({ botId: "b1", pid: 333, root: 301, name: "node", bytes: 2 * GIB, totalBytes: 5 * GIB, budgetBytes: 4 * GIB });
    turn.poll();
    await turn.settle();
    expect(turn.steers).toEqual([fenceOomBotText("4")]);
    expect(turn.notices()).toEqual([{ text: { key: "chat.notice.memoryFenceStop", params: { gb: "4" } }, turnId: undefined }]);
  });
});
