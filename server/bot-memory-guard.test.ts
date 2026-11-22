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

function fakes(over: Partial<GuardDeps> & { hold?: "ready" | "fails" } = {}) {
  const state = {
    holdOptions: null as JobHoldOptions | null, limits: [] as number[], stats: 0, alive: true,
    dog: null as TreeMemoryWatchdogOptions | null, dogStarted: 0, dogUsed: null as number | null, logs: [] as string[], now: 0,
  };
  const deps: Partial<GuardDeps> = {
    env: DESKTOP, platform: "win32", budget: () => 4 * GIB, helper: () => HELPER, dataDir: () => "C:\\Users\\a\\.seira",
    startHold: async (options) => {
      state.holdOptions = options;
      if (over.hold === "fails") return null;
      return {
        job: "Local\\Seira-bots-abc-77", pid: 77, limitBytes: () => options.limitBytes,
        setLimit: (bytes) => { state.limits.push(bytes); }, stats: () => { state.stats += 1; }, alive: () => state.alive, close: () => {},
      };
    },
    list: async () => [],
    machine: () => ({ totalBytes: 16 * GIB, availableBytes: 6 * GIB }),
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
    const { guard, state } = fakes();
    await guard.start(() => []);
    expect(guard.protection()).toBe("job");
    expect(state.dog).toBeNull();
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
    const { guard, state } = fakes();
    await guard.start(() => []);
    state.alive = false;
    state.holdOptions!.onExit!();
    expect(guard.protection()).toBe("watchdog");
    expect(state.dogStarted).toBe(1);
    expect(guard.argv("C:\\node.exe", [], {})).toBeNull();
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

describe("telling a turn on Windows that the job stopped one of its programs (AC-09)", () => {
  it("steers the bot and tells the person with the same words as on Linux", async () => {
    const { guard, state } = fakes();
    await guard.start(() => []);
    const listeners = new Set<RuntimeEventListener>(), steers: string[] = [];
    const adapter = {
      onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendTurn: async () => ({}),
      enginePid: () => 500,
      steer: async (_thread: string, text: string) => { steers.push(text); return "steered" as const; },
    } as unknown as ProviderAdapter;
    let poll: (() => void) | null = null;
    const wrapped = withMemoryFence({ driverKind: "claudeAgent", adapter } as unknown as ProviderInstance, { fence: guard, every: (_ms, fn) => { poll = fn; return () => { poll = null; }; }, log: () => {} });
    const seen: RuntimeEvent[] = [];
    wrapped.adapter.onEvent((value) => seen.push(value));
    await wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    poll!();
    event(state, { event: "memory-stop", pid: 900, name: "python.exe", bytes: 3 * GIB, jobBytes: 4 * GIB, limitBytes: 4 * GIB, root: 600, helper: 500, by: 900 });
    poll!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(steers).toEqual([fenceOomBotText("4")]);
    const notices = seen.filter((value) => value.type === "runtime.notice") as Array<RuntimeEvent & { text?: { key: string; params?: { gb: string } } }>;
    expect(notices.map((notice) => notice.text)).toEqual([{ key: "chat.notice.memoryFenceStop", params: { gb: "4" } }]);
  });
});
