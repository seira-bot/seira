import { describe, expect, it, vi } from "vitest";

import type { ServerUpdateStatus } from "../shared/server-update.ts";
import { createAutoUpdate, inWindow, startAutoUpdate } from "./auto-update.ts";
import { autoUpdateState } from "./server-update.ts";

const status = (over: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
  mode: "button", current: "0.1.150", latest: "0.1.151", available: true, activeTurns: 0,
  auto: { on: true, window: { start: "03:00", end: "05:00" } }, ...over,
});
const at = (hour: number, minute = 0, day = 5) => new Date(2026, 10, day, hour, minute);

function setup(over: Partial<ServerUpdateStatus> = {}, options: { failed?: string[] } = {}) {
  let clock = at(3, 30);
  let current = status(over);
  const requests: unknown[] = [];
  const auto = createAutoUpdate({
    status: async () => current,
    request: async (actor) => { requests.push(actor); return { status: 202, body: {} }; },
    now: () => clock,
    failed: () => options.failed ?? [],
  });
  return { auto, requests, set: (next: Date) => { clock = next; }, change: (next: Partial<ServerUpdateStatus>) => { current = status(next); } };
}

describe("the night window", () => {
  it("is 03:00 up to, not including, 05:00 local time", () => {
    expect(inWindow(at(2, 59))).toBe(false);
    expect(inWindow(at(3, 0))).toBe(true);
    expect(inWindow(at(4, 59))).toBe(true);
    expect(inWindow(at(5, 0))).toBe(false);
  });
});

describe("the night update of an npm install (AC-01)", () => {
  it("starts the update in the window when it is on, a release is available and no bot answers", async () => {
    const t = setup();
    expect(await t.auto.tick()).toBe("updating");
    expect(t.requests).toEqual([{ kind: "automatic" }]);
  });

  it("does nothing outside the window", async () => {
    const t = setup();
    for (const hour of [2, 5, 12, 23]) {
      t.set(at(hour, hour === 2 ? 59 : 0));
      expect(await t.auto.tick(), String(hour)).toBe("waiting");
    }
    expect(t.requests).toEqual([]);
  });

  it("does nothing when no release is available", async () => {
    const t = setup({ available: false });
    expect(await t.auto.tick()).toBe("waiting");
    expect(t.requests).toEqual([]);
  });

  it("does not start while a bot turn is active (AC-02)", async () => {
    const t = setup({ activeTurns: 1 });
    expect(await t.auto.tick()).toBe("waiting");
    t.change({ activeTurns: 0 });
    expect(await t.auto.tick()).toBe("updating");
    expect(t.requests).toHaveLength(1);
  });

  it("does not start while an update is already running", async () => {
    const t = setup({ run: { outcome: "running", from: "0.1.150", at: 1 } });
    expect(await t.auto.tick()).toBe("waiting");
    expect(t.requests).toEqual([]);
  });

  it("does not try a version that rolled back on this server (AC-06)", async () => {
    const t = setup({}, { failed: ["0.1.151"] });
    expect(await t.auto.tick()).toBe("waiting");
    expect(t.requests).toEqual([]);
  });

  it("tries a version once in a night, and again the next night", async () => {
    const t = setup();
    await t.auto.tick();
    t.set(at(3, 40));
    expect(await t.auto.tick()).toBe("waiting");
    t.set(at(3, 30, 6));
    expect(await t.auto.tick()).toBe("updating");
    expect(t.requests).toHaveLength(2);
  });
});

describe("what turns it off (AC-10)", () => {
  it("does nothing when an admin turned it off, the server's own settings do, or the host holds updates", async () => {
    for (const off of ["admin", "env", "held"] as const) {
      const t = setup({ auto: { on: false, window: { start: "03:00", end: "05:00" }, off } });
      expect(await t.auto.tick(), off).toBe("waiting");
      expect(t.requests, off).toEqual([]);
    }
  });

  it("reads each cause from the install, the settings and the environment", () => {
    expect(autoUpdateState({ held: false, admin: true, env: {} })).toEqual({ on: true, window: { start: "03:00", end: "05:00" } });
    expect(autoUpdateState({ held: false, admin: false, env: {} })).toMatchObject({ on: false, off: "admin" });
    expect(autoUpdateState({ held: true, admin: true, env: {} })).toMatchObject({ on: false, off: "held" });
    for (const value of ["0", "false", "off", "NO"]) expect(autoUpdateState({ held: false, admin: true, env: { SEIRA_AUTO_UPDATE: value } }), value).toMatchObject({ on: false, off: "env" });
    expect(autoUpdateState({ held: false, admin: true, env: { SEIRA_AUTO_UPDATE: "1" } }).on).toBe(true);
  });

  it("does nothing where the install has no button (a command, a held host, a managed server)", async () => {
    for (const mode of ["command", "held", "none"] as const) {
      const t = setup({ mode });
      expect(await t.auto.tick(), mode).toBe("waiting");
      expect(t.requests, mode).toEqual([]);
    }
  });
});

describe("a Docker install with the update runner (AC-09)", () => {
  it("makes the same request as the Update server button, for the automatic actor", async () => {
    const asked: unknown[] = [];
    const auto = createAutoUpdate({
      status: async () => status({ command: "cd /opt/seira && sudo ./update.sh" }),
      request: async (actor) => { asked.push(actor); return { status: 202, body: {} }; },
      now: () => at(4, 0), failed: () => [],
    });
    expect(await auto.tick()).toBe("updating");
    expect(asked).toEqual([{ kind: "automatic" }]);
  });
});

describe("the timer", () => {
  it("checks every 10 minutes and stops on stop", async () => {
    vi.useFakeTimers();
    try {
      let asks = 0;
      const timer = startAutoUpdate({ status: async () => { asks++; return status({ available: false }); }, request: async () => ({ status: 200, body: {} }), now: () => at(4, 0), failed: () => [] });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(asks).toBe(3);
      timer.stop();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(asks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
