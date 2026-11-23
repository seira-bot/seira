// @vitest-environment happy-dom
// The panel's big mascot rests while its bot is idle, so an open panel asks for no animation frames.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { PanelHero } from "./PanelHero";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

let frameRequests = 0;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frameRequests++;
    return raf(callback);
  };
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  frameRequests = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const hero = (busy: boolean) => createElement(PanelHero, {
  bot: { id: "b1", name: "Pepper", title: "", color: "green", busy } as unknown as Bot,
  activeState: busy ? "working" : "idle",
  patch: () => {},
  editorOpen: false,
  onToggleEditor: () => {},
});
const framesOver = (ms: number) => {
  frameRequests = 0;
  act(() => { vi.advanceTimersByTime(ms); });
  return frameRequests;
};

describe("PanelHero mascot", () => {
  it("holds still while the bot is idle", () => {
    act(() => root.render(hero(false)));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(framesOver(10_000)).toBe(0);
  });

  it("moves while the bot works, and rests again when it stops", () => {
    act(() => root.render(hero(true)));
    expect(framesOver(10_000)).toBeGreaterThan(0);
    act(() => root.render(hero(false)));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(framesOver(10_000)).toBe(0);
  });
});
