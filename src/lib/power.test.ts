// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/api", () => ({ api: vi.fn() }));
import {
  WAKE_KEY, WAKE_WINDOW_MS, cancelWait, getPowerToast, getPowerVisor, getPowerWait, pauseEveryBot, playWake, rememberWake, requestPower, resetPowerForTest, runRestart, runShutDown,
  runWaiting, takeWake, workingBotCount, type PowerDeps,
} from "./power";

const NEVER = new Promise<void>(() => {});
const flags = () => [...getPowerVisor().flags];

function deps(extra: Partial<PowerDeps> = {}): Required<PowerDeps> & { seen: string[][] } {
  const seen: string[][] = [];
  const snap = () => seen.push([getPowerVisor().kind ?? "none", ...flags()]);
  return {
    relaunch: () => { snap(); return NEVER; },
    install: () => { snap(); return NEVER; },
    quit: () => { snap(); return NEVER; },
    reduced: () => false,
    sleep: (ms) => (ms >= 15_000 ? NEVER : Promise.resolve()),
    now: () => 1_000_000,
    seen,
    ...extra,
  } as Required<PowerDeps> & { seen: string[][] };
}

beforeEach(() => {
  localStorage.clear();
  resetPowerForTest();
});
afterEach(() => {
  resetPowerForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("working bots", () => {
  it("counts a bot that works, or is busy and not waiting on the person", () => {
    expect(workingBotCount([{ activity: "working" }, { busy: true }, { busy: true, activity: "waiting-on-you" }, { activity: "idle" }, {}])).toBe(2);
    expect(workingBotCount(undefined)).toBe(0);
  });
});

describe("the wake marker", () => {
  it("is read once, and only within two minutes", () => {
    rememberWake({ kind: "update", version: "0.1.191", at: 1000 });
    expect(takeWake(1000 + WAKE_WINDOW_MS)).toEqual({ kind: "update", version: "0.1.191", at: 1000 });
    expect(localStorage.getItem(WAKE_KEY)).toBeNull();
    rememberWake({ kind: "restart", at: 1000 });
    expect(takeWake(1000 + WAKE_WINDOW_MS + 1)).toBeNull();
    expect(takeWake(1000)).toBeNull();
  });

  it("ignores a damaged marker and blocked storage", () => {
    localStorage.setItem(WAKE_KEY, "{nope");
    expect(takeWake()).toBeNull();
    localStorage.setItem(WAKE_KEY, JSON.stringify({ kind: "shutdown", at: Date.now() }));
    expect(takeWake()).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(() => rememberWake({ kind: "restart", at: 1 })).not.toThrow();
    expect(takeWake()).toBeNull();
  });
});

describe("restart", () => {
  it("shows the visor with the restart text, then calls the desktop restart", async () => {
    const d = deps();
    void runRestart(null, d);
    await vi.waitFor(() => expect(d.seen).toHaveLength(1));
    expect(d.seen[0]).toEqual(expect.arrayContaining(["restart", "closed", "glint", "eyes", "shut", "text", "breathing"]));
    expect(JSON.parse(localStorage.getItem(WAKE_KEY)!)).toMatchObject({ kind: "restart", at: 1_000_000 });
  });

  it("installs the update instead, and remembers its version", async () => {
    const relaunch = vi.fn();
    const d = deps({ relaunch });
    void runRestart({ version: "0.1.191" }, d);
    await vi.waitFor(() => expect(d.seen).toHaveLength(1));
    expect(relaunch).not.toHaveBeenCalled();
    expect(d.seen[0]![0]).toBe("update");
    expect(getPowerVisor().version).toBe("0.1.191");
    expect(JSON.parse(localStorage.getItem(WAKE_KEY)!)).toMatchObject({ kind: "update", version: "0.1.191" });
  });

  it("opens the lids again and forgets the marker when the desktop refuses", async () => {
    await runRestart(null, deps({ relaunch: () => Promise.reject(new Error("no")) }));
    expect(getPowerVisor().kind).toBeNull();
    expect(localStorage.getItem(WAKE_KEY)).toBeNull();
  });

  it("uses one fade with still eyes under reduced motion", async () => {
    const d = deps({ reduced: () => true });
    void runRestart(null, d);
    await vi.waitFor(() => expect(d.seen).toHaveLength(1));
    expect(d.seen[0]).toEqual(expect.arrayContaining(["reduced", "closed", "eyes", "text"]));
    expect(d.seen[0]).not.toContain("shut");
  });
});

describe("shut down", () => {
  it("shows the visor with the shut down text, then calls the desktop quit", async () => {
    const d = deps();
    void runShutDown(d);
    await vi.waitFor(() => expect(d.seen).toHaveLength(1));
    expect(d.seen[0]).toEqual(expect.arrayContaining(["shutdown", "closed", "shut", "merge", "out"]));
    expect(localStorage.getItem(WAKE_KEY)).toBeNull();
  });

  it("opens the lids again when the desktop refuses to quit", async () => {
    await runShutDown(deps({ quit: () => Promise.reject(new Error("no")) }));
    expect(getPowerVisor().kind).toBeNull();
  });
});

describe("waiting for working bots", () => {
  it("waits while a bot works, runs when the person says now, and can be cancelled", async () => {
    const d = deps();
    expect(requestPower("restart", { update: null, working: 2, deps: d })).toBe("waiting");
    expect(requestPower("shutdown", { update: null, working: 0, deps: d })).toBe("waiting");
    expect(getPowerVisor().kind).toBeNull();
    expect(getPowerWait()).toMatchObject({ kind: "restart" });
    cancelWait();
    expect(getPowerWait()).toBeNull();
    expect(requestPower("restart", { update: null, working: 1, deps: d })).toBe("waiting");
    runWaiting(d);
    expect(getPowerVisor().kind).toBe("restart");
  });

  it("runs at once when no bot works", () => {
    expect(requestPower("shutdown", { update: null, working: 0, deps: deps() })).toBe("running");
    expect(getPowerVisor().kind).toBe("shutdown");
  });
});

describe("the wake after a restart", () => {
  it("opens the lids and says the app restarted", async () => {
    rememberWake({ kind: "restart", at: 1_000_000 - 5_000 });
    expect(await playWake(deps())).toBe(true);
    expect(getPowerVisor().kind).toBeNull();
    expect(getPowerToast()).toMatchObject({ text: expect.stringContaining("restarted"), ok: true });
  });

  it("names the version after an update", async () => {
    rememberWake({ kind: "update", version: "0.1.191", at: 1_000_000 });
    await playWake(deps());
    expect(getPowerToast()?.text).toContain("0.1.191");
  });

  it("does nothing without a recent marker", async () => {
    expect(await playWake(deps())).toBe(false);
    expect(getPowerToast()).toBeNull();
    rememberWake({ kind: "restart", at: 1_000_000 - WAKE_WINDOW_MS - 1 });
    expect(await playWake(deps())).toBe(false);
    expect(getPowerVisor().kind).toBeNull();
  });
});

describe("pausing every bot", () => {
  it("pauses, and the toast offers Undo", async () => {
    const set = vi.fn(async () => undefined);
    expect(await pauseEveryBot(true, { set })).toBe(true);
    expect(set).toHaveBeenCalledWith(true);
    const toast = getPowerToast()!;
    expect(toast.actions.map((a) => a.label)).toEqual(["Undo"]);
    toast.actions[0]!.run();
    await vi.waitFor(() => expect(set).toHaveBeenLastCalledWith(false));
  });

  it("reports a failure and shows no toast", async () => {
    const onError = vi.fn();
    expect(await pauseEveryBot(true, { set: async () => { throw new Error("offline"); }, onError })).toBe(false);
    expect(onError).toHaveBeenCalledWith("offline");
    expect(getPowerToast()).toBeNull();
  });
});
