import { describe, expect, it } from "vitest";
import { usesVisibleTo } from "./provider-uses.ts";

describe("usesVisibleTo", () => {
  const uses = [
    { kind: "default" as const },
    { kind: "bot" as const, botId: "a", botName: "A" },
    { kind: "backup" as const, botId: "b", botName: "B" },
    { kind: "running" as const, botId: "b", botName: "B" },
    { kind: "conversation" as const, botId: "a", botName: "A", threadId: "t1", title: "T1" },
    { kind: "conversation" as const, botId: "a", botName: "A", threadId: "t2", title: "T2" },
  ];
  it("keeps what the viewer sees and counts the rest without names", () => {
    expect(usesVisibleTo(uses, { bot: (id) => id === "a", thread: (id) => id === "t1" })).toEqual([
      { kind: "default" }, { kind: "bot", botId: "a", botName: "A" },
      { kind: "conversation", botId: "a", botName: "A", threadId: "t1", title: "T1" },
      { kind: "other", count: 3 },
    ]);
  });
  it("changes nothing when the viewer sees everything", () => {
    expect(usesVisibleTo(uses, { bot: () => true, thread: () => true })).toEqual(uses);
  });
});
