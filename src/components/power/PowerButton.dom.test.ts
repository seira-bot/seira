// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  admin: true as boolean | null,
  config: { pausedByPerson: { bots: [] as string[], departments: [] as string[] } } as { pausedByPerson: { bots: string[]; departments: string[]; all?: true } },
  bots: [] as Array<{ busy?: boolean; activity?: string }>,
  updater: null as null | { status: string; version?: string; installMode?: string },
  dispatch: vi.fn(),
}));
vi.mock("@/state/api", () => ({ api: async (path: string, init: { body: string }) => { fixture.calls.push({ path, body: JSON.parse(init.body) }); return { stopped: 0 }; } }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { config: fixture.config, bots: fixture.bots, groups: [] }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => fixture.updater }));

import { getPowerToast, getPowerVisor, resetPowerForTest } from "@/lib/power";
import { PowerButton } from "./PowerButton";
import { PowerHost } from "./PowerHost";

let container: HTMLDivElement, root: Root;
const relaunch = vi.fn(() => new Promise<void>(() => {}));
const quit = vi.fn(() => new Promise<void>(() => {}));
const install = vi.fn(() => new Promise<void>(() => {}));

const mount = async (host = false) => {
  await act(async () => root.render(createElement("div", null, createElement(PowerButton), host ? createElement(PowerHost) : null)));
};
const button = () => container.querySelector<HTMLButtonElement>("[data-power-button]")!;
const pill = () => document.querySelector<HTMLElement>("[data-power-pill]");
const item = (kind: string) => document.querySelector<HTMLButtonElement>(`[data-power-action="${kind}"]`)!;
const open = async () => { await act(async () => button().click()); };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  resetPowerForTest();
  fixture.calls = [];
  fixture.admin = true;
  fixture.config = { pausedByPerson: { bots: [], departments: [] } };
  fixture.bots = [];
  fixture.updater = null;
  relaunch.mockClear(); quit.mockClear(); install.mockClear();
  (window as unknown as { ogb: unknown }).ogb = { relaunch, quit, updater: { install } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetPowerForTest();
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-reduced-motion");
});

describe("the power button", () => {
  it("is absent without the desktop app", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    await mount();
    expect(button()).toBeNull();
  });

  it("opens into shut down, restart and pause, with focus on restart", async () => {
    await mount();
    await open();
    expect(pill()?.getAttribute("role")).toBe("menu");
    expect([...document.querySelectorAll("[role=menuitem]")].map((n) => n.getAttribute("data-power-action"))).toEqual(["shutdown", "restart", "pause"]);
    expect(document.activeElement).toBe(item("restart"));
    expect(button().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and on an outside press, and Escape returns focus to the button", async () => {
    await mount();
    await open();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await advance(320);
    expect(pill()).toBeNull();
    expect(document.activeElement).toBe(button());
    await open();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await advance(320);
    expect(pill()).toBeNull();
  });

  it("closes at once under reduced motion", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    await mount();
    await open();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(pill()).toBeNull();
  });

  it("has no pause for someone who is not an owner or admin", async () => {
    fixture.admin = false;
    await mount();
    await open();
    expect(item("pause")).toBeNull();
    expect(document.querySelectorAll("[role=menuitem]")).toHaveLength(2);
  });
});

describe("press and hold", () => {
  const down = (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); });
  const up = (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })); });

  it("starts the restart after 800 ms of holding", async () => {
    await mount(true);
    await open();
    await down(item("restart"));
    await advance(799);
    expect(item("restart").getAttribute("data-state")).toBe("holding");
    expect(getPowerVisor().kind).toBeNull();
    await advance(1);
    expect(item("restart").getAttribute("data-state")).toBe("done");
    await advance(600);
    expect(getPowerVisor().kind).toBe("restart");
    await advance(3000);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("shuts down after the hold, then quits", async () => {
    await mount(true);
    await open();
    await down(item("shutdown"));
    await advance(800 + 600 + 4000);
    expect(getPowerVisor().kind).toBe("shutdown");
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when released before 800 ms", async () => {
    await mount(true);
    await open();
    await down(item("restart"));
    await advance(500);
    await up(item("restart"));
    expect(item("restart").getAttribute("data-state")).toBeNull();
    await advance(2000);
    expect(getPowerVisor().kind).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it.each([" ", "Enter"])("holds with the %j key, ignoring key repeat, and cancels on key up", async (key) => {
    await mount(true);
    await open();
    const target = item("restart");
    const press = (init: KeyboardEventInit, type = "keydown") => act(async () => { target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })); });
    await press({});
    await advance(400);
    await press({ repeat: true });
    await advance(399);
    expect(target.getAttribute("data-state")).toBe("holding");
    await press({}, "keyup");
    expect(target.getAttribute("data-state")).toBeNull();
    await press({});
    await advance(800);
    expect(target.getAttribute("data-state")).toBe("done");
    await advance(4000);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("offers Restart to update, and installs the downloaded version", async () => {
    fixture.updater = { status: "downloaded", version: "0.1.191" };
    await mount(true);
    expect(container.querySelector("[data-power-update]")).not.toBeNull();
    await open();
    expect(item("restart").getAttribute("aria-label")).toBe("Restart to update");
    await down(item("restart"));
    await advance(800 + 700 + 3000);
    expect(getPowerVisor()).toMatchObject({ kind: "update", version: "0.1.191" });
    expect(install).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("hands over to the installer without the visor when the update opens its own installer", async () => {
    fixture.updater = { status: "downloaded", version: "0.1.191", installMode: "handoff" };
    await mount(true);
    await open();
    await down(item("restart"));
    await advance(800 + 700);
    expect(install).toHaveBeenCalledTimes(1);
    expect(getPowerVisor().kind).toBeNull();
  });
});

describe("working bots", () => {
  const down = (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); });

  it("waits for the bots, says how many, and runs when the last one is done", async () => {
    fixture.bots = [{ activity: "working" }, { busy: true }];
    await mount(true);
    await open();
    await down(item("restart"));
    await advance(800 + 700);
    expect(getPowerVisor().kind).toBeNull();
    const toast = document.querySelector("[data-power-toast]");
    expect(toast?.textContent).toContain("2");
    expect(toast?.textContent).toContain("Restart now");
    expect(toast?.textContent).toContain("Cancel");
    fixture.bots = [];
    await mount(true);
    await advance(400);
    expect(getPowerVisor().kind).toBe("restart");
  });

  it("cancels the wait", async () => {
    fixture.bots = [{ activity: "working" }];
    await mount(true);
    await open();
    await down(item("shutdown"));
    await advance(800 + 700);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("[data-power-toast] button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    expect(document.querySelector("[data-power-toast]")).toBeNull();
    fixture.bots = [];
    await mount(true);
    await advance(2000);
    expect(getPowerVisor().kind).toBeNull();
  });
});

describe("pause", () => {
  it("pauses every bot at once, and the toast offers Undo", async () => {
    await mount(true);
    await open();
    await act(async () => item("pause").click());
    expect(fixture.calls).toEqual([{ path: "/api/paused", body: { kind: "all", paused: true } }]);
    expect(getPowerToast()?.actions.map((a) => a.label)).toEqual(["Undo"]);
    expect(document.querySelector("[data-power-toast]")?.textContent).toContain("Undo");
  });

  it("shows a paused light and offers to resume", async () => {
    fixture.config = { pausedByPerson: { bots: [], departments: [], all: true } };
    await mount();
    expect(container.querySelector("[data-power-light]")?.getAttribute("data-power-light")).toBe("paused");
    await open();
    expect(item("pause").getAttribute("aria-label")).toBe("Resume every bot");
    await act(async () => item("pause").click());
    expect(fixture.calls).toEqual([{ path: "/api/paused", body: { kind: "all", paused: false } }]);
  });
});
