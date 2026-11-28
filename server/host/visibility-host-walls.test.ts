import { afterEach, describe, expect, it } from "vitest";

import { setAccessWalls } from "../peer-roster.ts";
import type { BotRecord, GroupRecord } from "../store.ts";
import { createVisibilityHost } from "./visibility-host.ts";

const bots = [{ id: "a", section: "Sales" }, { id: "b", section: "Finance" }, { id: "c", section: "Sales" }] as unknown as BotRecord[];
const room = (...memberIds: string[]) => ({ id: "room", threadId: "t-room", memberIds }) as unknown as GroupRecord;
const host = createVisibilityHost({
  store: () => ({
    bots, groups: [], bot: (id: string) => bots.find((one) => one.id === id), group: () => undefined,
    botByThread: () => undefined, groupByThread: () => undefined, patchGroup: () => undefined,
  }) as never,
  routines: () => null,
  team: false,
  audiencesFor: () => undefined,
  threadsReferencing: () => [],
});

afterEach(() => setAccessWalls(() => null));

describe("which rooms feed a bot's recall", () => {
  it("keeps out a room that holds a bot walled apart from this one", () => {
    setAccessWalls((from, target) => (from.id === "a" && target.id === "b" ? "grant" : null));
    expect(host.roomFeedsBot(room("a", "b"), bots[0]!)).toBe(false);
  });

  it("feeds a room whose other bots are not walled apart", () => {
    setAccessWalls((from, target) => (from.id === "a" && target.id === "b" ? "grant" : null));
    expect(host.roomFeedsBot(room("a", "c"), bots[0]!)).toBe(true);
  });

  it("feeds every room when no wall stands", () => {
    expect(host.roomFeedsBot(room("a", "b"), bots[0]!)).toBe(true);
  });
});
