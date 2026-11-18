// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { mascotClock } from "../mascot-clock";
import { SeiraCharacter, type SeiraCharacterProps } from "./SeiraCharacter";
import { SEIRA_SCRIPTS, SEIRA_STATES } from "./states";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Created {
  calls: string[];
  ticks: number[];
  destroyed: number;
  options: { manual?: boolean; reduced?: boolean };
  config: { name?: string; hairColor?: string | null; style?: string; accessories?: readonly string[] };
  configs: Array<{ hairColor?: string | null; style?: string; accessories?: readonly string[] }>;
}

const fixture = vi.hoisted(() => ({ bots: [] as Created[], hold: null as Promise<void> | null }));

vi.mock("./kit", () => ({
  loadSeiraKit: () => Promise.resolve({
    bases: {},
    stickers: {},
    createBot: async (_el: HTMLElement, config: Created["config"], options: Created["options"]) => {
      const bot: Created = { calls: [], ticks: [], destroyed: 0, options, config, configs: [] };
      fixture.bots.push(bot);
      await fixture.hold;
      return {
        setState: (id: string) => bot.calls.push(`state:${id}`),
        express: (id: string, o?: { ms?: number }) => bot.calls.push(o?.ms ? `express:${id}:${o.ms}` : `express:${id}`),
        play: (id: string) => { bot.calls.push(`play:${id}`); return Promise.resolve(); },
        setConfig: (partial: Created["configs"][number]) => {
          bot.configs.push(partial);
          bot.calls.push(`hair:${partial.hairColor ?? "none"}`);
          return Promise.resolve();
        },
        tick: (ms?: number) => { bot.ticks.push(ms ?? 16); },
        destroy: () => { bot.destroyed++; },
      };
    },
  }),
}));

const observed: { callback: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null } = { callback: null };
class FakeIntersectionObserver {
  constructor(callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    observed.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

let reducedMotion = false;
const motionListeners = new Set<() => void>();
vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("reduce") && reducedMotion; },
  addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
}));

let hidden = false;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fixture.bots.length = 0;
  fixture.hold = null;
  reducedMotion = false;
  hidden = false;
  delete document.documentElement.dataset.reducedMotion;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
const flush = () => act(async () => {
  for (let pass = 0; pass < 4; pass++) await nextMacrotask();
});
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const render = (props: SeiraCharacterProps = {}) => act(() => root.render(createElement(SeiraCharacter, props)));
const cleanRender = () => {
  act(() => root.unmount());
  root = createRoot(host);
  render({});
};
const canvas = () => host.querySelector("canvas")!;
const bot = () => fixture.bots.at(-1)!;
const scriptCalls = (calls: string[]) => calls.filter((call) => !call.startsWith("hair:"));

describe("SeiraCharacter", () => {
  it("is hidden from screen readers when it has no label", () => {
    render({ state: "idle" });
    expect(canvas().getAttribute("aria-hidden")).toBe("true");
    expect(canvas().getAttribute("role")).toBeNull();
    expect(canvas().getAttribute("aria-label")).toBeNull();
  });

  it("names the character for screen readers when it has a label", async () => {
    render({ label: "Seira is thinking" });
    await flush();
    expect(canvas().getAttribute("role")).toBe("img");
    expect(canvas().getAttribute("aria-label")).toBe("Seira is thinking");
    expect(canvas().getAttribute("aria-hidden")).toBeNull();
  });

  it("reserves its square before the frames load", () => {
    render({ size: 240 });
    expect(canvas().style.width).toBe("240px");
    expect(canvas().style.height).toBe("240px");
    expect(canvas().dataset.ready).toBe("false");
  });

  it("starts the runtime on a clock that it moves itself", async () => {
    render({ size: 96 });
    await flush();
    expect(fixture.bots).toHaveLength(1);
    expect(bot().options).toMatchObject({ manual: true, reduced: false });
    expect(canvas().dataset.ready).toBe("true");
  });

  it("plays the script of each state", async () => {
    for (const state of SEIRA_STATES) {
      render({ state });
      await flush();
      const script = SEIRA_SCRIPTS[state];
      const expected = [
        `state:${script.runtime}`,
        script.expressionMs ? `express:${script.expression}:${script.expressionMs}` : `express:${script.expression ?? "calm"}`,
        ...(script.action ? [`play:${script.action}`] : []),
      ];
      expect(scriptCalls(bot().calls), state).toEqual(expected);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it("changes state without starting a second character", async () => {
    render({ state: "idle" });
    await flush();
    render({ state: "thinking" });
    await flush();
    expect(fixture.bots).toHaveLength(1);
    expect(scriptCalls(bot().calls).slice(-2)).toEqual(["state:thinking", "express:calm"]);
  });

  it("gives Seira the color of a bot for her hair, and takes it back", async () => {
    render({ hairColor: "green" });
    await flush();
    expect(bot().config.hairColor).toBe("#009957");
    render({ hairColor: "blue" });
    await flush();
    expect(bot().calls.at(-1)).toBe("hair:#377FE6");
    render({});
    await flush();
    expect(bot().calls.at(-1)).toBe("hair:none");
    expect(fixture.bots).toHaveLength(1);
  });

  it("starts the character with its hair style and accessories", async () => {
    render({ hairStyle: "bob", accessories: ["glasses", "cap"] });
    await flush();
    expect(bot().config.style).toBe("bob");
    expect(bot().config.accessories).toEqual(["glasses", "cap"]);
    cleanRender();
    await flush();
    expect(bot().config.style).toBe("seira");
    expect(bot().config.accessories).toEqual([]);
  });

  it("gives silver hair to a style other than Seira's own when the bot has no hair color", async () => {
    render({ hairStyle: "bun" });
    await flush();
    expect(bot().config.hairColor).toBe("#DADADF");
    render({ hairStyle: "bun", hairColor: "green" });
    await flush();
    expect(bot().configs.at(-1)?.hairColor).toBe("#009957");
  });

  it("keeps Seira's own hair for her own style", async () => {
    render({ hairStyle: "seira" });
    await flush();
    expect(bot().config.hairColor).toBeNull();
  });

  it("changes the hair style and the accessories without starting a second character", async () => {
    render({ hairStyle: "bob", accessories: ["glasses"] });
    await flush();
    render({ hairStyle: "spiky", accessories: ["glasses"] });
    await flush();
    expect(bot().configs.at(-1)).toMatchObject({ style: "spiky", accessories: ["glasses"] });
    render({ hairStyle: "spiky", accessories: ["glasses", "cap"] });
    await flush();
    expect(bot().configs.at(-1)).toMatchObject({ style: "spiky", accessories: ["glasses", "cap"] });
    expect(fixture.bots).toHaveLength(1);
  });

  it("does not configure the character again for the same accessories in a new array", async () => {
    render({ hairStyle: "bob", accessories: ["glasses", "cap"] });
    await flush();
    const count = bot().configs.length;
    render({ hairStyle: "bob", accessories: ["glasses", "cap"] });
    await flush();
    expect(bot().configs).toHaveLength(count);
  });

  it("draws on the shared clock about 30 times a second", async () => {
    render({ state: "working" });
    await flush();
    run(100);
    bot().ticks.length = 0;
    run(1000);
    expect(bot().ticks.length).toBeGreaterThanOrEqual(25);
    expect(bot().ticks.length).toBeLessThanOrEqual(35);
    expect(mascotClock().pending()).toBe(1);
  });

  it("pauses while it is off screen and resumes when it returns", async () => {
    render({});
    await flush();
    run(100);
    act(() => observed.callback!([{ target: canvas(), isIntersecting: false }]));
    expect(mascotClock().pending()).toBe(0);
    const before = bot().ticks.length;
    run(1000);
    expect(bot().ticks.length).toBe(before);
    act(() => observed.callback!([{ target: canvas(), isIntersecting: true }]));
    run(200);
    expect(bot().ticks.length).toBeGreaterThan(before);
    expect(Math.max(...bot().ticks)).toBeLessThanOrEqual(100);
  });

  it("pauses while the document is hidden", async () => {
    render({});
    await flush();
    run(100);
    hidden = true;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    const before = bot().ticks.length;
    run(1000);
    expect(bot().ticks.length).toBe(before);
    hidden = false;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    run(200);
    expect(bot().ticks.length).toBeGreaterThan(before);
  });

  it("stops the clock, the frames and every timer when it unmounts", async () => {
    render({ state: "greet" });
    await flush();
    run(100);
    act(() => root.unmount());
    root = createRoot(host);
    expect(bot().destroyed).toBe(1);
    expect(mascotClock().pending()).toBe(0);
    const before = bot().ticks.length;
    run(1000);
    expect(bot().ticks.length).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a character after it unmounts", async () => {
    render({});
    act(() => root.unmount());
    root = createRoot(host);
    await flush();
    expect(fixture.bots).toHaveLength(0);
    expect(mascotClock().pending()).toBe(0);
  });

  it("drops a character that finishes loading after it unmounts", async () => {
    let release = () => {};
    fixture.hold = new Promise<void>((resolve) => { release = resolve; });
    render({});
    await flush();
    expect(fixture.bots).toHaveLength(1);
    act(() => root.unmount());
    root = createRoot(host);
    release();
    await flush();
    expect(bot().destroyed).toBe(1);
    expect(mascotClock().pending()).toBe(0);
    expect(bot().ticks).toHaveLength(0);
  });
});

describe("SeiraCharacter with reduced motion", () => {
  it("shows a still frame and asks the clock for nothing", async () => {
    reducedMotion = true;
    render({ state: "greet" });
    await flush();
    expect(bot().options.reduced).toBe(true);
    expect(mascotClock().pending()).toBe(0);
    expect(bot().calls.some((call) => call.startsWith("play:"))).toBe(false);
    expect(scriptCalls(bot().calls)).toEqual(["state:idle", "express:happy"]);
    const ticks = bot().ticks.length;
    run(3000);
    expect(bot().ticks.length).toBe(ticks);
  });

  it("draws the new face when the state changes", async () => {
    reducedMotion = true;
    render({ state: "idle" });
    await flush();
    const ticks = bot().ticks.length;
    render({ state: "attention" });
    await flush();
    expect(scriptCalls(bot().calls).slice(-2)).toEqual(["state:listening", "express:surprised"]);
    expect(bot().ticks.length).toBeGreaterThan(ticks);
  });

  it("starts a still character when the person turns reduced motion on", async () => {
    render({ state: "working" });
    await flush();
    const live = bot();
    reducedMotion = true;
    act(() => motionListeners.forEach((listener) => listener()));
    await flush();
    expect(live.destroyed).toBe(1);
    expect(bot()).not.toBe(live);
    expect(bot().options.reduced).toBe(true);
    expect(mascotClock().pending()).toBe(0);
  });

  it("follows the reduced motion setting of the app", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    render({});
    await flush();
    expect(bot().options.reduced).toBe(true);
    expect(mascotClock().pending()).toBe(0);
  });
});
