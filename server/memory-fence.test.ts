import { describe, expect, it } from "vitest";

import { GIB } from "./bot-memory-budget.ts";
import type { ProviderAdapter, ProviderInstance, RuntimeEvent, RuntimeEventListener } from "./contracts.ts";
import { fenceArgv, fenceOomBotText, fenceSliceName, fenceWanted, findProgram, MemoryFence, sliceProperties, withMemoryFence, type FenceDeps } from "./memory-fence.ts";

const SLICE = "seira_bots_0123456789.slice";

describe("the slice name", () => {
  it("is stable for one data folder and differs between folders", () => {
    expect(fenceSliceName("/data/a")).toBe(fenceSliceName("/data/a"));
    expect(fenceSliceName("/data/a")).not.toBe(fenceSliceName("/data/b"));
    expect(fenceSliceName("/data/a")).toMatch(/^seira_bots_[0-9a-f]{10}\.slice$/);
  });
});

describe("whether the fence is wanted", () => {
  it("is on in the desktop app's server on Linux only, unless turned on or off", () => {
    expect(fenceWanted({ SEIRA_DESKTOP_PARENT: "1" }, "linux")).toBe(true);
    expect(fenceWanted({ SEIRA_DESKTOP_PARENT: "1" }, "win32")).toBe(false);
    expect(fenceWanted({}, "linux")).toBe(false);
    expect(fenceWanted({ SEIRA_BOT_MEMORY_FENCE: "on" }, "linux")).toBe(true);
    expect(fenceWanted({ SEIRA_BOT_MEMORY_FENCE: "on" }, "darwin")).toBe(false);
    expect(fenceWanted({ SEIRA_DESKTOP_PARENT: "1", SEIRA_BOT_MEMORY_FENCE: "off" }, "linux")).toBe(false);
    expect(fenceWanted({ SEIRA_DESKTOP_PARENT: "1", SEIRA_BOT_MEMORY_MAX_MB: "off" }, "linux")).toBe(false);
    expect(fenceWanted({ SEIRA_DESKTOP_PARENT: "1", SEIRA_BOT_MEMORY_MAX_MB: "0" }, "linux")).toBe(false);
  });
});

describe("the slice's properties", () => {
  it("set no swap and leave one CPU free, never less than one CPU of quota", () => {
    expect(sliceProperties(5 * GIB, 16)).toEqual([`MemoryMax=${5 * GIB}`, "MemorySwapMax=0", "CPUQuota=1500%"]);
    expect(sliceProperties(5 * GIB, 2)).toEqual([`MemoryMax=${5 * GIB}`, "MemorySwapMax=0", "CPUQuota=100%"]);
    expect(sliceProperties(5 * GIB, 1)[2]).toBe("CPUQuota=100%");
  });
});

describe("finding the system programs", () => {
  it("never takes a program from PATH, only from the system folders", () => {
    const has = new Set(["/home/bot/.local/bin/systemd-run", "/usr/bin/systemd-run", "/usr/bin/systemctl", "/usr/local/bin/env", "/run/current-system/sw/bin/true"]);
    const exists = (path: string) => has.has(path);
    expect(findProgram("systemd-run", exists)).toBe("/usr/bin/systemd-run");
    expect(findProgram("systemctl", exists)).toBe("/usr/bin/systemctl");
    expect(findProgram("true", exists)).toBe("/run/current-system/sw/bin/true");
    expect(findProgram("env", exists)).toBeNull();
  });

  it("does not run a program that a PATH folder holds", () => {
    const f = fakeDeps({ env: { SEIRA_DESKTOP_PARENT: "1", PATH: "/home/bot/.local/bin:/usr/bin" } });
    const planted = new Set(["/home/bot/.local/bin/systemd-run", "/home/bot/.local/bin/systemctl", "/home/bot/.local/bin/env", "/home/bot/.local/bin/true"]);
    const base = f.deps.exists!;
    f.deps.exists = (path) => planted.has(path) || base(path);
    const fence = new MemoryFence(f.deps);
    expect(fence.active()).toBe(true);
    expect(f.runs.every((run) => run.file.startsWith("/usr/bin/"))).toBe(true);
    expect(fence.argv("engine", [], {})?.command).toBe("/usr/bin/systemd-run");
  });
});

describe("the fenced command", () => {
  const base = { systemdRun: "/usr/bin/systemd-run", envProgram: "/usr/bin/env", slice: SLICE, oomPolicy: true, command: "bwrap", args: ["--", "engine"] };

  it("runs the command in a scope under the slice and keeps the environment when the bus variables are already there", () => {
    const env = { PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" };
    expect(fenceArgv({ ...base, env, processEnv: env })).toEqual({
      command: "/usr/bin/systemd-run",
      args: ["--user", "--scope", "--quiet", "--collect", `--slice=${SLICE}`, "-p", "OOMPolicy=continue", "--", "bwrap", "--", "engine"],
      env,
    });
  });

  it("adds the bus variables the spawn lacks and strips them again before the command", () => {
    const fenced = fenceArgv({ ...base, env: { PATH: "/bin" }, processEnv: { XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" } });
    expect(fenced.env).toEqual({ PATH: "/bin", XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus" });
    expect(fenced.args.slice(fenced.args.indexOf("--") + 1)).toEqual(["/usr/bin/env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS", "--", "bwrap", "--", "engine"]);
  });

  it("leaves out the out-of-memory policy where the user manager does not know it", () => {
    expect(fenceArgv({ ...base, oomPolicy: false, env: {}, processEnv: {} }).args).not.toContain("OOMPolicy=continue");
  });
});

interface Run { file: string; args: readonly string[] }
const CGROUP_DIR = `/sys/fs/cgroup/user.slice/user-1.slice/user@1.service/app.slice/${SLICE}`;

/** `memoryMax`: what the kernel reports for the slice's limit; the budget by default, null for no file. */
function fakeDeps(options: { failures?: (run: Run) => boolean; budget?: () => number | null; env?: NodeJS.ProcessEnv; memoryMax?: string | null } = {}) {
  const runs: Run[] = [];
  const logs: string[] = [];
  const files = new Map<string, string>();
  const clock = { at: 0 };
  const deps: Partial<FenceDeps> = {
    env: options.env ?? { SEIRA_DESKTOP_PARENT: "1", PATH: "/only/node", XDG_RUNTIME_DIR: "/run/user/1" },
    platform: "linux",
    exists: (path) => path.startsWith("/usr/bin/"),
    cpus: () => 8,
    budget: options.budget ?? (() => 5 * GIB),
    slice: () => SLICE,
    log: (line) => logs.push(line),
    now: () => clock.at,
    read: (path) => {
      if (path === `${CGROUP_DIR}/memory.max` && !files.has(path)) {
        if (options.memoryMax === null) return null;
        return options.memoryMax ?? String(options.budget?.() ?? 5 * GIB);
      }
      return files.get(path) ?? null;
    },
    run: (file, args) => {
      const run = { file, args };
      runs.push(run);
      if (options.failures?.(run)) return { status: 1, stdout: "" };
      return { status: 0, stdout: args.includes("ControlGroup") ? "/user.slice/user-1.slice/user@1.service/app.slice/" + SLICE + "\n" : "" };
    },
  };
  return { deps, runs, logs, files, clock };
}

describe("the probe", () => {
  it("sets the slice, starts a scope in it, and wraps a spawn", () => {
    const f = fakeDeps();
    const fence = new MemoryFence(f.deps);
    expect(fence.active()).toBe(true);
    expect(fence.protection()).toBe("slice");
    expect(f.runs[0]).toEqual({ file: "/usr/bin/systemctl", args: ["--user", "set-property", "--runtime", SLICE, `MemoryMax=${5 * GIB}`, "MemorySwapMax=0", "CPUQuota=700%"] });
    expect(f.runs[1]!.file).toBe("/usr/bin/systemd-run");
    expect(f.runs[1]!.args).toContain("OOMPolicy=continue");
    // A sealed PATH holds only node's folder, so the test scope names its program by the full path.
    expect(f.runs[1]!.args.at(-1)).toBe("/usr/bin/true");
    const fenced = fence.argv("engine", ["x"], { PATH: "/bin" });
    expect(fenced?.command).toBe("/usr/bin/systemd-run");
    expect(fenced?.args.slice(-2)).toEqual(["engine", "x"]);
    const probes = f.runs.length;
    fence.active();
    expect(f.runs).toHaveLength(probes + 0);
  });

  it("falls back to a scope without the out-of-memory policy, and remembers it", () => {
    const f = fakeDeps({ failures: (run) => run.args.includes("OOMPolicy=continue") });
    const fence = new MemoryFence(f.deps);
    expect(fence.active()).toBe(true);
    expect(fence.argv("engine", [], {})?.args).not.toContain("OOMPolicy=continue");
  });

  it("is unavailable, with one plain log line, when the user manager refuses", () => {
    const f = fakeDeps({ failures: (run) => run.file.endsWith("systemd-run") });
    const fence = new MemoryFence(f.deps);
    expect(fence.active()).toBe(false);
    expect(fence.protection()).toBe("watchdog");
    expect(fence.argv("engine", [], {})).toBeNull();
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).not.toMatch(/systemctl|cgroup|\/sys\//);
  });

  it("is unavailable when the kernel reports no memory limit for the slice", () => {
    for (const memoryMax of [null, "max", "garbage", String(2 * GIB)]) {
      const f = fakeDeps({ memoryMax });
      const fence = new MemoryFence(f.deps);
      expect(fence.active()).toBe(false);
      expect(fence.protection()).toBe("watchdog");
      expect(f.logs).toHaveLength(1);
      expect(f.logs[0]).toContain("memory controller");
    }
  });

  it("takes a limit that the kernel rounded to its page size", () => {
    const f = fakeDeps({ memoryMax: String(5 * GIB - 4096) });
    expect(new MemoryFence(f.deps).protection()).toBe("slice");
  });

  it("checks that the user manager answers at most every 10 seconds, and stops the fence when it does not", () => {
    const f = fakeDeps({ failures: (run) => run.args.includes("Version") || (probeAgain && run.args.includes("set-property")) });
    let probeAgain = false;
    const fence = new MemoryFence(f.deps);
    const checks = () => f.runs.filter((run) => run.args.includes("Version")).length;
    expect(fence.argv("a", [], {})).not.toBeNull();
    expect(checks()).toBe(0);
    f.clock.at = 9_999;
    expect(fence.argv("b", [], {})).not.toBeNull();
    expect(checks()).toBe(0);
    f.clock.at = 10_000;
    probeAgain = true;
    expect(fence.argv("c", [], {})).toBeNull();
    expect(checks()).toBe(1);
    expect(fence.protection()).toBe("watchdog");
    expect(f.logs).toHaveLength(1);
    const runs = f.runs.length;
    f.clock.at = 60_000;
    expect(fence.argv("d", [], {})).toBeNull();
    expect(f.runs).toHaveLength(runs);
  });

  it("keeps the fence when the user manager answers the check, with a version", () => {
    const f = fakeDeps();
    const fence = new MemoryFence({ ...f.deps, run: (file, args) => (args.includes("Version") ? { status: 0, stdout: "257\n" } : f.deps.run!(file, args)) });
    expect(fence.argv("a", [], {})).not.toBeNull();
    f.clock.at = 10_000;
    expect(fence.argv("b", [], {})).not.toBeNull();
    expect(fence.protection()).toBe("slice");
  });

  it("probes again after a failed check and goes on when that works", () => {
    let down = true;
    const f = fakeDeps();
    const fence = new MemoryFence({ ...f.deps, run: (file, args) => (args.includes("Version") ? { status: down ? 1 : 0, stdout: down ? "" : "257\n" } : f.deps.run!(file, args)) });
    expect(fence.argv("a", [], {})).not.toBeNull();
    f.clock.at = 10_000;
    down = false;
    fence.recheck();
    expect(fence.argv("b", [], {})).not.toBeNull();
    down = true;
    f.clock.at = 20_000;
    expect(fence.argv("c", [], {})).not.toBeNull();
    expect(f.runs.filter((run) => run.args.includes("set-property"))).toHaveLength(2);
  });

  it("checks at once after recheck, inside the 10 seconds", () => {
    const f = fakeDeps({ failures: (run) => run.args.includes("Version") });
    const fence = new MemoryFence(f.deps);
    expect(fence.argv("a", [], {})).not.toBeNull();
    fence.recheck();
    f.clock.at = 1_000;
    expect(fence.argv("b", [], {})).not.toBeNull();
    expect(f.runs.filter((run) => run.args.includes("Version"))).toHaveLength(1);
  });

  it("does nothing where the fence is not wanted", () => {
    const f = fakeDeps({ env: {} });
    const fence = new MemoryFence(f.deps);
    expect(fence.active()).toBe(false);
    expect(fence.protection()).toBe("none");
    expect(f.runs).toEqual([]);
  });

  it("sets the limit again only when the budget changed", () => {
    let budget = 5 * GIB;
    const f = fakeDeps({ budget: () => budget });
    const fence = new MemoryFence(f.deps);
    fence.argv("a", [], {});
    const sets = () => f.runs.filter((run) => run.args.includes("set-property")).length;
    expect(sets()).toBe(1);
    fence.argv("b", [], {});
    expect(sets()).toBe(1);
    budget = 7 * GIB;
    fence.argv("c", [], {});
    expect(sets()).toBe(2);
    expect(f.runs.filter((run) => run.args.includes("set-property")).at(-1)!.args).toContain(`MemoryMax=${7 * GIB}`);
  });

  it("reads the slice's counters and a scope's, only for a process under the slice", () => {
    const f = fakeDeps();
    const fence = new MemoryFence(f.deps);
    const dir = `/user.slice/user-1.slice/user@1.service/app.slice/${SLICE}`;
    f.files.set(`/sys/fs/cgroup${dir}/memory.events`, "low 0\nmax 3\noom 1\noom_kill 2\n");
    f.files.set(`/sys/fs/cgroup${dir}/memory.current`, "12345\n");
    f.files.set("/proc/10/cgroup", `0::${dir}/run-p10-i1.scope\n`);
    f.files.set(`/sys/fs/cgroup${dir}/run-p10-i1.scope/memory.events`, "oom_kill 1\n");
    f.files.set("/proc/11/cgroup", "0::/user.slice/other.scope\n");
    expect(fence.active()).toBe(true);
    expect(fence.sliceKills()).toBe(2);
    expect(fence.sliceCurrent()).toBe(12345);
    f.files.set(`/sys/fs/cgroup${dir}/memory.stat`, "anon 100\ninactive_file 2345\nactive_file 7\n");
    expect(fence.sliceCurrent()).toBe(10000);
    f.files.set(`/sys/fs/cgroup${dir}/memory.stat`, "inactive_file 99999\n");
    expect(fence.sliceCurrent()).toBe(0);
    expect(fence.scopeKills(10)).toBe(1);
    expect(fence.scopeKills(11)).toBeNull();
    expect(fence.scopeKills(12)).toBeNull();
  });
});

function fakeEngine() {
  const listeners = new Set<RuntimeEventListener>();
  const steers: string[] = [];
  const state = { pid: undefined as number | undefined, pids: undefined as Map<string, number> | undefined, steer: "steered" as "steered" | "refused" | "none" };
  const adapter = {
    onEvent: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendTurn: async () => ({}),
    enginePid: (threadId: string) => (state.pids ? state.pids.get(threadId) : state.pid),
    steer: async (_thread: string, text: string) => { steers.push(text); return state.steer as "steered"; },
  } as unknown as ProviderAdapter;
  const instance = { driverKind: "claudeAgent", adapter } as unknown as ProviderInstance;
  const emit = (event: Record<string, unknown>) => { for (const listener of listeners) listener({ eventId: "e", provider: "claudeAgent", createdAt: "", ...event } as RuntimeEvent); };
  return { instance, steers, state, emit };
}

function fakeFence(over: { active?: boolean } = {}) {
  const state = { slice: 0 as number | null, scopes: new Map<number, number>(), active: over.active ?? true };
  const view = { active: () => state.active, sliceKills: () => state.slice, scopeKills: (pid: number) => state.scopes.get(pid) ?? null, budgetBytes: () => 5 * GIB };
  return { state, view };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("telling a turn that a program ran out of memory", () => {
  function watch(options: { active?: boolean } = {}) {
    const engine = fakeEngine(), fence = fakeFence(options);
    let poll: (() => void) | null = null, timers = 0;
    const logs: string[] = [];
    const wrapped = withMemoryFence(engine.instance, { fence: fence.view, every: (_ms, fn) => { poll = fn; timers++; return () => { poll = null; }; }, log: (line) => logs.push(line) });
    const seen: RuntimeEvent[] = [];
    wrapped.adapter.onEvent((event) => seen.push(event));
    return { engine, fence, wrapped, seen, logs, poll: () => poll?.(), timers: () => timers, running: () => poll !== null };
  }
  const notices = (seen: RuntimeEvent[]) => seen.filter((event) => event.type === "runtime.notice") as Array<RuntimeEvent & { message: string; text?: { key: string; params?: { gb: string } } }>;

  it("tells the bot once, with the limit and the advice, and the person in one line", async () => {
    const w = watch();
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    expect(w.running()).toBe(true);
    w.poll();
    expect(w.engine.steers).toEqual([]);
    w.fence.state.slice = 1;
    w.fence.state.scopes.set(10, 1);
    w.poll();
    await settle();
    expect(w.engine.steers).toHaveLength(1);
    expect(w.engine.steers[0]).toContain("5 GB");
    expect(w.engine.steers[0]).toContain("fewer parallel workers");
    expect(w.engine.steers[0]).toBe(fenceOomBotText("5"));
    const lines = notices(w.seen);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toEqual({ key: "chat.notice.memoryFenceStop", params: { gb: "5" } });
    expect(lines[0]!.message).toBe("A program in this task used all the memory set aside for bots on this computer (5 GB), so it was stopped. Your other apps kept running. The bot will try a lighter way.");
    w.fence.state.slice = 1;
    w.poll();
    await settle();
    expect(w.engine.steers).toHaveLength(1);
    w.fence.state.slice = 2;
    w.fence.state.scopes.set(10, 2);
    w.poll();
    await settle();
    expect(w.engine.steers).toHaveLength(2);
  });

  it("does not tell a turn whose own scope was not hit", async () => {
    const w = watch();
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.fence.state.slice = 1;
    w.poll();
    await settle();
    expect(w.engine.steers).toEqual([]);
    expect(notices(w.seen)).toEqual([]);
  });

  it("tells the only running turn when no scope can be read", async () => {
    const w = watch();
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.fence.state.slice = 1;
    w.poll();
    await settle();
    expect(w.engine.steers).toHaveLength(1);
    expect(notices(w.seen)).toHaveLength(1);
  });

  it("shows the person the line and writes one log line when the bot cannot be steered", async () => {
    const w = watch();
    w.engine.state.steer = "refused";
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.fence.state.slice = 1;
    w.poll();
    await settle();
    expect(notices(w.seen)).toHaveLength(1);
    expect(notices(w.seen)[0]!.text).toEqual({ key: "chat.notice.memoryFenceStopUntold", params: { gb: "5" } });
    expect(notices(w.seen)[0]!.message).toBe("A program in this task used all the memory set aside for bots on this computer (5 GB), so it was stopped. Your other apps kept running.");
    expect(w.logs).toHaveLength(1);
  });

  it("says nothing when no turn runs, and stops its timer when the turn ends", async () => {
    const w = watch();
    expect(w.timers()).toBe(0);
    w.fence.state.slice = 5;
    w.poll();
    expect(notices(w.seen)).toEqual([]);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    expect(w.running()).toBe(true);
    w.engine.emit({ type: "turn.completed", threadId: "t1", turnId: "u", ok: true });
    expect(w.running()).toBe(false);
  });

  it("checks once more as the turn ends, and shows the line before the end", async () => {
    const w = watch();
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.fence.state.scopes.set(10, 1);
    w.engine.emit({ type: "turn.completed", threadId: "t1", turnId: "u", ok: false });
    expect(w.seen.map((event) => event.type)).toEqual(["runtime.notice", "turn.completed"]);
    expect(notices(w.seen)[0]!.text?.key).toBe("chat.notice.memoryFenceStopUntold");
    expect(w.engine.steers).toEqual([]);
    expect(w.logs).toHaveLength(1);
  });

  it("does not tell the same stop again as the turn ends, when the engine is gone and only the slice can be read", async () => {
    const w = watch();
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.fence.state.slice = 1;
    w.fence.state.scopes.set(10, 1);
    w.poll();
    await settle();
    expect(w.engine.steers).toHaveLength(1);
    w.engine.state.pid = undefined;
    w.engine.emit({ type: "turn.completed", threadId: "t1", turnId: "u", ok: true });
    expect(notices(w.seen)).toHaveLength(1);
    expect(w.logs).toEqual([]);
  });

  it("tells a turn that ended with its engine gone by the pid it learned while it ran", async () => {
    const w = watch();
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.poll();
    w.engine.state.pid = undefined;
    w.fence.state.scopes.set(10, 1);
    w.engine.emit({ type: "turn.completed", threadId: "t1", turnId: "u", ok: false });
    expect(w.seen.map((event) => event.type)).toEqual(["runtime.notice", "turn.completed"]);
    expect(notices(w.seen)[0]!.text?.key).toBe("chat.notice.memoryFenceStopUntold");
  });

  it("learns the pid from an event or a poll of a turn that began before its engine", async () => {
    const w = watch();
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    w.engine.state.pid = 10;
    w.fence.state.scopes.set(10, 0);
    w.poll();
    w.engine.state.pid = undefined;
    w.fence.state.scopes.set(10, 1);
    w.fence.state.slice = 1;
    w.engine.emit({ type: "turn.completed", threadId: "t1", turnId: "u", ok: false });
    expect(notices(w.seen)).toHaveLength(1);
  });

  it("does not tell the turn that was not hit, when two run and the other one's engine is gone at its end", async () => {
    const w = watch();
    w.engine.state.pids = new Map([["a", 10], ["b", 11]]);
    w.fence.state.scopes.set(10, 0);
    w.fence.state.scopes.set(11, 0);
    await w.wrapped.adapter.sendTurn({ threadId: "a" } as never);
    await w.wrapped.adapter.sendTurn({ threadId: "b" } as never);
    w.fence.state.slice = 1;
    w.fence.state.scopes.set(10, 1);
    w.poll();
    await settle();
    const told = notices(w.seen);
    expect(told).toHaveLength(1);
    expect(told[0]!.threadId).toBe("a");
    w.engine.state.pids.delete("b");
    w.engine.emit({ type: "turn.completed", threadId: "b", turnId: "u", ok: true });
    expect(notices(w.seen)).toHaveLength(1);
    expect(w.engine.steers).toHaveLength(1);
  });

  it("does not tell either of two turns from the slice alone", async () => {
    const w = watch();
    await w.wrapped.adapter.sendTurn({ threadId: "a" } as never);
    await w.wrapped.adapter.sendTurn({ threadId: "b" } as never);
    w.fence.state.slice = 1;
    w.poll();
    w.engine.emit({ type: "turn.completed", threadId: "a", turnId: "u", ok: true });
    expect(notices(w.seen)).toEqual([]);
  });

  it("watches nothing where the fence is not active", async () => {
    const w = watch({ active: false });
    await w.wrapped.adapter.sendTurn({ threadId: "t1" } as never);
    expect(w.timers()).toBe(0);
  });
});
