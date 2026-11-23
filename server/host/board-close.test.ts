import { describe, expect, it } from "vitest";
import type { BoardClosure, BoardClosures } from "../board-closed.ts";
import type { BoardSources } from "../board.ts";
import { boardCloseAnswer, type BoardCloseDeps } from "./board-close.ts";

const NOW = 1_800_000_000_000;
type Handoff = ReturnType<BoardSources["handoffs"]>[number];

const failed = (id: string, botId: string, parentBot = "root"): Handoff[] => [
  { id: `src-${id}`, threadId: `s-${id}`, botId: parentBot, text: "Source", createdAt: NOW - 9000, status: "source", result: "", mode: "work" },
  { id, parentId: `src-${id}`, threadId: `t-${id}`, botId, text: `Work ${id}`, createdAt: NOW - 5000, status: "failed", result: "It broke", mode: "work" },
];
const running: Handoff = { id: "run", parentId: "root", threadId: "t-run", botId: "scout", text: "Busy", createdAt: NOW - 5000, status: "running", result: "", mode: "work" };

function world(bot: BoardCloseDeps["bot"], teamCloud = false, readable: BoardCloseDeps["readable"] = () => true) {
  const closed = new Map<string, BoardClosure>();
  const closures: BoardClosures = { get: (id) => closed.get(id), close: (id, by, reason) => { closed.set(id, { at: NOW + 1, by, ...(reason ? { reason } : {}) }); } };
  const bots: Record<string, { name: string; section?: string }> = {
    scout: { name: "Scout", section: "Sales" }, cleo: { name: "Cleo", section: "Support" }, atlas: { name: "Atlas", section: "Sales" },
  };
  const rows = [...failed("mine", "scout"), ...failed("handed", "cleo", "scout"), ...failed("sales", "atlas"), ...failed("support", "cleo"), running];
  const deps: BoardCloseDeps = {
    sources: () => ({ handoffs: () => rows, threads: [], runs: () => [] }), closures, bot, botOf: (id) => bots[id], teamCloud, readable,
  };
  return { deps, closed };
}

const ids = (answer: ReturnType<typeof boardCloseAnswer>) => (answer.body.cards as Array<{ id: string }>).map((card) => card.id).sort();

describe("board_close on the server", () => {
  it("lists only the Needs you cards the bot may close", () => {
    const { deps } = world({ id: "scout", section: "Sales" });
    const answer = boardCloseAnswer(deps, null);
    expect(ids(answer)).toEqual(["handoff:handed", "handoff:mine"]);
    expect(answer.body.cards).toContainEqual({ id: "handoff:mine", title: "Work mine", state: "failed", botName: "Scout" });
  });

  it("lists every Needs you card to a Chief of Staff off a Team Cloud, and only its section's on one", () => {
    const chief = { id: "chief", chiefOfStaff: true, section: "Sales" };
    expect(ids(boardCloseAnswer(world(chief).deps, null))).toEqual(["handoff:handed", "handoff:mine", "handoff:sales", "handoff:support"]);
    expect(ids(boardCloseAnswer(world(chief, true).deps, null))).toEqual(["handoff:mine", "handoff:sales"]);
  });

  it("closes a card the bot owns, with the bot's id and reason", () => {
    const { deps, closed } = world({ id: "scout" });
    expect(boardCloseAnswer(deps, { cardId: "handoff:mine", reason: " Fixed it. " })).toEqual({ status: 200, body: { ok: true, title: "Work mine", botName: "Scout" } });
    expect(closed.get("handoff:mine")).toMatchObject({ by: { kind: "bot", botId: "scout" }, reason: "Fixed it." });
    expect(ids(boardCloseAnswer(deps, null))).toEqual(["handoff:handed"]);
  });

  it("closes a card the bot handed over", () => {
    const { deps, closed } = world({ id: "scout" });
    expect(boardCloseAnswer(deps, { cardId: "handoff:handed", reason: "Not needed." }).status).toBe(200);
    expect(closed.has("handoff:handed")).toBe(true);
  });

  it("refuses another bot's card and keeps the card", () => {
    const { deps, closed } = world({ id: "scout" });
    expect(boardCloseAnswer(deps, { cardId: "handoff:support", reason: "Mine now." }).status).toBe(403);
    expect(boardCloseAnswer(deps, { cardId: "handoff:sales", reason: "Mine now." }).status).toBe(403);
    expect(closed.size).toBe(0);
  });

  it("refuses a Chief of Staff on a Team Cloud for a card of another section", () => {
    const { deps, closed } = world({ id: "chief", chiefOfStaff: true, section: "Sales" }, true);
    expect(boardCloseAnswer(deps, { cardId: "handoff:support", reason: "Stale." }).status).toBe(403);
    expect(boardCloseAnswer(deps, { cardId: "handoff:sales", reason: "Stale." }).status).toBe(200);
    expect([...closed.keys()]).toEqual(["handoff:sales"]);
  });

  it("refuses a card that is not in Needs you, a missing reason, and a reason that is too long", () => {
    const { deps, closed } = world({ id: "scout" });
    expect(boardCloseAnswer(deps, { cardId: "handoff:run", reason: "Stop." }).status).toBe(409);
    expect(boardCloseAnswer(deps, { cardId: "handoff:nope", reason: "Stop." }).status).toBe(409);
    expect(boardCloseAnswer(deps, { cardId: "handoff:mine" }).status).toBe(400);
    expect(boardCloseAnswer(deps, { cardId: "handoff:mine", reason: "x".repeat(201) }).status).toBe(400);
    expect(closed.size).toBe(0);
  });

  describe("on a Team Cloud, across people", () => {
    const audiences: Record<string, string> = { "t-mine": "member:a", "t-handed": "member:a", "t-sales": "member:b", "t-support": "team" };
    const sameAudience: BoardCloseDeps["readable"] = (card) => Boolean(card.threadId) && (audiences[card.threadId!] === "team" || audiences[card.threadId!] === "member:a");
    const chief = { id: "chief", chiefOfStaff: true };

    it("does not list a card whose thread belongs to another member", () => {
      const { deps } = world(chief, false, sameAudience);
      expect(ids(boardCloseAnswer(deps, null))).toEqual(["handoff:handed", "handoff:mine", "handoff:support"]);
    });

    it("answers a close of another member's card like a missing card and keeps the store empty", () => {
      const { deps, closed } = world(chief, false, sameAudience);
      const hidden = boardCloseAnswer(deps, { cardId: "handoff:sales", reason: "Stale." });
      expect(hidden).toEqual(boardCloseAnswer(deps, { cardId: "handoff:nope", reason: "Stale." }));
      expect(hidden.status).toBe(409);
      expect(closed.size).toBe(0);
    });

    it("still lists and closes a card of the same audience", () => {
      const { deps, closed } = world(chief, false, sameAudience);
      expect(boardCloseAnswer(deps, { cardId: "handoff:mine", reason: "Done." }).status).toBe(200);
      expect(closed.has("handoff:mine")).toBe(true);
    });
  });
});
