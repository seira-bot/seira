import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardCard } from "../../shared/board";
import type { LiveFrameListener } from "@/lib/live-events";

const fixture = vi.hoisted(() => ({ api: vi.fn(), listener: null as null | LiveFrameListener }));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/lib/live-events", () => ({
  listenLiveFrames: (listener: LiveFrameListener) => { fixture.listener = listener; return () => { fixture.listener = null; }; },
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { createBoardTask, loadBoard, resetBoardForTest, setBoardFilter, useBoardFilter, useBoardView, watchBoard } from "./board";
import { visibleCards } from "@/components/board/board-model";

const card = (id: string, botId = "scout"): BoardCard => ({
  id, kind: "thread", column: "working", state: "running", title: id, botId, createdAt: 1, updatedAt: 1,
});
const frame = (kind: string) => fixture.listener!.onFrame({ kind } as never);
const reads = () => fixture.api.mock.calls.filter(([path]) => path === "/api/board").length;

beforeEach(() => {
  vi.useFakeTimers();
  resetBoardForTest();
  fixture.api.mockReset();
  fixture.api.mockResolvedValue({ cards: [card("thread:a")] });
});
afterEach(() => vi.useRealTimers());

describe("the Board's state", () => {
  it("loads the cards", async () => {
    await loadBoard();
    expect(useBoardView()).toMatchObject({ loaded: true, failed: false, cards: [{ id: "thread:a" }] });
  });

  it("marks a failed load and keeps what it had", async () => {
    await loadBoard();
    fixture.api.mockRejectedValueOnce(new Error("down"));
    await loadBoard();
    expect(useBoardView()).toMatchObject({ loaded: true, failed: true, cards: [{ id: "thread:a" }] });
  });

  it.each(["bot", "group", "routine.run"])("reads again within a second of a %s frame, once for a burst", async (kind) => {
    const stop = watchBoard();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    frame(kind); frame(kind); frame(kind);
    await vi.advanceTimersByTimeAsync(999);
    expect(reads()).toBe(2);
    stop();
  });

  it("does not read again for other frames", async () => {
    const stop = watchBoard();
    await vi.advanceTimersByTimeAsync(0);
    frame("screen"); frame("workflow.run");
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads()).toBe(1);
    stop();
  });

  it("stops listening and drops a waiting read when the page closes", async () => {
    const stop = watchBoard();
    await vi.advanceTimersByTimeAsync(0);
    frame("bot");
    stop();
    expect(fixture.listener).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads()).toBe(1);
  });

  it("keeps the bot filter in memory and shows only that bot's cards", () => {
    expect(useBoardFilter()).toBeNull();
    setBoardFilter("scout");
    expect(useBoardFilter()).toBe("scout");
    const cards = [card("a", "scout"), card("b", "cleo")];
    expect(visibleCards(cards, "scout").map((one) => one.id)).toEqual(["a"]);
    expect(visibleCards(cards, null)).toHaveLength(2);
  });

  it("adds a task in two calls: a new conversation, then its first message", async () => {
    fixture.api.mockImplementation(async (path: string) => (path.endsWith("/tasks") ? { task: { threadId: "t1" } } : { cards: [] }));
    await createBoardTask("scout", "Write the brief");
    const [first, second] = fixture.api.mock.calls;
    expect(first).toEqual(["/api/bots/scout/tasks", { method: "POST", body: JSON.stringify({ select: false }) }]);
    expect(second![0]).toBe("/api/bots/scout/messages");
    expect(JSON.parse(second![1].body)).toMatchObject({ text: "Write the brief", threadId: "t1" });
  });
});
