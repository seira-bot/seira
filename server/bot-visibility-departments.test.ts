import { describe, expect, it } from "vitest";

import { frameForMember, memberBody, memberBot, routineVisible, webhookVisible, workflowVisible, notFoundFor, pathSubject, VisibleSet, type FrameContext, type StreamSeen, type Viewer } from "./bot-visibility.ts";

const ADA: Viewer = { kind: "member", email: "ada@acme.test" };
const BOSS: Viewer = { kind: "all" };

const bots = [
  { id: "sales", threadId: "t-sales", section: "Sales", tasks: [{ threadId: "t-sales" }, { threadId: "t-sales-2" }], avatarUrl: "/api/attachments/sales.png" },
  { id: "fin", threadId: "t-fin", section: "Finance", tasks: [{ threadId: "t-fin" }], avatarUrl: "/api/attachments/fin.png" },
  { id: "chief", threadId: "t-chief" },
];
const groups = [
  { id: "room-sales", threadId: "t-room-sales", memberIds: ["sales"], section: "Sales" },
  { id: "room-fin", threadId: "t-room-fin", memberIds: ["fin"], section: "Finance" },
  { id: "room-mixed", threadId: "t-room-mixed", memberIds: ["sales", "fin"], section: "Sales" },
  { id: "room-general", threadId: "t-room-general", memberIds: ["sales"] },
  { id: "dm-sales", threadId: "t-dm-sales", memberIds: ["sales"], dm: true },
];
const grantOf = (departments: string[], botIds: string[] = []) => ({ departments: new Map(departments.map((name) => [name, "chat" as const])), bots: new Map(botIds.map((id) => [id, "chat" as const])) });
const sales = grantOf(["Sales"]);
const limited = new VisibleSet(bots, groups, ADA, undefined, undefined, sales);

describe("a member limited to some departments", () => {
  it("sees only the bots of those departments", () => {
    expect(limited.everything).toBe(false);
    expect(bots.filter((bot) => limited.bot(bot.id)).map((bot) => bot.id)).toEqual(["sales"]);
    expect(limited.limitedToDepartments).toBe(true);
  });

  it("sees General only when General is granted", () => {
    const withGeneral = new VisibleSet(bots, groups, ADA, undefined, undefined, grantOf(["Sales", ""]));
    expect(bots.filter((bot) => withGeneral.bot(bot.id)).map((bot) => bot.id)).toEqual(["sales", "chief"]);
  });

  it("sees a room only when its department is granted and every bot in it is visible", () => {
    expect(groups.filter((group) => limited.group(group.id)).map((group) => group.id)).toEqual(["room-sales", "dm-sales"]);
  });

  it("reads a conversation, an attachment and a department only inside the grant", () => {
    expect(limited.thread("t-sales-2")).toBe(true);
    expect(limited.thread("t-room-sales")).toBe(true);
    for (const thread of ["t-fin", "t-chief", "t-room-fin", "t-room-mixed", "t-room-general", "unknown"]) expect(limited.thread(thread), thread).toBe(false);
    expect(limited.attachment("sales.png", () => [])).toBe(true);
    expect(limited.attachment("fin.png", () => [])).toBe(false);
    expect(limited.attachment("fin.png", () => ["t-fin"])).toBe(false);
    expect(limited.sections(["Sales", "Finance", "Legal"])).toEqual(["Sales"]);
  });

  it("sees a routine, a workflow and a webhook only for what it may see", () => {
    expect(routineVisible({ botId: "sales" }, limited)).toBe(true);
    expect(routineVisible({ botId: "fin" }, limited)).toBe(false);
    expect(routineVisible({ groupId: "room-fin" }, limited)).toBe(false);
    expect(routineVisible({ botId: "sales", workflowBotIds: ["sales", "fin"] }, limited)).toBe(false);
    expect(workflowVisible({ steps: [{ kind: "bot", botId: "fin" }] }, limited)).toBe(false);
    expect(webhookVisible({ botId: "fin" }, limited)).toBe(false);
    expect(webhookVisible({ botId: "sales", groupId: "room-sales" }, limited)).toBe(true);
    expect(webhookVisible({ botId: "sales", groupId: "room-fin" }, limited)).toBe(false);
  });

  it("is told it may put a room only in a granted department", () => {
    expect(limited.departmentAllowed("Sales")).toBe(true);
    expect(limited.departmentAllowed(" Sales ")).toBe(true);
    expect(limited.departmentAllowed("Finance")).toBe(false);
    expect(limited.departmentAllowed("")).toBe(false);
    expect(limited.departmentAllowed(undefined)).toBe(false);
    expect(limited.departmentAllowed({})).toBe(false);
    expect(new VisibleSet(bots, groups, ADA).departmentAllowed("Finance")).toBe(true);
  });

  it("sees nothing at all when the granted set is empty", () => {
    const none = new VisibleSet(bots, groups, ADA, undefined, undefined, grantOf([]));
    expect(bots.some((bot) => none.bot(bot.id))).toBe(false);
    expect(groups.some((group) => none.group(group.id))).toBe(false);
    expect(none.sections(["Sales"])).toEqual([]);
  });

  it("leaves an admin and a member with no grant as they were", () => {
    const boss = new VisibleSet(bots, groups, BOSS, undefined, undefined, sales);
    expect(boss.everything).toBe(true);
    expect(boss.limitedToDepartments).toBe(false);
    const whole = new VisibleSet(bots, groups, ADA, undefined, undefined, null);
    expect(whole.everything).toBe(true);
    expect(whole.departmentAllowed("Finance")).toBe(true);
  });

  it("answers a bot outside its departments with the answer for a bot that does not exist", () => {
    const subject = pathSubject("/api/bots/fin/messages")!;
    expect(subject).toEqual({ kind: "bot", id: "fin" });
    expect(limited.bot("fin")).toBe(false);
    expect(limited.bot("no-such-bot")).toBe(false);
    expect(notFoundFor(subject)).toBe(notFoundFor({ kind: "bot", id: "no-such-bot" }));
    for (const path of ["/api/threads/t-fin/messages", "/api/groups/room-fin", "/api/routines/x"]) expect(notFoundFor(pathSubject(path)!)).toMatch(/^no such /);
  });
});

describe("live frames for a member limited to some departments", () => {
  const context = (visible: VisibleSet): FrameContext => ({
    visible,
    webhook: (id) => ({ "hook-fin": { botId: "fin" } } as Record<string, { botId: string; groupId?: string }>)[id],
    freshBot: (id) => ({ id, messages: [] }),
    freshGroup: (id) => ({ id, messages: [] }),
  });
  const seen = (): StreamSeen => ({ bots: new Set(["sales"]), groups: new Set(["room-sales"]) });

  it("sends no frame about a bot, room, conversation or department outside the grant", () => {
    const ctx = context(limited);
    const hidden: Array<Record<string, unknown>> = [
      { kind: "message", threadId: "t-fin", message: { id: "x" } },
      { kind: "message.patch", threadId: "t-room-fin", message: { id: "x" } },
      { kind: "thread", threadId: "t-chief" },
      { kind: "bot", bot: { id: "fin" } },
      { kind: "bot", bot: { id: "chief" } },
      { kind: "group", group: { id: "room-fin" } },
      { kind: "group", group: { id: "room-mixed" } },
      { kind: "notify", notification: { botId: "fin", threadId: "t-fin" } },
      { kind: "runtime", event: { type: "content.delta", threadId: "t-fin" } },
      { kind: "screen", botId: "fin", threadId: "t-fin", png: "x" },
      { kind: "computer", botId: "fin" },
      { kind: "routine", routine: { id: "r", botId: "fin" } },
      { kind: "workflow", workflow: { id: "w", steps: [{ kind: "bot", botId: "fin" }] } },
      { kind: "webhook", webhook: { id: "hook-fin", botId: "fin" } },
      { kind: "webhook.attempt", attempt: { webhookId: "hook-fin" } },
      { kind: "future-kind", botId: "fin" },
      { kind: "future-kind", groupId: "room-fin" },
    ];
    for (const frame of hidden) expect(frameForMember(frame, ctx, seen()), JSON.stringify(frame)).toBeUndefined();
    expect(frameForMember({ kind: "sections", sections: ["Sales", "Finance"] }, ctx, seen())).toEqual({ kind: "sections", sections: ["Sales"] });
    expect(frameForMember({ kind: "bots.order", botIds: ["fin", "sales", "chief"] }, ctx, seen())).toEqual({ kind: "bots.order", botIds: ["sales"] });
    expect(frameForMember({ kind: "groups.order", groupIds: ["room-fin", "room-sales"] }, ctx, seen())).toEqual({ kind: "groups.order", groupIds: ["room-sales"] });
    expect(frameForMember({ kind: "bot.queued", queues: { "t-fin": [1], "t-sales": [2] } }, ctx, seen())).toEqual({ kind: "bot.queued", queues: { "t-sales": [2] } });
    const own = { kind: "message", threadId: "t-sales", message: { id: "x" } };
    expect(frameForMember(own, ctx, seen())).toBe(own);
  });

  it("withdraws a bot once when its department leaves the grant", () => {
    const state = seen();
    const before = new VisibleSet(bots, groups, ADA, undefined, undefined, grantOf(["Sales", "Finance"]));
    expect(frameForMember({ kind: "bot", bot: { id: "fin" } }, context(before), state)).toMatchObject({ kind: "bot" });
    expect(frameForMember({ kind: "bot", bot: { id: "fin" } }, context(limited), state)).toEqual({ kind: "bot.deleted", botId: "fin" });
    expect(frameForMember({ kind: "bot", bot: { id: "fin" } }, context(limited), state)).toBeUndefined();
  });
});

describe("names outside the grant", () => {
  const ctx = (visible: VisibleSet) => ({ visible } as unknown as FrameContext);
  const seen = {} as StreamSeen;
  const pauses = { heldBots: ["sales", "fin"], pausedBots: ["fin", "chief"], pausedByPerson: { bots: ["sales", "fin"], departments: ["Sales", "Finance"], all: true } };

  it("cuts the pause lists of a config frame to the bots and departments it may see", () => {
    const frame = frameForMember({ kind: "config", language: "en", ...pauses }, ctx(limited), seen)!;
    expect(frame.heldBots).toEqual(["sales"]);
    expect(frame.pausedBots).toEqual([]);
    expect(frame.pausedByPerson).toEqual({ bots: ["sales"], departments: ["Sales"], all: true });
    expect(frame.language).toBe("en");
  });

  it("cuts the same lists in a response body", () => {
    expect(memberBody({ language: "en", ...pauses }, limited)).toEqual({ language: "en", heldBots: ["sales"], pausedBots: [], pausedByPerson: { bots: ["sales"], departments: ["Sales"], all: true } });
  });

  it("leaves the lists whole for someone who sees everything", () => {
    const everything = new VisibleSet(bots, groups, { kind: "member", email: "x@acme.test" });
    expect(memberBody(pauses, everything)).toEqual(pauses);
  });

  it("cuts a Chief's departments to the granted ones, and only for a limited person", () => {
    const chief = { id: "sales", section: "Sales", chiefOfStaff: true, managedSections: ["Sales", "Finance", ""] };
    expect(memberBot(chief, limited).managedSections).toEqual(["Sales"]);
    expect(memberBot(chief, new VisibleSet(bots, groups, ADA, undefined, undefined, grantOf(["Sales", ""]))).managedSections).toEqual(["Sales", ""]);
    expect(memberBot(chief, new VisibleSet(bots, groups, ADA)).managedSections).toEqual(["Sales", "Finance", ""]);
  });
});
