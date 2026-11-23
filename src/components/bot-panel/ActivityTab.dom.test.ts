// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "@/lib/activity";
import type { Bot } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }) };
});

const { ActivityTab } = await import("./ActivityTab");
const { publishLiveFrame } = await import("@/lib/live-events");

const bot = {
  id: "scout", threadId: "thread-main", name: "Scout", title: "", description: "", soul: "", notifications: true, color: "green", unread: false, messages: [],
  tasks: [{ threadId: "thread-other", title: "Other" }],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
} as unknown as Bot;

const at = (daysAgo: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 5, 0, 0);
  return date.toISOString();
};
const row = (extra: Partial<ActivityRow>): ActivityRow =>
  ({ at: at(0, 10), threadId: "thread-main", tool: "Bash", app: null, label: "Run a command", outcome: "ran", ...extra });

let host: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const respond = (rows: ActivityRow[]) => fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ rows }) });
const mount = async () => {
  await act(async () => { root.render(createElement(ActivityTab, { bot })); });
};
const items = () => [...host.querySelectorAll<HTMLElement>("[data-activity-item]")];

beforeEach(() => {
  fixture.dispatch.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ActivityTab", () => {
  it("groups the bot's activity by day, with the app and time, and a mark for each outcome", async () => {
    respond([
      row({ label: "Wait", outcome: "running" }),
      row({ label: "Email", app: "Gmail", outcome: "waiting", at: at(0, 9) }),
      row({ label: "Delete", outcome: "denied", at: at(0, 8) }),
      row({ label: "Search", outcome: "failed", at: at(1, 11) }),
      row({ label: "Read", outcome: "allowed", at: at(1, 10) }),
    ]);
    await mount();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/bots/scout/activity?limit=100");
    expect(host.querySelector('[data-panel-tabpanel="activity"]')).not.toBeNull();
    const days = [...host.querySelectorAll("[data-activity-day]")];
    expect(days).toHaveLength(2);
    expect(days[0]!.textContent).toContain("Today");
    expect(days[1]!.textContent).toContain("Yesterday");
    expect(items().map((item) => item.dataset.activityOutcome)).toEqual(["running", "waiting", "denied", "failed", "allowed"]);
    expect(items()[1]!.textContent).toContain("Email");
    expect(items()[1]!.textContent).toMatch(/Gmail · \d\d:\d\d/);
    const mark = (index: number) => items()[index]!.querySelector("svg[role=img]")!;
    expect(mark(0).getAttribute("class")).toContain("animate-spin");
    expect(mark(0).getAttribute("aria-label")).toBe("Running");
    expect(mark(1).getAttribute("class")).toContain("text-warning");
    expect(mark(2).getAttribute("class")).toContain("text-danger");
    expect(mark(3).getAttribute("class")).toContain("text-danger");
    expect(mark(4).getAttribute("class")).toContain("text-success");
  });

  it("says it is loading, then empty", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(host.textContent).toContain("Loading…");
    await act(async () => { finish({ ok: true, json: () => Promise.resolve({ rows: [] }) }); });
    expect(host.textContent).toContain("Nothing yet. Once Scout runs a tool or asks for an approval, it shows up here.");
  });

  it("says why it could not load", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await mount();
    expect(host.textContent).toContain("Couldn't load: 500");
  });

  it("switches to the thread of an item from another thread, and stays on the current one", async () => {
    respond([row({ label: "Here" }), row({ label: "There", threadId: "thread-other" }), row({ label: "Stranger", threadId: "thread-unknown" })]);
    await mount();
    await act(async () => { items()[0]!.click(); });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await act(async () => { items()[1]!.click(); });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "thread-other" });
    await act(async () => { items()[2]!.click(); });
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reloads when a turn of the bot completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    respond([row({})]);
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const frame = (threadId: string) => ({ kind: "runtime", event: { type: "turn.completed", threadId } }) as never;
    await act(async () => { publishLiveFrame(frame("thread-elsewhere")); await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { publishLiveFrame(frame("thread-main")); await vi.advanceTimersByTimeAsync(500); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
