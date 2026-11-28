import { describe, expect, it } from "vitest";
import { BOARD_DONE_MAX, BOARD_DONE_WINDOW_MS, BOARD_TITLE_CHARS } from "../shared/board.ts";
import type { BoardClosure } from "./board-closed.ts";
import { boardView, botMayClose, type BoardSources, type BoardViewer } from "./board.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
type Handoff = ReturnType<BoardSources["handoffs"]>[number];
type Thread = BoardSources["threads"][number]["task"];
type Run = ReturnType<BoardSources["runs"]>[number];

const everyone: BoardViewer = { thread: () => true, bot: () => true, audience: () => true, routine: () => true };
const handoff = (over: Partial<Handoff> & { id: string }): Handoff => ({
  parentId: "root", threadId: `t-${over.id}`, botId: "scout", text: "Find the numbers", createdAt: NOW - 5 * HOUR,
  status: "running", result: "", mode: "work", ...over,
});
const thread = (over: Partial<Thread> & { threadId: string }): Thread => ({ title: "Chat", createdAt: NOW - 9 * HOUR, ...over });
const run = (over: Partial<Run> & { id: string }): Run => ({
  routineId: "r1", routineName: "Daily digest", botId: "atlas", status: "queued", scheduledFor: NOW - HOUR, ...over,
});
const board = (sources: Partial<{ handoffs: Handoff[]; threads: Array<{ botId: string; task: Thread }>; runs: Run[] }>, viewer = everyone) =>
  boardView({ handoffs: () => sources.handoffs ?? [], threads: sources.threads ?? [], runs: () => sources.runs ?? [] }, viewer, NOW).cards;
const one = (h: Handoff) => board({ handoffs: [h] })[0];

describe("hand-off cards", () => {
  it("puts a queued hand-off in To do", () => {
    expect(one(handoff({ id: "a", status: "queued" }))).toMatchObject({ id: "handoff:a", kind: "handoff", column: "todo", state: "queued", botId: "scout", threadId: "t-a" });
  });

  it("puts a running or resumed hand-off in Working", () => {
    expect(one(handoff({ id: "a", status: "running" }))).toMatchObject({ column: "working", state: "running" });
    expect(one(handoff({ id: "b", status: "resume" }))).toMatchObject({ column: "working", state: "running" });
  });

  it("asks the person when a waiting hand-off has a question and nobody else decides it", () => {
    expect(one(handoff({ id: "a", status: "waiting", question: "Which list?" }))).toMatchObject({ column: "needs-you", state: "needs-input", question: "Which list?" });
  });

  it("keeps a waiting hand-off in Working when it waits on a teammate or its requester decides", () => {
    expect(one(handoff({ id: "a", status: "waiting" }))).toMatchObject({ column: "working", state: "waiting-teammate" });
    expect(one(handoff({ id: "b", status: "waiting", question: "Ok?", decide: {} }))).toMatchObject({ column: "working", state: "waiting-teammate" });
  });

  it("puts a failed hand-off in Needs you with its own words", () => {
    expect(one(handoff({ id: "a", status: "failed", outcomeDetail: "Tool **crashed**", result: "ignored" }))).toMatchObject({ column: "needs-you", state: "failed", error: "Tool crashed" });
    expect(one(handoff({ id: "b", status: "failed", result: "It broke" }))).toMatchObject({ error: "It broke" });
  });

  it("puts a completed hand-off in Done with its result", () => {
    expect(one(handoff({ id: "a", status: "completed", result: "All done" }))).toMatchObject({ column: "done", state: "completed", result: "All done" });
  });

  it("skips roots, sources, cancelled, notify and status-only hand-offs", () => {
    const { parentId: _p, ...root } = handoff({ id: "root" });
    expect(board({ handoffs: [
      root, handoff({ id: "s", status: "source" }), handoff({ id: "c", status: "cancelled" }),
      handoff({ id: "n", mode: "notify" }), handoff({ id: "o", statusOnly: true }),
    ] })).toEqual([]);
  });

  it("titles a card from the first non-empty line, cleaned and cut", () => {
    expect(one(handoff({ id: "a", text: "\n\n## **Plan** the `launch`\nmore" })).title).toBe("Plan the launch");
    const long = one(handoff({ id: "b", text: "x".repeat(300) }));
    expect(long.title).toHaveLength(BOARD_TITLE_CHARS);
    expect(long.title.endsWith("…")).toBe(true);
  });

  it("names the bot that handed the work over and uses the latest progress time", () => {
    const card = board({ handoffs: [
      handoff({ id: "root", botId: "atlas", status: "running" }),
      handoff({ id: "a", parentId: "root", createdAt: 1, startedAt: 2, lastProgressAt: 3 }),
    ] }).find((c) => c.id === "handoff:a");
    expect(card).toMatchObject({ fromBotId: "atlas", createdAt: 1, updatedAt: 3 });
    expect(one(handoff({ id: "b", createdAt: 1, startedAt: 2 }))?.updatedAt).toBe(2);
  });
});

describe("conversation cards", () => {
  const threads = (...tasks: Thread[]) => tasks.map((task) => ({ botId: "atlas", task }));

  it("maps activity and closing to columns", () => {
    const cards = board({ threads: threads(
      thread({ threadId: "w", activity: "working", updatedAt: NOW - 1 }),
      thread({ threadId: "y", activity: "waiting-on-you", updatedAt: NOW - 2 }),
      thread({ threadId: "c", closedBy: { at: NOW - 3 } }),
      thread({ threadId: "i", activity: "idle" }),
    ) });
    expect(cards.map((c) => [c.id, c.column, c.state, c.updatedAt])).toEqual([
      ["thread:w", "working", "running", NOW - 1],
      ["thread:y", "needs-you", "waiting-on-you", NOW - 2],
      ["thread:c", "done", "closed", NOW - 3],
    ]);
  });

  it("uses the creation time when a conversation has no newer message and allows an empty title", () => {
    expect(board({ threads: threads(thread({ threadId: "w", activity: "working", title: "" })) })[0]).toMatchObject({ title: "", updatedAt: NOW - 9 * HOUR });
  });

  it("skips routine results, archived conversations and threads another card already shows", () => {
    const cards = board({
      handoffs: [handoff({ id: "a", threadId: "dup1" })],
      runs: [run({ id: "r", status: "running", threadId: "dup2" })],
      threads: threads(
        thread({ threadId: "dup1", activity: "working" }), thread({ threadId: "dup2", activity: "working" }),
        thread({ threadId: "x", activity: "working", routineRunId: "r" }), thread({ threadId: "y", activity: "working", archivedAt: 1 }),
        thread({ threadId: "ok", activity: "working" }),
      ),
    });
    expect(cards.map((c) => c.id).sort()).toEqual(["handoff:a", "routine:r", "thread:ok"]);
  });
});

describe("automation run cards", () => {
  it("maps each run status", () => {
    const cards = board({ runs: [
      run({ id: "q", status: "queued" }), run({ id: "r", status: "running" }), run({ id: "w", status: "waiting" }),
      run({ id: "f", status: "failed", error: "Boom", finishedAt: NOW - 10 }), run({ id: "d", status: "completed", finishedAt: NOW - 20, threadId: "tt", groupId: "g" }),
      run({ id: "c", status: "cancelled" }), run({ id: "m", status: "missed" }),
    ] });
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(Object.keys(by).sort()).toEqual(["routine:d", "routine:f", "routine:q", "routine:r", "routine:w"]);
    expect(by["routine:q"]).toMatchObject({ column: "todo", state: "queued", title: "Daily digest", routineId: "r1" });
    expect(by["routine:r"]).toMatchObject({ column: "working", state: "running" });
    expect(by["routine:w"]).toMatchObject({ column: "working", state: "running" });
    expect(by["routine:f"]).toMatchObject({ column: "needs-you", state: "failed", error: "Boom", updatedAt: NOW - 10 });
    expect(by["routine:d"]).toMatchObject({ column: "done", state: "completed", threadId: "tt", groupId: "g", updatedAt: NOW - 20 });
  });

  it("asks for hand-offs and runs inside the window", () => {
    const asked: number[] = [];
    boardView({ handoffs: (f) => { asked.push(f); return []; }, threads: [], runs: (f) => { asked.push(f); return []; } }, everyone, NOW);
    expect(asked).toEqual([NOW - BOARD_DONE_WINDOW_MS, NOW - BOARD_DONE_WINDOW_MS]);
  });
});

describe("window, limit, order and visibility", () => {
  it("drops finished and failed work older than the window but keeps open work", () => {
    const old = NOW - BOARD_DONE_WINDOW_MS - 1;
    const cards = board({ handoffs: [
      handoff({ id: "d", status: "completed", lastProgressAt: old }), handoff({ id: "f", status: "failed", lastProgressAt: old }),
      handoff({ id: "q", status: "queued", createdAt: old }), handoff({ id: "n", status: "waiting", question: "?", lastProgressAt: old }),
      handoff({ id: "ok", status: "completed", lastProgressAt: NOW - BOARD_DONE_WINDOW_MS }),
    ] });
    expect(cards.map((c) => c.id).sort()).toEqual(["handoff:n", "handoff:ok", "handoff:q"]);
  });

  it("keeps the newest Done cards up to the limit", () => {
    const handoffs = Array.from({ length: BOARD_DONE_MAX + 5 }, (_, i) => handoff({ id: `h${i}`, status: "completed", lastProgressAt: NOW - i * 1000 }));
    const cards = board({ handoffs });
    expect(cards).toHaveLength(BOARD_DONE_MAX);
    expect(cards[0]!.id).toBe("handoff:h0");
    expect(cards.at(-1)!.id).toBe(`handoff:h${BOARD_DONE_MAX - 1}`);
  });

  it("orders by column, then newest first, with unique ids", () => {
    const cards = board({ handoffs: [
      handoff({ id: "d1", status: "completed", lastProgressAt: NOW - 1 }), handoff({ id: "n1", status: "failed", lastProgressAt: NOW - 5 }),
      handoff({ id: "w1", status: "running", lastProgressAt: NOW - 9 }), handoff({ id: "w2", status: "running", lastProgressAt: NOW - 2 }),
      handoff({ id: "t1", status: "queued", createdAt: NOW - 3 }),
    ] });
    expect(cards.map((c) => c.id)).toEqual(["handoff:t1", "handoff:w2", "handoff:w1", "handoff:n1", "handoff:d1"]);
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
  });

  it("hides what the viewer may not see", () => {
    const viewer: BoardViewer = { thread: (id) => id !== "t-hidden" && id !== "hid", bot: (id) => id !== "secret", audience: () => true, routine: (r) => r.botId !== "secret" };
    const cards = board({
      handoffs: [handoff({ id: "hidden" }), handoff({ id: "shown" })],
      threads: [{ botId: "atlas", task: thread({ threadId: "hid", activity: "working" }) }, { botId: "atlas", task: thread({ threadId: "vis", activity: "working" }) }],
      runs: [run({ id: "s", botId: "secret" }), run({ id: "p", botId: "atlas" })],
    }, viewer);
    expect(cards.map((c) => c.id).sort()).toEqual(["handoff:shown", "routine:p", "thread:vis"]);
  });

  it("names the handing bot only when the viewer may see it", () => {
    const rows = [handoff({ id: "root", parentId: undefined, status: "source", botId: "secret" }), handoff({ id: "a" })];
    const viewer: BoardViewer = { ...everyone, bot: (id) => id !== "secret" };
    expect(board({ handoffs: rows })[0]).toMatchObject({ fromBotId: "secret" });
    expect(board({ handoffs: rows }, viewer)[0]).not.toHaveProperty("fromBotId");
  });
});

describe("cards moved to Done", () => {
  const closure = (over: Partial<BoardClosure> = {}): BoardClosure => ({ at: NOW - HOUR, by: { kind: "person", name: "Rama" }, reason: "Fixed by hand", ...over });
  const withClosures = (rows: Handoff[], closed: Record<string, BoardClosure>) =>
    boardView({ handoffs: () => rows, threads: [], runs: () => [], closed: (id) => closed[id] }, everyone, NOW).cards;
  const failed = handoff({ id: "f", status: "failed", result: "It broke", lastProgressAt: NOW - 2 * HOUR });

  it("shows a closed Needs you card in Done with who closed it, when and why", () => {
    const [card] = withClosures([failed], { "handoff:f": closure() });
    expect(card).toMatchObject({ column: "done", state: "closed", updatedAt: NOW - HOUR, closedBy: { kind: "person", name: "Rama" }, closedReason: "Fixed by hand" });
  });

  it("drops the bot's question from a closed card and omits an empty reason", () => {
    const asking = handoff({ id: "q", status: "waiting", question: "Which list?", lastProgressAt: NOW - 2 * HOUR });
    const [card] = withClosures([asking], { "handoff:q": closure({ by: { kind: "bot", botId: "cleo" }, reason: undefined }) });
    expect(card).toMatchObject({ column: "done", state: "closed", closedBy: { kind: "bot", botId: "cleo" } });
    expect(card).not.toHaveProperty("question");
    expect(card).not.toHaveProperty("closedReason");
  });

  it("shows the card in its own column again when it changed after the close", () => {
    const changed = handoff({ id: "f", status: "failed", result: "It broke again", lastProgressAt: NOW - HOUR / 2 });
    const [card] = withClosures([changed], { "handoff:f": closure() });
    expect(card).toMatchObject({ column: "needs-you", state: "failed" });
    expect(card).not.toHaveProperty("closedBy");
  });

  it("leaves a card that is not in Needs you where it is", () => {
    const running = handoff({ id: "r", status: "running", lastProgressAt: NOW - 2 * HOUR });
    expect(withClosures([running], { "handoff:r": closure() })[0]).toMatchObject({ column: "working", state: "running" });
  });

  it("closes a conversation that waits on the person and a failed routine run", () => {
    const cards = boardView({
      handoffs: () => [], runs: () => [run({ id: "x", status: "failed", finishedAt: NOW - 2 * HOUR })],
      threads: [{ botId: "atlas", task: thread({ threadId: "w", activity: "waiting-on-you", updatedAt: NOW - 2 * HOUR }) }],
      closed: () => closure(),
    }, everyone, NOW).cards;
    expect(cards.map((card) => [card.id, card.column, card.state]).sort()).toEqual([["routine:x", "done", "closed"], ["thread:w", "done", "closed"]]);
  });
});

describe("which bot may move a card to Done", () => {
  const card = { botId: "scout", fromBotId: "cleo" };
  const chief = { id: "chief", chiefOfStaff: true, section: "Sales" };

  it("allows the bot that does the work and the bot that handed it over", () => {
    expect(botMayClose(card, { id: "scout" }, undefined, true)).toBe(true);
    expect(botMayClose(card, { id: "cleo" }, undefined, true)).toBe(true);
  });

  it("refuses another bot's card to a bot that is not a Chief of Staff", () => {
    expect(botMayClose(card, { id: "atlas" }, undefined, false)).toBe(false);
    expect(botMayClose({ botId: "scout" }, { id: "atlas", chiefOfStaff: false }, undefined, false)).toBe(false);
  });

  it("lets a Chief of Staff close any card off a Team Cloud", () => {
    expect(botMayClose(card, chief, { section: "Support" }, false)).toBe(true);
  });

  it("limits a Chief of Staff on a Team Cloud to bots in the same non-empty section", () => {
    expect(botMayClose(card, chief, { section: "Sales" }, true)).toBe(true);
    expect(botMayClose(card, chief, { section: "Support" }, true)).toBe(false);
    expect(botMayClose(card, chief, undefined, true)).toBe(false);
    expect(botMayClose(card, { id: "chief", chiefOfStaff: true }, {}, true)).toBe(false);
    expect(botMayClose(card, { id: "chief", chiefOfStaff: true, section: " " }, { section: " " }, true)).toBe(false);
  });
});

describe("todo cards and the viewer", () => {
  const todo = (over: Record<string, unknown>) => ({
    id: "t1", title: "Plan", status: "done", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "R" }, botId: "atlas",
    attempts: 1, depth: 0, createdAt: NOW - HOUR, updatedAt: NOW - HOUR, finishedAt: NOW - HOUR, result: "Reply text", ...over,
  }) as unknown as import("../shared/todo.ts").Todo;
  const view = (todos: import("../shared/todo.ts").Todo[], viewer: BoardViewer) =>
    boardView({ handoffs: () => [], threads: [], runs: () => [], todos: () => ({ todos, picker: null }) }, viewer, NOW).cards;

  it("hides a todo, with its result, when the viewer cannot see the conversation where it ran (security)", () => {
    const viewer: BoardViewer = { thread: (id) => id !== "work-private", bot: () => true, audience: () => true, routine: () => true };
    expect(view([todo({ threadId: "work-private" })], viewer)).toEqual([]);
    expect(view([todo({ threadId: "work-open" })], viewer)).toHaveLength(1);
  });

  it("hides a todo of an audience the viewer is not in, and counts no hidden todo in a place in the queue (security)", () => {
    const viewer: BoardViewer = { thread: () => true, bot: () => true, audience: (audience) => audience === "team", routine: () => true };
    const queued = (id: string, rank: number, audience: string) => todo({ id, title: id, status: "queued", rank, result: undefined, finishedAt: undefined, audience });
    const cards = view([queued("private-1", 1, "member:other"), queued("shared", 2, "team")], viewer);
    expect(cards.map((card) => card.todoId)).toEqual(["shared"]);
    expect(cards[0]).toMatchObject({ state: "queued", place: 1 });
  });
});
