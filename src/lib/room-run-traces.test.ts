import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { groupActivityRuns } from "./activity-runs";
import { roomRunTraces } from "./room-run-traces";

const ada = { botId: "ada", name: "Ada", color: "blue" as const };
const tool = (id: string, turnId: string, at: number): Message => ({ id, role: "bot", kind: "activity", at, tool: { name: "Read", ok: true }, from: ada, turnId });
const digest = (id: string, turnId: string, at: number): Message => ({
  id, role: "bot", kind: "digest", at, text: "", from: ada,
  digest: { turnId, threadId: "main", at, steps: 1 },
} as unknown as Message);

describe("roomRunTraces", () => {
  it("links a work card to the digest of its turn and absorbs that digest row", () => {
    const messages = [tool("t1", "turn-1", 1), tool("t2", "turn-1", 2), digest("d1", "turn-1", 3)];
    const items = groupActivityRuns(messages);
    const traces = roomRunTraces(items, messages);
    const run = items.find((item) => item.kind === "run")!;
    expect(traces.byRun.get(run.id)?.at).toBe(3);
    expect(traces.absorbed.has("d1")).toBe(true);
  });

  it("keeps a digest that no card holds", () => {
    const messages = [tool("t1", "turn-1", 1), digest("d9", "other", 3)];
    const traces = roomRunTraces(groupActivityRuns(messages), messages);
    expect(traces.absorbed.size).toBe(0);
  });
});

describe("roomRunTraces duration", () => {
  it("carries the recorded duration of the turn to its card", () => {
    const row = { id: "d1", role: "bot", kind: "digest", at: 3, text: "", from: ada, digest: { turnId: "turn-1", threadId: "main", at: 3, steps: 1, durationMs: 2_000 } } as unknown as Message;
    const messages = [tool("t1", "turn-1", 1), tool("t2", "turn-1", 2), row];
    const items = groupActivityRuns(messages);
    const run = items.find((item) => item.kind === "run")!;
    expect(roomRunTraces(items, messages).byRun.get(run.id)?.durationMs).toBe(2_000);
  });
});
