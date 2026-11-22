import { describe, expect, it } from "vitest";
import type { WireTask } from "../../shared/wire";
import { threadToContinue } from "./continue-thread";

const NOW = 10 * 86_400_000;
const DAY = 86_400_000;
const task = (threadId: string, extra: Partial<WireTask> = {}): WireTask =>
  ({ threadId, title: threadId, createdAt: NOW - 5 * DAY, updatedAt: NOW - DAY, busy: false, activity: "idle", ...extra }) as WireTask;

describe("threadToContinue", () => {
  it("picks the newest open chat with messages in it, never the current one", () => {
    const tasks = [task("current", { updatedAt: NOW }), task("a", { updatedAt: NOW - 2 * DAY }), task("b", { updatedAt: NOW - DAY })];
    expect(threadToContinue(tasks, "current", NOW)?.threadId).toBe("b");
  });

  it("skips a chat that is empty, archived, closed, a routine run or older than two weeks", () => {
    const tasks = [
      task("empty", { updatedAt: NOW - 5 * DAY }), task("archived", { archivedAt: 1 }), task("closed", { closedBy: { kind: "person" } as never }),
      task("routine", { routineRunId: "run" }), task("old", { createdAt: 0, updatedAt: NOW - 15 * DAY }),
    ];
    expect(threadToContinue(tasks, "current", NOW)).toBeNull();
  });

  it("returns null with no chats", () => {
    expect(threadToContinue(undefined, "current", NOW)).toBeNull();
  });
});
