import { describe, expect, it } from "vitest";

import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { VisibleSet, type Viewer } from "../bot-visibility.ts";
import type { WorkflowHost } from "../host/workflow-host.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Assignment } from "../runtime/types.ts";
import type { Message } from "../store.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createWorkflowDraftRoutes } from "./workflow-draft.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const bots = [
  { id: "lumi", threadId: "t-lumi" },
  { id: "scout", threadId: "t-scout" },
  { id: "hal", threadId: "t-hal", visibility: { people: ["ada@example.test"] } },
];
const groups = [{ id: "g1", threadId: "t-room", memberIds: ["lumi", "scout"] }];

const msg = (over: Partial<Message> & { id: string; at: number }): Message => ({ role: "bot", kind: "text", text: "x", ...over }) as Message;
const root = (botId: string, thread: string, brief: string, createdAt: number, extra: Partial<Assignment> = {}) => ({
  id: `a-${botId}-${createdAt}`, rootId: `a-${botId}-${createdAt}`, depth: 0, requester: { kind: "person" }, assignee: { botId, destination: { kind: "work_thread", threadId: thread } },
  brief, status: "completed", createdAt, ...extra,
}) as unknown as Assignment;

function fixture(over: { messages?: Record<string, Message[]>; rows?: Assignment[]; levels?: Record<string, BotAccessLevel>; off?: boolean; viewer?: Viewer; gone?: string[]; reads?: string[] } = {}) {
  const messages = over.messages ?? {
    "t-lumi": [
      msg({ id: "u1", at: 1000, role: "user", text: "Summarize today's orders" }),
      msg({ id: "b1", at: 2000, turnTerminal: true, turnSucceeded: true, requestMessageId: "u1" }),
    ],
  };
  const visible = new VisibleSet(bots, groups, over.viewer ?? BOB);
  const routes = createWorkflowDraftRoutes({
    store: {
      bot: (id: string) => (bots.some((b) => b.id === id) && !over.gone?.includes(id) ? { id } : null),
      botByThread: (thread: string) => bots.find((b) => b.threadId === thread) ?? null,
      groupByThread: (thread: string) => groups.find((g) => g.threadId === thread),
      messagesFor: (thread: string) => messages[thread] ?? [],
      activePath: (thread: string) => { over.reads?.push(thread); return messages[thread] ?? []; },
    } as never,
    coordinator: { job: () => ({ scopes: [], rows: over.rows ?? [] }) },
    visible: () => visible,
    botsRefusal: (_auth, ids, needed) => (ids.some((id) => !atLeast(over.levels?.[id] ?? "edit", needed)) ? "You can only view this bot." : null),
    workflows: () => (over.off ? null : ({} as WorkflowHost)),
  });
  return async (method: string, path: string) => {
    const sent: { status?: number; body?: any } = {};
    const out = await routes({
      req: {}, res: {}, url: new URL(`http://x${path}`), path, method, auth,
      json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
      readBody: (async () => undefined) as unknown as RouteContext["readBody"],
    } as unknown as RouteContext);
    return { out, ...sent };
  };
}
const draftPath = (thread: string, message: string) => `/api/threads/${thread}/messages/${message}/workflow-draft`;

describe("workflow draft route", () => {
  it("answers 200 with the drawn workflow for a finished 1:1 reply", async () => {
    const rows = [root("lumi", "t-lumi", "Summarize today's orders", 1100), { ...root("scout", "t-scout", "Pull orders", 1200), id: "h", parentId: "a-lumi-1100", rootId: "a-lumi-1100", requester: { kind: "bot_turn", botId: "lumi", threadId: "t-lumi" } } as Assignment];
    const { status, body } = await fixture({ rows })("GET", draftPath("t-lumi", "b1"));
    expect(status).toBe(200);
    expect(body.draft.name).toBe("Summarize today's orders");
    expect(body.draft.steps.map((s: any) => s.botId)).toEqual(["lumi", "scout"]);
    expect(body.draft.connections).toHaveLength(1);
    expect([body.omitted, body.trimmed]).toEqual([0, 0]);
  });

  it("leaves a hand-off into a conversation the person can't open out of the draft", async () => {
    const child = { ...root("hal", "t-hal", "SECRET-WORK", 1200), id: "h", parentId: "a-lumi-1100", rootId: "a-lumi-1100", requester: { kind: "bot_turn", botId: "lumi", threadId: "t-lumi" } } as Assignment;
    const { status, body } = await fixture({ rows: [root("lumi", "t-lumi", "Summarize today's orders", 1100), child] })("GET", draftPath("t-lumi", "b1"));
    expect(status).toBe(200);
    expect(body.draft.steps).toHaveLength(1);
    expect(body.omitted).toBe(1);
    expect(JSON.stringify(body)).not.toContain("SECRET-WORK");
  });

  it("answers 200 for a finished room reply and reads the room's roots", async () => {
    const messages = { "t-room": [
      msg({ id: "u1", at: 1000, role: "user", text: "Plan the launch" }),
      msg({ id: "b1", at: 3000, turnTerminal: true, from: { botId: "scout", name: "Scout", color: "" } }),
    ] };
    const rows = [root("lumi", "t-room", "Plan the launch", 1100), root("scout", "t-room", "Mentioned by Lumi (hop 1): Pull numbers", 2000)];
    const { status, body } = await fixture({ messages, rows })("GET", draftPath("t-room", "b1"));
    expect(status).toBe(200);
    expect(body.draft.steps.map((s: any) => [s.botId, s.instruction])).toEqual([["lumi", "Plan the launch"], ["scout", "Pull numbers"]]);
  });

  it("answers 404 for a conversation the person can't see, an unknown message and a hidden request bot", async () => {
    expect((await fixture()("GET", draftPath("t-hal", "b1"))).status).toBe(404);
    expect((await fixture()("GET", draftPath("t-nowhere", "b1"))).body).toEqual({ error: "no such conversation" });
    expect((await fixture()("GET", draftPath("t-lumi", "zzz"))).body).toEqual({ error: "no such message" });
    const roomMessages = { "t-room": [msg({ id: "u1", at: 1000, role: "user", text: "Go" }), msg({ id: "b1", at: 3000, turnTerminal: true, from: { botId: "scout", name: "Scout", color: "" } })] };
    const hidden = await fixture({ messages: roomMessages, rows: [root("hal", "t-room", "Secret", 1100)] })("GET", draftPath("t-room", "b1"));
    expect([hidden.status, hidden.body]).toEqual([404, { error: "no such bot" }]);
    expect((await fixture({ gone: ["lumi"] })("GET", draftPath("t-lumi", "b1"))).status).toBe(404);
  });

  it("answers 409 for a reply still going, a failed reply and a person's line", async () => {
    const base = [msg({ id: "u1", at: 1000, role: "user", text: "Go" })];
    for (const second of [msg({ id: "b1", at: 2000 }), msg({ id: "b1", at: 2000, turnTerminal: true, turnSucceeded: false }), msg({ id: "b1", at: 2000, role: "user" })]) {
      const answer = await fixture({ messages: { "t-lumi": [...base, second] } })("GET", draftPath("t-lumi", "b1"));
      expect([answer.status, answer.body.code]).toEqual([409, "workflow_draw_unfinished"]);
    }
  });

  it("answers 409 workflow_draw_no_request when the request has no words and no brief", async () => {
    const messages = { "t-lumi": [msg({ id: "u1", at: 1000, role: "user", text: "  " }), msg({ id: "b1", at: 2000, turnTerminal: true })] };
    const answer = await fixture({ messages })("GET", draftPath("t-lumi", "b1"));
    expect([answer.status, answer.body.code]).toEqual([409, "workflow_draw_no_request"]);
    const withBrief = await fixture({ messages, rows: [root("lumi", "t-lumi", "From the brief", 1100)] })("GET", draftPath("t-lumi", "b1"));
    expect(withBrief.body.draft.steps[0].instruction).toBe("From the brief");
  });

  it("answers 403 when the person may only view the request bot", async () => {
    const answer = await fixture({ levels: { lumi: "view" } })("GET", draftPath("t-lumi", "b1"));
    expect([answer.status, typeof answer.body.error]).toEqual([403, "string"]);
  });

  it("answers 503 while workflows are off, and 405 for another method", async () => {
    expect((await fixture({ off: true })("GET", draftPath("t-lumi", "b1"))).status).toBe(503);
    expect((await fixture()("POST", draftPath("t-lumi", "b1"))).status).toBe(405);
  });

  it("passes other message paths on", async () => {
    const call = fixture();
    expect((await call("GET", "/api/threads/t-lumi/messages/b1")).out).toBe(PASS);
    expect((await call("GET", "/api/workflows")).out).toBe(PASS);
  });

  const child = (botId: string, thread: string, brief: string, createdAt: number, id = `h-${botId}-${createdAt}`) =>
    ({ ...root(botId, thread, brief, createdAt), id, parentId: "a-lumi-1100", rootId: "a-lumi-1100", requester: { kind: "bot_turn", botId: "lumi", threadId: "t-lumi" } }) as Assignment;
  const lumiRoot = root("lumi", "t-lumi", "Summarize today's orders", 1100);

  it("names the draft by the words of a request that carries an attachment tag, and keeps the tag out of the first step", async () => {
    const tag = '<attached-image path="/data/attachments/x.png" name="x.png" />';
    const messages = { "t-lumi": [msg({ id: "u1", at: 1000, role: "user", text: `${tag}\nSend the weekly report` }), msg({ id: "b1", at: 2000, turnTerminal: true, requestMessageId: "u1" })] };
    const { body } = await fixture({ messages })("GET", draftPath("t-lumi", "b1"));
    expect(body.draft.name).toBe("Send the weekly report");
    expect(JSON.stringify(body)).not.toContain("attached-image");
  });

  it("falls back to the root brief when the request holds only an image or only pasted tags", async () => {
    for (const text of ['<attached-image path="/data/attachments/x.png" name="x.png" />', '<pasted-text index="1">\n</pasted-text>']) {
      const messages = { "t-lumi": [msg({ id: "u1", at: 1000, role: "user", text }), msg({ id: "b1", at: 2000, turnTerminal: true, requestMessageId: "u1" })] };
      const { status, body } = await fixture({ messages, rows: [lumiRoot] })("GET", draftPath("t-lumi", "b1"));
      expect(status).toBe(200);
      expect(body.draft.name).toBe("Summarize today's orders");
      expect(body.draft.steps[0].instruction).toBe("Summarize today's orders");
    }
  });

  it("skips a steer, an aside and a hand-off post when it looks for a room's request", async () => {
    for (const extra of [{ steered: true }, { aside: true }, { threadPost: { deliveryId: "d", fromBotId: "scout", fromThreadId: "t-scout" } }]) {
      const messages = { "t-room": [
        msg({ id: "u1", at: 1000, role: "user", text: "Plan the launch" }),
        msg({ id: "u2", at: 1500, role: "user", text: "Also mention the date", ...extra }),
        msg({ id: "b1", at: 3000, turnTerminal: true, from: { botId: "scout", name: "Scout", color: "" } }),
      ] };
      const rows = [root("lumi", "t-room", "Plan the launch", 1100), root("scout", "t-room", "Mentioned by Lumi (hop 1): Pull numbers", 2000)];
      const { body } = await fixture({ messages, rows })("GET", draftPath("t-room", "b1"));
      expect(body.draft.steps.map((s: any) => [s.botId, s.instruction])).toEqual([["lumi", "Plan the launch"], ["scout", "Pull numbers"]]);
    }
  });

  it("finds the request of a 1:1 reply without a request id and skips a steer line", async () => {
    const messages = { "t-lumi": [
      msg({ id: "u1", at: 1000, role: "user", text: "Summarize today's orders" }),
      msg({ id: "u2", at: 1500, role: "user", text: "Also the refunds", steered: true }),
      msg({ id: "b1", at: 2000, turnTerminal: true }),
    ] };
    const { status, body } = await fixture({ messages, rows: [lumiRoot, child("scout", "t-scout", "Pull orders", 1200)] })("GET", draftPath("t-lumi", "b1"));
    expect(status).toBe(200);
    expect(body.draft.name).toBe("Summarize today's orders");
    expect(body.draft.steps.map((s: any) => s.botId)).toEqual(["lumi", "scout"]);
  });

  it("leaves out a hand-off to a bot the person may only view, and counts it", async () => {
    const { body } = await fixture({ rows: [lumiRoot, child("scout", "t-scout", "SCOUT-WORK", 1200)], levels: { scout: "view" } })("GET", draftPath("t-lumi", "b1"));
    expect(body.draft.steps.map((s: any) => s.botId)).toEqual(["lumi"]);
    expect(body.omitted).toBe(1);
  });

  it("draws a post from the messages of the hand-off's conversation", async () => {
    const messages = {
      "t-lumi": [msg({ id: "u1", at: 1000, role: "user", text: "Summarize today's orders" }), msg({ id: "b1", at: 5000, turnTerminal: true, requestMessageId: "u1" })],
      "t-scout": [msg({ id: "m1", at: 1500, kind: "activity", from: { botId: "scout", name: "Scout", color: "" }, tool: { name: "TELEGRAM_SEND_MESSAGE", ok: true } } as never)],
    };
    const { body } = await fixture({ messages, rows: [lumiRoot, child("scout", "t-scout", "Pull orders", 1200)] })("GET", draftPath("t-lumi", "b1"));
    expect(body.draft.steps.map((s: any) => s.kind)).toEqual(["bot", "bot", "post"]);
  });

  it("does not read a deleted conversation, and reads each conversation once", async () => {
    const reads: string[] = [];
    const rows = [lumiRoot, child("scout", "t-deleted", "Pull orders", 1200), child("scout", "t-scout", "Pull more", 1300), child("scout", "t-scout", "Pull last", 1400)];
    const { status, body } = await fixture({ rows, viewer: { kind: "all" }, reads })("GET", draftPath("t-lumi", "b1"));
    expect(status).toBe(200);
    expect(body.draft.steps).toHaveLength(4);
    expect(reads).not.toContain("t-deleted");
    expect(reads.filter((thread) => thread === "t-scout")).toHaveLength(1);
  });
});
