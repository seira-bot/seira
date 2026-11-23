import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLANCE_LIMITS } from "../../shared/glance";
import type { InboxView } from "../../shared/inbox";
import { approvalRow, inboxView, questionRow } from "@/testing/inbox-fixture";
import { buildGlanceFeed, glanceActHandler, glanceAskInputs, glanceBotInputs, glanceLabels, type GlanceBotInput } from "./glance-feed";
import { initialState, type AppState, type Bot } from "./store";
import { noteTurnEvent, resetTurnLive } from "./turn-status";

const labels = glanceLabels();
const idle = { waiting: false, working: false, failed: false };
const bot = (over: Partial<GlanceBotInput> = {}): GlanceBotInput => ({ botId: "b1", threadId: "t1", name: "Felix", status: { ...idle, working: true }, line: null, ...over });
const build = (bots: GlanceBotInput[], asks: Parameters<typeof buildGlanceFeed>[0]["asks"] = []) => buildGlanceFeed({ bots, asks, labels, lang: "en" });
const ask = (over: Partial<Parameters<typeof buildGlanceFeed>[0]["asks"][number]> = {}) =>
  ({ botId: "b1", threadId: "t9", kind: "approval" as const, requestId: "r1", title: "Felix wants to run a command", choices: [], canAlways: true, detail: "ls -la", at: 1, ...over });

describe("buildGlanceFeed", () => {
  it("leaves idle bots out", () => {
    expect(build([bot({ status: idle })]).bots).toEqual([]);
  });

  it("shows an approval as needs, with canAlways and the asking thread", () => {
    const [one] = build([bot({ status: { ...idle, waiting: true } })], [ask()]).bots;
    expect(one).toMatchObject({ state: "needs", threadId: "t9", line: "", ask: { kind: "approval", requestId: "r1", choices: [], canAlways: true } });
  });

  it("shows a question with up to 4 choices", () => {
    const [one] = build([bot()], [ask({ kind: "question", choices: ["A", "B", "C"], title: "Which?" })]).bots;
    expect(one!.state).toBe("question");
    expect(one!.ask!.choices).toEqual([{ id: "0", label: "A" }, { id: "1", label: "B" }, { id: "2", label: "C" }]);
  });

  it("sends no choices for 6 options or for typed text", () => {
    const six = build([bot()], [ask({ kind: "question", choices: ["1", "2", "3", "4", "5", "6"] })]).bots[0]!;
    const typed = build([bot()], [ask({ kind: "question", choices: [] })]).bots[0]!;
    expect(six.ask!.choices).toEqual([]);
    expect(typed.ask!.choices).toEqual([]);
  });

  it("orders needs and questions, then failed, then working; only working carries its own words", () => {
    const feed = build([
      bot({ botId: "w", line: "Searching the web" }),
      bot({ botId: "f", status: { ...idle, failed: true } }),
      bot({ botId: "q" }),
    ], [ask({ botId: "q", kind: "question", choices: ["A"] })]);
    expect(feed.bots.map((one) => [one.botId, one.state, one.line])).toEqual([
      ["q", "question", ""], ["f", "failed", ""], ["w", "working", "Searching the web"],
    ]);
  });

  it("leaves the line empty without a live phrase, so Glance shows the state word once", () => {
    expect(build([bot()]).bots[0]!.line).toBe("");
  });

  it("drops an external avatar and a bad colour, keeps a same-origin avatar and a hex colour", () => {
    const [bad] = build([bot({ avatarUrl: "https://example.com/a.png", color: "red" })]).bots;
    const [good] = build([bot({ avatarUrl: "/api/attachments/abc123.png", color: "#009957" })]).bots;
    expect([bad!.avatarUrl, bad!.color]).toEqual([null, null]);
    expect([good!.avatarUrl, good!.color]).toEqual(["/api/attachments/abc123.png", "#009957"]);
  });

  it("clips every string and the bot count to the limits", () => {
    const long = "x".repeat(500);
    const many = Array.from({ length: 20 }, (_, index) => bot({ botId: `b${index}`, name: long, line: long }));
    const feed = build(many);
    expect(feed.bots).toHaveLength(GLANCE_LIMITS.bots);
    expect(feed.bots[0]!.name.length).toBeLessThanOrEqual(GLANCE_LIMITS.name);
    expect(feed.bots[0]!.line.length).toBeLessThanOrEqual(GLANCE_LIMITS.line);
    const asked = build([bot()], [ask({ title: long, requestId: long, kind: "question", choices: [long] })]).bots[0]!.ask!;
    expect(asked.title.length).toBeLessThanOrEqual(GLANCE_LIMITS.title);
    expect(asked.requestId.length).toBeLessThanOrEqual(GLANCE_LIMITS.id);
    expect(asked.choices[0]!.label.length).toBeLessThanOrEqual(GLANCE_LIMITS.choiceLabel);
  });
});

const felix = { ...initialState.bots[0], id: "reporter", name: "Reporter", threadId: "rep-main", color: "green", messages: [], tasks: [{ threadId: "rep-main", busy: true, activity: "working", turnStartedAt: 5 }], busy: true } as unknown as Bot;

describe("glance inputs from the store", () => {
  beforeEach(() => resetTurnLive());

  it("does not leak a raw command into the line", () => {
    noteTurnEvent({ type: "turn.progress", threadId: "rep-main", turnId: "turn", activity: "command", target: "rm -rf ./secret-build" } as never);
    const inputs = glanceBotInputs([felix], {});
    expect(inputs[0]).toMatchObject({ botId: "reporter", threadId: "rep-main", startedAt: 5, color: "#009957" });
    const feed = build(inputs);
    expect(feed.bots[0]!.line).not.toMatch(/rm -rf|secret-build/);
    expect(feed.bots[0]!.line).not.toBe("");
  });

  it("builds the ask from the inbox row with the card's title and no raw command", () => {
    const asks = glanceAskInputs(inboxView([approvalRow, questionRow]), [felix, { ...felix, id: "scout", name: "Scout", threadId: "scout-main" } as Bot]);
    const approval = asks.find((one) => one.kind === "approval")!;
    expect(approval).toMatchObject({ botId: "reporter", requestId: "req-approval", threadId: "rep-main", canAlways: false });
    expect(approval.title).toContain("Reporter");
    expect(approval.title).not.toMatch(/rm -rf/);
    expect(approval.detail).toBe("Run: rm -rf ./build");
    expect(asks.find((one) => one.kind === "question")).toMatchObject({ requestId: "req-question", choices: ["Home", "Pricing"] });
  });
});

describe("approval detail", () => {
  const rowWith = (card: Partial<NonNullable<typeof approvalRow.card>>, text = "Run: ls") => ({ ...approvalRow, text, card: { ...approvalRow.card!, ...card } });
  const detailOf = (row: typeof approvalRow) => glanceAskInputs(inboxView([row]), [felix])[0]!.detail;

  it("is the whole text the inbox row shows for a plain tool approval", () => {
    expect(detailOf(rowWith({}))).toBe("Run: ls");
  });

  it("is empty over 400 characters, never clipped", () => {
    expect(detailOf(rowWith({}, "x".repeat(GLANCE_LIMITS.detail + 1)))).toBe("");
    expect(detailOf(rowWith({}, "x".repeat(GLANCE_LIMITS.detail)))).toHaveLength(GLANCE_LIMITS.detail);
  });

  it("is empty without a tool or without text", () => {
    expect(detailOf(rowWith({ tool: undefined }))).toBe("");
    expect(detailOf(rowWith({}, ""))).toBe("");
  });

  it("is empty for a question", () => {
    expect(buildGlanceFeed({ bots: [bot()], asks: [ask({ kind: "question", choices: ["A"] })], labels, lang: "en" }).bots[0]!.ask!.detail).toBe("");
  });
});

describe("glanceActHandler", () => {
  const view = (): InboxView => ({ ...inboxView([
    { ...approvalRow, card: { ...approvalRow.card!, allowKey: "Bash:ls" } },
    questionRow,
  ]), threadId: "inbox" });
  const make = (reply: "sent" | "error" | "throw") => {
    const dispatch = vi.fn((action: { onSent?: () => void; onError?: (m: string) => void }) => {
      if (reply === "throw") throw new Error("boom");
      if (reply === "sent") action.onSent?.(); else action.onError?.("no");
    });
    const state = { ...initialState, bots: [felix, { ...felix, id: "scout", threadId: "scout-main" }] } as unknown as AppState;
    return { dispatch, handler: glanceActHandler({ dispatch: dispatch as never, getState: () => state, getInbox: view, showThreads: () => false }) };
  };
  const approval = (choice: "deny" | "once" | "always") => ({ kind: "approval" as const, botId: "reporter", threadId: "rep-main", requestId: "req-approval", choice });

  it("deny, once and always call the same decide action as the card", async () => {
    for (const [choice, expected] of [
      ["deny", { behavior: "deny", message: "Denied by the user." }],
      ["once", { behavior: "allow" }],
      ["always", { behavior: "allow", alwaysAllow: { botId: "reporter", key: "Bash:ls" } }],
    ] as const) {
      const { dispatch, handler } = make("sent");
      expect(await handler(approval(choice))).toBe(true);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-approval", ...expected }));
    }
  });

  it("refuses once and always when the command cannot be shown whole, and still sends deny", async () => {
    const hidden = { ...view(), rows: view().rows.map((row) => (row.id === approvalRow.id ? { ...row, text: "x".repeat(GLANCE_LIMITS.detail + 1) } : row)) };
    const dispatch = vi.fn((action: { onSent?: () => void }) => action.onSent?.());
    const handler = glanceActHandler({ dispatch: dispatch as never, getState: () => initialState as AppState, getInbox: () => hidden, showThreads: () => false });
    expect(await handler(approval("once"))).toBe(false);
    expect(await handler(approval("always"))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await handler(approval("deny"))).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
  });

  it("sends the chosen question option as an answer", async () => {
    const { dispatch, handler } = make("sent");
    expect(await handler({ kind: "answer", botId: "scout", threadId: "scout-main", requestId: "req-question", choiceId: "1" })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-question", behavior: "answer", message: "Pricing" }));
  });

  it("resolves false when sending fails, throws, or names no open ask", async () => {
    expect(await make("error").handler(approval("once"))).toBe(false);
    expect(await make("throw").handler(approval("once"))).toBe(false);
    expect(await make("sent").handler({ ...approval("once"), requestId: "gone" })).toBe(false);
    expect(await make("sent").handler({ kind: "answer", botId: "scout", threadId: "scout-main", requestId: "req-question", choiceId: "9" })).toBe(false);
  });

  it("open selects that bot's conversation", async () => {
    const { dispatch, handler } = make("sent");
    expect(await handler({ kind: "open", botId: "reporter", threadId: "rep-main" })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "reporter" });
    expect(dispatch).toHaveBeenCalledWith({ type: "revealThread", threadId: "rep-main" });
  });
});
