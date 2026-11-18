// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MausAvatar, type MausAvatarHandle, type MausAvatarProps } from "./Avatar";
import { mascotClock } from "./mascot-clock";
import { UNREAD_NOTICE_MS, useUnreadNotice } from "./unread-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  reducedMotion = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (avatars: Array<Partial<MausAvatarProps> & { ref?: React.Ref<MausAvatarHandle> }>) =>
  act(() => root.render(avatars.map((props, key) => createElement(MausAvatar, { key, color: "green", ...props }))));
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

const startleAll = (refs: Array<React.RefObject<MausAvatarHandle | null>>) =>
  act(() => { for (const ref of refs) ref.current!.spin(); });

const eyeHeight = () => Number(host.querySelector("g[clip-path] > rect")!.getAttribute("height"));

describe("MausAvatar on the shared clock", () => {
  it("draws every moving mascot from one animation frame", () => {
    const refs = Array.from({ length: 12 }, () => createRef<MausAvatarHandle>());
    render(refs.map((ref) => ({ state: "working" as const, size: 96, ref })));
    run(100);
    startleAll(refs);
    frameRequests = 0;
    run(1000);
    expect(frameRequests).toBeGreaterThan(30);
    expect(frameRequests).toBeLessThanOrEqual(70);
    expect(mascotClock().pending()).toBe(12);
  });

  it("draws a sidebar full of moving mascots 20 times a second", () => {
    const refs = Array.from({ length: 12 }, () => createRef<MausAvatarHandle>());
    render(refs.map((ref, i) => ({ state: "working" as const, size: [24, 28, 42, 56][i % 4], ref })));
    run(100);
    startleAll(refs);
    frameRequests = 0;
    run(1000);
    expect(frameRequests).toBeGreaterThanOrEqual(18);
    expect(frameRequests).toBeLessThanOrEqual(21);
  });

  it("keeps an unread mascot on the clock for its notice, then draws nothing while the news waits", () => {
    function Row({ unread }: { unread: boolean }) {
      return createElement(MausAvatar, { color: "green", state: unread ? "notifying" : "idle", size: 42, animated: useUnreadNotice(unread) });
    }
    act(() => root.render(createElement(Row, { unread: false })));
    run(200);
    expect(mascotClock().pending()).toBe(0);
    act(() => root.render(createElement(Row, { unread: true })));
    run(2000);
    expect(mascotClock().pending()).toBe(1);
    run(UNREAD_NOTICE_MS);
    run(100);
    frameRequests = 0;
    run(30_000);
    expect(frameRequests).toBe(0);
    expect(mascotClock().pending()).toBe(0);
  });

  it("stops drawing a mascot that leaves the screen, and resumes when it returns", () => {
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "working", size: 36, ref }]);
    run(200);
    startleAll([ref]);
    run(100);
    act(() => observed.callback!([{ target: host.querySelector("svg")!, isIntersecting: false }]));
    frameRequests = 0;
    run(500);
    expect(frameRequests).toBe(0);
    act(() => observed.callback!([{ target: host.querySelector("svg")!, isIntersecting: true }]));
    run(400);
    expect(frameRequests).toBeGreaterThan(5);
  });

  it("lets a small idle Seira settle to no frames until her next glance or blink", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      render([{ state: "idle", size: 24 }]);
      run(100);
      frameRequests = 0;
      run(3000);
      expect(frameRequests).toBe(0);
      expect(mascotClock().pending()).toBe(1);
      run(1000);
      expect(frameRequests).toBeGreaterThan(3);
    } finally {
      random.mockRestore();
    }
  });

  it("draws a blink on a settled Seira, then settles again", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const ref = createRef<MausAvatarHandle>();
    try {
      render([{ state: "idle", size: 24, ref }]);
      run(100);
      const open = eyeHeight();
      frameRequests = 0;
      act(() => ref.current!.blink());
      run(150);
      expect(eyeHeight()).toBeLessThan(open * 0.7);
      run(1050);
      expect(frameRequests).toBeGreaterThan(3);
      expect(eyeHeight()).toBe(open);
      frameRequests = 0;
      run(1500);
      expect(frameRequests).toBe(0);
    } finally {
      random.mockRestore();
    }
  });

  it("holds still under reduced motion: no body motion, blinks or spins", () => {
    reducedMotion = true;
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "celebrate", size: 220, ref }]);
    run(200);
    const svg = host.querySelector("svg")!;
    expect(svg.querySelector("g > g:nth-child(2)")!.getAttribute("transform")).toBeNull();
    frameRequests = 0;
    act(() => { ref.current!.blink(); ref.current!.spin(); });
    run(2000);
    expect(frameRequests).toBe(0);
    expect(mascotClock().pending()).toBe(0);
  });

  it("calms an animating mascot when reduced motion is switched on", () => {
    render([{ state: "working", size: 36 }]);
    run(200);
    expect(mascotClock().pending()).toBe(1);
    reducedMotion = true;
    act(() => { for (const listener of motionListeners) listener(); });
    run(200);
    expect(mascotClock().pending()).toBe(0);
  });
});
