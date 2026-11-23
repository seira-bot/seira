// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLANCE_SEND_DELAY_MS, useGlance } from "./use-glance";
import { initialState, StoreContext, type AppState, type Bot } from "./store";
import { resetTurnLive } from "./turn-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const working = { id: "b1", name: "Felix", threadId: "t1", color: "blue", messages: [], busy: true, tasks: [] } as unknown as Bot;
const feed = vi.fn();
const unsubscribe = vi.fn();
const onAct = vi.fn(() => unsubscribe);
let root: Root;

function Probe() { useGlance(); return null; }
const mount = (bots: Bot[]) => act(async () => {
  root.render(createElement(StoreContext.Provider, { value: { state: { ...initialState, bots } as AppState, dispatch: vi.fn() } as never }, createElement(Probe)));
});
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setBridge = (on: boolean) => { (window as unknown as { ogb?: unknown }).ogb = on ? { glance: { feed, onAct } } : undefined; };

beforeEach(() => {
  vi.useFakeTimers();
  resetTurnLive();
  feed.mockClear(); onAct.mockClear(); unsubscribe.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  setBridge(false);
  vi.useRealTimers();
});

describe("useGlance", () => {
  it("does nothing without the desktop bridge", async () => {
    setBridge(false);
    await mount([working]);
    await wait(GLANCE_SEND_DELAY_MS * 2);
    expect(feed).not.toHaveBeenCalled();
    expect(onAct).not.toHaveBeenCalled();
  });

  it("sends the feed after the delay, and once for the same feed", async () => {
    setBridge(true);
    await mount([working]);
    expect(feed).not.toHaveBeenCalled();
    await wait(GLANCE_SEND_DELAY_MS);
    expect(feed).toHaveBeenCalledTimes(1);
    expect(feed.mock.calls[0]![0]).toMatchObject({ version: 1, bots: [{ botId: "b1", state: "working" }] });
    await mount([{ ...working }]);
    await wait(GLANCE_SEND_DELAY_MS * 2);
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it("registers one act handler and removes it on unmount", async () => {
    setBridge(true);
    await mount([working]);
    await mount([working, { ...working, id: "b2" }]);
    expect(onAct).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    root = createRoot(document.createElement("div"));
  });
});
