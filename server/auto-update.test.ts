import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerUpdateStatus } from "../shared/server-update.ts";
import { adminActorLabel } from "./admin-activity.ts";
import { AUTO_UPDATE_GAP_MS, AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_INTERVAL_MS, startAutoUpdate } from "./auto-update.ts";
import type { ServerUpdater } from "./server-update.ts";

const MIN = 60_000;
const button: ServerUpdateStatus = { mode: "button", current: "0.1.150", latest: "0.1.151", available: true, activeTurns: 0 };

function rig(options: { status?: () => ServerUpdateStatus | Promise<ServerUpdateStatus>; turns?: () => number; env?: NodeJS.ProcessEnv; answer?: number } = {}) {
  let now = 1_800_000_000_000;
  let tick: () => void = () => {};
  let stopped = false;
  const request = vi.fn(async () => ({ status: options.answer ?? 202, body: {} }));
  const updater: ServerUpdater = { status: async () => (options.status ?? (() => button))(), request };
  const handle = startAutoUpdate({
    updater, activeTurns: options.turns ?? (() => 0), env: options.env ?? {}, now: () => now,
    schedule: (fn, ms) => {
      expect(ms).toBe(AUTO_UPDATE_INTERVAL_MS);
      tick = fn;
      return () => { stopped = true; };
    },
  });
  return {
    request, handle, isStopped: () => stopped,
    async at(minutes: number) {
      now += minutes * MIN;
      tick();
      await vi.waitFor(() => expect(true).toBe(true));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("automatic server update", () => {
  it("asks for the update after ten idle minutes, as the automatic actor", async () => {
    const box = rig();
    await box.at(0);
    expect(box.request).not.toHaveBeenCalled();
    await box.at(15);
    expect(box.request).toHaveBeenCalledTimes(1);
    expect(box.request).toHaveBeenCalledWith({ kind: "auto-update" });
    expect(adminActorLabel({ kind: "auto-update" })).toBe("Automatic update");
    expect(AUTO_UPDATE_IDLE_MS).toBe(10 * MIN);
  });

  it("waits for ten idle minutes: a turn at any tick, from the server or the status, starts the count again", async () => {
    let turns = 0;
    let statusTurns = 0;
    const box = rig({ turns: () => turns, status: () => ({ ...button, activeTurns: statusTurns }) });
    await box.at(0);
    turns = 1;
    await box.at(15);
    turns = 0;
    await box.at(15);
    statusTurns = 1;
    await box.at(15);
    statusTurns = 0;
    await box.at(15);
    expect(box.request).not.toHaveBeenCalled();
    await box.at(15);
    expect(box.request).toHaveBeenCalledTimes(1);
  });

  it("asks at most once in six hours", async () => {
    const box = rig();
    await box.at(0);
    await box.at(15);
    for (let i = 0; i < 20; i++) await box.at(15);
    expect(box.request).toHaveBeenCalledTimes(1);
    await box.at(AUTO_UPDATE_GAP_MS / MIN);
    expect(box.request).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when there is nothing to press, a wait is on, a run is going, or the update went back before", async () => {
    const quiet: ServerUpdateStatus[] = [
      { ...button, mode: "held" },
      { ...button, mode: "command" },
      { ...button, mode: "none" },
      { ...button, available: false },
      { ...button, retryAt: 1 },
      { ...button, run: { outcome: "requested", from: "0.1.150", at: 1 } },
      { ...button, run: { outcome: "running", from: "0.1.150", at: 1 } },
      { ...button, run: { outcome: "rolled-back", from: "0.1.150", at: 1 } },
      { ...button, run: { outcome: "rollback-failed", target: "0.1.151", from: "0.1.150", at: 1 } },
    ];
    for (const status of quiet) {
      const box = rig({ status: () => status });
      await box.at(0);
      await box.at(15);
      await box.at(15);
      expect(box.request, JSON.stringify(status)).not.toHaveBeenCalled();
    }
    const newer = rig({ status: () => ({ ...button, run: { outcome: "rolled-back", target: "0.1.150", from: "0.1.149", at: 1 } }) });
    await newer.at(0);
    await newer.at(15);
    expect(newer.request).toHaveBeenCalledTimes(1);
  });

  it("is off when asked to be, and stops its timer", async () => {
    for (const value of ["off", "0", "false", "no", " OFF ", "No"]) {
      const schedule = vi.fn(() => () => {});
      startAutoUpdate({ updater: { status: async () => button, request: async () => ({ status: 202, body: {} }) }, activeTurns: () => 0, env: { SEIRA_AUTO_UPDATE: value }, schedule });
      expect(schedule, value).not.toHaveBeenCalled();
    }
    const on = rig({ env: { SEIRA_AUTO_UPDATE: "on" } });
    on.handle.stop();
    expect(on.isStopped()).toBe(true);
  });

  it("logs a failure once per tick and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = rig({ status: () => { throw new Error("no folder"); } });
    await broken.at(0);
    await broken.at(15);
    expect(warn).toHaveBeenCalledTimes(2);
    const refused = rig({ answer: 500 });
    warn.mockClear();
    await refused.at(0);
    await refused.at(15);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
