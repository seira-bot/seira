// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";

class FixtureEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

let store!: ReturnType<typeof useStore>;
function StoreReader() { store = useStore(); return null; }
let root: Root;

const actEnvironment = (on: boolean) => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on; };

const answering = (status: number, body: Record<string, unknown>) => vi.stubGlobal("fetch", async (path: unknown) =>
  (String(path).endsWith("/messages") ? new Response(JSON.stringify(body), { status }) : new Response(JSON.stringify({ bots: [], groups: [], instances: [] }))));

beforeEach(() => {
  vi.stubGlobal("EventSource", FixtureEventSource);
  root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(StoreReader))));
});
afterEach(() => {
  flushSync(() => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps the news of a Send with no AI until the person acts, and hands the message back", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const line = "Olive needs to connect an AI before bots can answer. I've told them.";
    answering(409, { error: line, code: "no_ai" });
    const onError = vi.fn();
    store.dispatch({ type: "send", botId: "maus", threadId: "t", text: "Hello", onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.state.notice).toEqual({ kind: "no-ai", botName: null, text: line }));
    expect(store.state.error).toBeNull();
    actEnvironment(true);
    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(store.state.notice).toEqual({ kind: "no-ai", botName: null, text: line });
  } finally { actEnvironment(false); vi.useRealTimers(); }
});

it("lets an old notice's timer leave a newer notice alone", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  actEnvironment(true);
  try {
    act(() => store.dispatch({ type: "notice", notice: { kind: "note", botName: null, text: "first" } }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    const newer = { kind: "no-ai", botName: null, text: "second" } as const;
    act(() => store.dispatch({ type: "notice", notice: newer }));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(store.state.notice).toBe(newer);
  } finally { actEnvironment(false); vi.useRealTimers(); }
});

it("shows any other refusal as the error it is", async () => {
  answering(409, { error: "this thread is already working", code: "thread_busy" });
  const onError = vi.fn();
  store.dispatch({ type: "send", botId: "maus", threadId: "t", text: "Hello", onError });
  await vi.waitFor(() => expect(store.state.error).toBe("this thread is already working"));
  expect(store.state.notice).toBeNull();
});
