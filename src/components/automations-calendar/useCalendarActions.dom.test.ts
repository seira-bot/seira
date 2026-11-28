// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarAutomation } from "@/lib/automation-calendar";
import type { Automation } from "@/lib/automations";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: {}, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { useCalendarActions } = await import("./useCalendarActions");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Actions = ReturnType<typeof useCalendarActions>;
let root: Root | null = null;
function mountHook(all: readonly Automation[]): { current: Actions } {
  const holder = {} as { current: Actions };
  const Probe = () => { holder.current = useCalendarActions(all); return null; };
  root = createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe)));
  return holder;
}

const member = (id: string, enabled: boolean) => ({ id, kind: "schedule", enabled }) as unknown as Automation;
const calendarAutomation = (id: string, enabled: boolean): CalendarAutomation => ({
  id, name: "Weekly digest", enabled, draft: false, manual: false, needsYou: false, statusLine: "", stepBotIds: [], runs: [],
  starts: [{ id, kind: "schedule", schedule: { type: "daily", time: "09:00", weekdays: [1] }, enabled }],
});

beforeEach(() => { fixture.dispatch.mockReset(); fixture.api.mockReset(); });
afterEach(() => { if (root) act(() => root!.unmount()); root = null; });

describe("the Calendar's actions", () => {
  it("saves a schedule with a PATCH of that schedule and gives the saved routine to the store", async () => {
    const saved = { id: "r1", schedule: { type: "daily", time: "14:00", weekdays: [2] } };
    fixture.api.mockResolvedValue({ routine: saved });
    const actions = mountHook([]);
    const schedule = { type: "daily" as const, time: "14:00", weekdays: [2] };
    await act(async () => { await actions.current.saveSchedule("r1", schedule); });
    expect(fixture.api).toHaveBeenCalledWith("/api/routines/r1", { method: "PATCH", body: JSON.stringify({ schedule }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routinePatched", routine: saved });
  });

  it("lets a failed save reach the caller and tells the store nothing", async () => {
    fixture.api.mockRejectedValue(new Error("offline"));
    const actions = mountHook([]);
    await expect(act(async () => { await actions.current.saveSchedule("r1", { type: "once", at: 1 }); })).rejects.toThrow("offline");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("switches a schedule automation off with a PATCH of enabled and reports the saved routine", async () => {
    fixture.api.mockResolvedValue({ routine: { id: "r1", enabled: false } });
    const actions = mountHook([member("r1", true)]);
    await act(async () => { await actions.current.toggle(calendarAutomation("r1", true)); });
    expect(fixture.api).toHaveBeenCalledWith("/api/routines/r1", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "routinePatched", routine: { id: "r1", enabled: false } });
    expect(actions.current.error).toBe("");
  });

  it("switches a paused automation on", async () => {
    fixture.api.mockResolvedValue({ routine: { id: "r1", enabled: true } });
    const actions = mountHook([member("r1", false)]);
    await act(async () => { await actions.current.toggle(calendarAutomation("r1", false)); });
    expect(fixture.api).toHaveBeenCalledWith("/api/routines/r1", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  });

  it("says the switch failed in plain words when the request fails", async () => {
    fixture.api.mockRejectedValue(new Error("offline"));
    const actions = mountHook([member("r1", true)]);
    await act(async () => { await actions.current.toggle(calendarAutomation("r1", true)); });
    expect(actions.current.error).toBe("Couldn't change Weekly digest. Try again.");
    expect(actions.current.busyId).toBeNull();
  });
});
