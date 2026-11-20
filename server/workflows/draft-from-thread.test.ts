import { describe, expect, it } from "vitest";

import { WORKFLOW_LIMITS, type WorkflowStep } from "../../shared/workflows.ts";
import type { Assignment } from "../runtime/types.ts";
import { draftFromThread, type DraftSource, type DraftTurnRow } from "./draft-from-thread.ts";
import { runnableProblem, validateWorkflowInput } from "./validate.ts";

const THREAD = "t-lumi";
const names: Record<string, string> = { lumi: "Lumi", scout: "Scout", ledger: "Ledger", ava: "Ava", hal: "Hal" };

let serial = 0;
function assignment(over: Partial<Assignment> & { botId: string; brief: string; parentId?: string; requesterBot?: string; thread?: string; group?: string }): Assignment {
  serial += 1;
  const { botId, brief, requesterBot, thread, group, ...rest } = over;
  return {
    id: over.id ?? `a${serial}`, rootId: over.rootId ?? over.id ?? `a${serial}`, depth: over.parentId ? 1 : 0,
    origin: { kind: "person", source: "chat" },
    requester: over.parentId ? { kind: "bot_turn", botId: requesterBot ?? "lumi", threadId: THREAD } : { kind: "person", botId, threadId: thread ?? THREAD },
    assignee: { botId, destination: { kind: group ? "room_thread" : "work_thread", threadId: thread ?? (over.parentId ? `t-${botId}` : THREAD), ...(group ? { groupId: group } : {}) } },
    mode: "work", reply: "resume", brief, status: "completed", level: "ask", levelSource: "own", executions: 1, restarts: 0,
    createdAt: 1000, lastActivityAt: 1000, result: "", rework: false, version: 1, ...rest,
  } as unknown as Assignment;
}

const counter = () => { let n = 0; return (prefix: "s" | "c") => `${prefix}${++n}`; };
const send = (at: number, name = "TELEGRAM_SEND_MESSAGE", over: Partial<DraftTurnRow["tool"]> = {}, botId?: string): DraftTurnRow => ({ at, role: "bot", kind: "activity", ...(botId ? { from: { botId } } : {}), tool: { name, ok: true, ...over } });

function source(over: Partial<DraftSource> & { turns?: Record<string, DraftTurnRow[] | null>; refuse?: string[]; hidden?: string[] } = {}): DraftSource {
  const { turns = {}, refuse = [], hidden = [], ...rest } = over;
  return {
    threadId: THREAD, room: false, request: { at: 900, text: "Summarize today's orders and send them to the store team" }, reply: { at: 5000, botId: "lumi" }, rows: [],
    turnRows: (thread, from, to, botId) => { const rows = turns[thread]; return rows === undefined ? [] : rows === null ? null : rows.filter((row) => row.at >= from && row.at <= to && (botId === undefined || row.from?.botId === botId)); },
    threadVisible: (thread) => !hidden.includes(thread),
    usable: (botId) => botId in names && !refuse.includes(botId),
    ...rest,
  };
}

const shape = (steps: WorkflowStep[]) => steps.map((step) => (step.kind === "bot" ? `bot:${step.botId}:${step.instruction}` : step.kind));

describe("draftFromThread", () => {
  it("draws the request, each hand-off to another bot and each post, in order", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "Summarize today's orders and send them to the store team", createdAt: 1000, finishedAt: 4900 });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull today's orders", createdAt: 1100, startedAt: 1200, finishedAt: 2000 });
    const ledger = assignment({ id: "h2", rootId: "root", parentId: "h1", requesterBot: "scout", botId: "ledger", brief: "Check the totals", createdAt: 1500, finishedAt: 1900 });
    const { draft, omitted, trimmed } = draftFromThread(source({
      rows: [root, scout, ledger],
      turns: { "t-scout": [send(1800)], [THREAD]: [send(4000, "GMAIL_SEND_EMAIL")] },
    }), counter());
    expect(shape(draft.steps)).toEqual([
      "bot:lumi:Summarize today's orders and send them to the store team", "bot:scout:Pull today's orders", "bot:ledger:Check the totals", "post",
    ]);
    expect(draft.steps.map((step) => step.position)).toEqual([0, 1, 2, 3].map((i) => ({ x: 0, y: 160 * i })));
    expect(draft.connections.map((c) => [c.from, c.to])).toEqual([["s1", "s2"], ["s2", "s3"], ["s3", "s4"]]);
    expect(draft.connections.every((c) => c.branch === undefined)).toBe(true);
    expect(draft.name).toBe("Summarize today's orders and send them to the store team");
    expect([omitted, trimmed]).toEqual([0, 0]);
  });

  it("puts a send in the order of its time among the hand-offs", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "x" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100, finishedAt: 2000 });
    const ledger = assignment({ id: "h2", rootId: "root", parentId: "root", botId: "ledger", brief: "Total", createdAt: 3000, finishedAt: 3500 });
    const { draft } = draftFromThread(source({ rows: [root, scout, ledger], turns: { [THREAD]: [send(2500)] } }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "bot:scout:Pull", "post", "bot:ledger:Total"]);
  });

  it("holds one bot step with the request text when the conversation has no hand-off record", () => {
    const { draft, omitted, trimmed } = draftFromThread(source(), counter());
    expect(draft.steps).toEqual([{ id: "s1", kind: "bot", botId: "lumi", instruction: "Summarize today's orders and send them to the store team", position: { x: 0, y: 0 } }]);
    expect(draft.connections).toEqual([]);
    expect([omitted, trimmed]).toEqual([0, 0]);
  });

  it("falls back to one bot step when the only root belongs to another request", () => {
    const old = assignment({ id: "old", botId: "lumi", brief: "Older request", createdAt: 100 });
    const oldChild = assignment({ id: "old-h", rootId: "old", parentId: "old", botId: "scout", brief: "Older hand-off", createdAt: 150 });
    const later = assignment({ id: "later", botId: "lumi", brief: "Newer request", createdAt: 9000 });
    const { draft } = draftFromThread(source({ rows: [old, oldChild, later] }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team"]);
    expect(draft.connections).toEqual([]);
  });

  it("leaves out a step whose bot the person may not use, counts it and joins the steps around it", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100 });
    const hal = assignment({ id: "h2", rootId: "root", parentId: "root", botId: "hal", brief: "Secret work", createdAt: 1200 });
    const ledger = assignment({ id: "h3", rootId: "root", parentId: "root", botId: "ledger", brief: "Total", createdAt: 1300 });
    const { draft, omitted } = draftFromThread(source({ rows: [root, scout, hal, ledger], refuse: ["hal"] }), counter());
    expect(draft.steps.map((step) => (step.kind === "bot" ? step.botId : step.kind))).toEqual(["lumi", "scout", "ledger"]);
    expect(draft.connections.map((c) => [c.from, c.to])).toEqual([["s1", "s2"], ["s2", "s3"]]);
    expect(omitted).toBe(1);
  });

  it("skips cancelled, refused and duplicate hand-offs and hand-offs to the same bot, and keeps the teammates those handed on to", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const cancelled = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Cancelled", status: "cancelled", createdAt: 1100 });
    const refused = assignment({ id: "h2", rootId: "root", parentId: "root", botId: "scout", brief: "Refused", outcome: "refused", status: "failed", createdAt: 1110 });
    const duplicate = assignment({ id: "h3", rootId: "root", parentId: "root", botId: "scout", brief: "Duplicate", outcome: "duplicate", createdAt: 1120 });
    const self = assignment({ id: "h4", rootId: "root", parentId: "root", botId: "lumi", brief: "Own thread", createdAt: 1200, thread: "t-own" });
    const grandchild = assignment({ id: "h5", rootId: "root", parentId: "h4", requesterBot: "lumi", botId: "ava", brief: "Handed on", createdAt: 1300 });
    const { draft } = draftFromThread(source({ rows: [root, cancelled, refused, duplicate, self, grandchild] }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "bot:ava:Handed on"]);
  });

  it("leaves out a hand-off into a conversation the person may not open, and counts it", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const secret = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Quote of PRIVATE-WORK", createdAt: 1100 });
    const child = assignment({ id: "h2", rootId: "root", parentId: "h1", requesterBot: "scout", botId: "ledger", brief: "Open work", createdAt: 1200 });
    const { draft, omitted } = draftFromThread(source({ rows: [root, secret, child], hidden: ["t-scout"], turns: { "t-scout": [send(1150)] } }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "bot:ledger:Open work"]);
    expect(omitted).toBe(1);
    expect(JSON.stringify(draft)).not.toContain("PRIVATE-WORK");
  });

  it("makes one post step for sends next to each other, and none for reads, drafts, failed sends or the app's own tools", () => {
    const rows = [
      send(1000, "GMAIL_SEND_EMAIL"), send(1100, "TELEGRAM_SEND_MESSAGE"), send(1200, "GMAIL_FETCH_EMAILS"), send(1300, "GMAIL_CREATE_EMAIL_DRAFT"),
      send(1400, "mcp__agents__post_to_room"), send(1500, "TELEGRAM_SEND_MESSAGE", { ok: false }),
    ];
    const { draft } = draftFromThread(source({ turns: { [THREAD]: rows } }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "post"]);
    const none = draftFromThread(source({ turns: { [THREAD]: rows.slice(2) } }), counter());
    expect(none.draft.steps).toHaveLength(1);
  });

  it("reads the sends of a multi-execute call from its recorded input", () => {
    const call = (slug: string) => JSON.stringify({ tools: [{ tool_slug: slug, arguments: {} }] });
    const rows = [send(1000, "COMPOSIO_MULTI_EXECUTE_TOOL", { input: call("GMAIL_FETCH_EMAILS") }), send(1100, "COMPOSIO_MULTI_EXECUTE_TOOL", { input: call("GMAIL_SEND_EMAIL") })];
    const { draft } = draftFromThread(source({ turns: { [THREAD]: rows } }), counter());
    expect(draft.steps.map((step) => step.kind)).toEqual(["bot", "post"]);
    const reads = draftFromThread(source({ turns: { [THREAD]: rows.slice(0, 1) } }), counter());
    expect(reads.draft.steps.map((step) => step.kind)).toEqual(["bot"]);
  });

  it("uses a turn's recorded outward actions when its conversation shows no rows, and nothing from a hidden conversation", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100, finishedAt: 2000, evidence: { outward: ["TELEGRAM_SEND_MESSAGE"] } });
    const ledger = assignment({ id: "h2", rootId: "root", parentId: "root", botId: "ledger", brief: "Total", createdAt: 3000, finishedAt: 3500, evidence: { outward: ["GMAIL_SEND_EMAIL"] } });
    const shown = draftFromThread(source({ rows: [root, scout, ledger], turns: { "t-ledger": null } }), counter());
    expect(shape(shown.draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "bot:scout:Pull", "post", "bot:ledger:Total"]);
    const labels = assignment({ id: "h3", rootId: "root", parentId: "root", botId: "ava", brief: "Push", createdAt: 3600, finishedAt: 3700, evidence: { outward: ["git push"] } });
    const plain = draftFromThread(source({ rows: [root, labels] }), counter());
    expect(plain.draft.steps.map((step) => step.kind)).toEqual(["bot", "bot"]);
  });

  it("draws a group chat: the first speaker takes the request and later speakers become steps without the mention prefix", () => {
    const first = assignment({ id: "r1", botId: "lumi", brief: "Summarize today's orders and send them to the store team", createdAt: 1000, startedAt: 1010, finishedAt: 2000, group: "g1" });
    const second = assignment({ id: "r2", botId: "scout", brief: "Mentioned by Lumi (hop 1): Pull the numbers", createdAt: 2100, startedAt: 2110, finishedAt: 4000, group: "g1" });
    const { draft } = draftFromThread(source({
      room: true, rows: [first, second],
      turnRows: (_thread, from, to, botId) => (botId === "scout" && from <= 3000 && to >= 3000 ? [send(3000)] : []),
    }), counter());
    expect(shape(draft.steps)).toEqual(["bot:lumi:Summarize today's orders and send them to the store team", "bot:scout:Pull the numbers", "post"]);
  });

  it("clips the name to 80 characters at a word and each instruction to the instruction limit", () => {
    const words = Array.from({ length: 30 }, () => "orders").join(" ");
    const { draft } = draftFromThread(source({ request: { at: 900, text: `\n  ${words}\nsecond line` } }), counter());
    expect(draft.name.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.name);
    expect(draft.name.endsWith("orders…")).toBe(true);
    const long = draftFromThread(source({ request: { at: 900, text: "x".repeat(WORKFLOW_LIMITS.instruction + 5) } }), counter());
    const step = long.draft.steps[0]!;
    expect(step.kind === "bot" && step.instruction.length).toBe(WORKFLOW_LIMITS.instruction);
    expect(step.kind === "bot" && step.instruction.endsWith("…")).toBe(true);
    expect(draftFromThread(source({ request: { at: 900, text: "  Short   name\nmore" } }), counter()).draft.name).toBe("Short name");
  });

  it("stops at 50 steps and counts the rest", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const rows = [root, ...Array.from({ length: 54 }, (_, i) => assignment({ id: `h${i}`, rootId: "root", parentId: "root", botId: i % 2 ? "scout" : "ava", brief: `Work ${i}`, createdAt: 1100 + i }))];
    const { draft, trimmed } = draftFromThread(source({ rows }), counter());
    expect(draft.steps).toHaveLength(WORKFLOW_LIMITS.steps);
    expect(draft.connections).toHaveLength(WORKFLOW_LIMITS.steps - 1);
    expect(trimmed).toBe(5);
  });

  it("returns a draft the save check accepts", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100 });
    const { draft } = draftFromThread(source({ rows: [root, scout], turns: { [THREAD]: [send(4000)] } }));
    const facts = { botName: (id: string) => names[id] };
    const checked = validateWorkflowInput(draft, facts);
    expect(checked.ok).toBe(true);
    expect(runnableProblem(draft, facts)).toBeNull();
  });

  it("names the draft and its first step by the words of a request that carries attachment or paste tags", () => {
    const tagged = '<attached-image path="/data/attachments/x.png" name="x.png" />\nSend the weekly report';
    const { draft } = draftFromThread(source({ request: { at: 900, text: tagged } }), counter());
    expect(draft.name).toBe("Send the weekly report");
    expect(shape(draft.steps)).toEqual(["bot:lumi:Send the weekly report"]);
    const pasted = draftFromThread(source({ request: { at: 900, text: '<pasted-text index="1">\nRename the files\n</pasted-text>' } }), counter());
    expect(pasted.draft.name).toBe("Rename the files");
    expect(JSON.stringify(pasted.draft)).not.toContain("pasted-text");
    const only = draftFromThread(source({ request: { at: 900, text: '<attached-image path="/data/attachments/x.png" name="x.png" />' } }), counter());
    expect(only.draft.name).toBe("");
    expect(only.draft.steps).toEqual([]);
  });

  it("does not count a same-bot hand-off into a hidden conversation, which never becomes a step", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const own = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "lumi", brief: "Own work", createdAt: 1100, thread: "t-hidden" });
    const { omitted } = draftFromThread(source({ rows: [root, own], hidden: ["t-hidden"] }), counter());
    expect(omitted).toBe(0);
  });

  it("clips the name by code point, so an emoji at the cut stays whole", () => {
    const text = `${"a".repeat(78)}\u{1F600}${"b".repeat(5)}`;
    const { draft } = draftFromThread(source({ request: { at: 900, text } }), counter());
    expect(draft.name).toBe(`${"a".repeat(78)}\u{1F600}…`);
    expect(draft.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("reads a hand-off into a room by the bot that took it", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100, startedAt: 1200, finishedAt: 3000, thread: "t-room", group: "g1" });
    const other = draftFromThread(source({ rows: [root, scout], turns: { "t-room": [send(1500, "TELEGRAM_SEND_MESSAGE", {}, "ava")] } }), counter());
    expect(other.draft.steps.map((step) => step.kind)).toEqual(["bot", "bot"]);
    const own = draftFromThread(source({ rows: [root, scout], turns: { "t-room": [send(1500, "TELEGRAM_SEND_MESSAGE", {}, "scout")] } }), counter());
    expect(own.draft.steps.map((step) => step.kind)).toEqual(["bot", "bot", "post"]);
  });

  it("does not read the request's own conversation again for a hand-off that lands in it", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const scout = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100, startedAt: 1200, finishedAt: 3000, thread: THREAD });
    const reads: number[] = [];
    const base = source({ rows: [root, scout] });
    draftFromThread({ ...base, turnRows: (thread, from, to, botId) => { reads.push(from); return base.turnRows(thread, from, to, botId); } }, counter());
    expect(reads).toEqual([900]);
  });

  it("makes one post step for a send that two overlapping hand-offs both read", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const first = assignment({ id: "h1", rootId: "root", parentId: "root", botId: "scout", brief: "Pull", createdAt: 1100, startedAt: 1200, finishedAt: 4000, thread: "t-shared" });
    const second = assignment({ id: "h2", rootId: "root", parentId: "root", botId: "ledger", brief: "Total", createdAt: 3000, startedAt: 3000, finishedAt: 4000, thread: "t-shared" });
    const { draft } = draftFromThread(source({ rows: [root, first, second], turns: { "t-shared": [send(3500)] } }), counter());
    expect(draft.steps.map((step) => step.kind)).toEqual(["bot", "bot", "bot", "post"]);
  });

  it("drops a post that falls after the 50th step and counts it as trimmed", () => {
    const root = assignment({ id: "root", botId: "lumi", brief: "r" });
    const rows = [root, ...Array.from({ length: 49 }, (_, i) => assignment({ id: `h${i}`, rootId: "root", parentId: "root", botId: i % 2 ? "scout" : "ava", brief: `Work ${i}`, createdAt: 1100 + i }))];
    const { draft, trimmed } = draftFromThread(source({ rows, turns: { [THREAD]: [send(4000)] } }), counter());
    expect(draft.steps).toHaveLength(WORKFLOW_LIMITS.steps);
    expect(draft.steps.every((step) => step.kind === "bot")).toBe(true);
    expect(trimmed).toBe(1);
  });
});
