// @vitest-environment happy-dom
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Action, AppState } from "@/state/store";
import { StoreSourceContext, type StoreSource } from "@/state/store-context";
import { ForkLinks } from "./ForkMessage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Task = { threadId: string; title: string; origin?: { threadId: string; messageId: string } };
const task = (threadId: string, title: string, messageId?: string): Task =>
  ({ threadId, title, ...(messageId ? { origin: { threadId: "main", messageId } } : {}) });

let state: AppState;
const listeners = new Set<() => void>();
const dispatched: Action[] = [];
const source: StoreSource = {
  getState: () => state,
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  dispatch: (action) => { dispatched.push(action); },
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
};
const change = (next: Partial<AppState> & { tasks?: Task[] }) => {
  const { tasks, ...rest } = next;
  state = { ...state, ...rest, ...(tasks ? { bots: [{ id: "a", tasks }] as unknown as AppState["bots"] } : {}) };
  act(() => { for (const listener of listeners) listener(); });
};

let root: Root;
let host: HTMLElement;
let drawn = 0;

beforeEach(() => {
  drawn = 0;
  dispatched.length = 0;
  state = { bots: [{ id: "a", tasks: [task("main", "Chat"), task("fork-1", "Side path", "m1")] }], groups: [] } as unknown as AppState;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(createElement(StoreSourceContext.Provider, { value: source },
      createElement(Profiler, { id: "forks", onRender: () => { drawn++; } },
        createElement(ForkLinks, { kind: "bot", ownerId: "a", threadId: "main", messageId: "m1", phone: false }))));
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const buttons = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

describe("ForkLinks", () => {
  it("shows the forks of its message", () => {
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]).toContain("Side path");
  });

  it("does not draw again for a store change that leaves its forks alone", () => {
    const before = drawn;
    change({ connected: false } as Partial<AppState>);
    change({ tasks: [task("main", "Chat renamed"), task("fork-1", "Side path", "m1")] });
    change({ tasks: [task("main", "Chat renamed"), task("fork-1", "Side path", "m1"), task("fork-9", "Other", "m2")] });
    expect(drawn).toBe(before);
  });

  it("shows a fork that is added, and a title that changes", () => {
    change({ tasks: [task("fork-1", "Side path", "m1"), task("fork-2", "Second path", "m1")] });
    expect(buttons()).toHaveLength(2);
    change({ tasks: [task("fork-1", "Renamed path", "m1"), task("fork-2", "Second path", "m1")] });
    expect(buttons()[0]).toContain("Renamed path");
  });

  it("opens the fork panel on a click", () => {
    act(() => { host.querySelector("button")!.click(); });
    expect(dispatched).toEqual([{ type: "openForkPanel", kind: "bot", ownerId: "a", threadId: "fork-1" }]);
  });
});
