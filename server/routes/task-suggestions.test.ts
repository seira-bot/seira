// POST /api/bots/:id/task-suggestions: Start, Hide and Show on a task card.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { requiredScope } from "../request-auth.ts";
import { Store, type StoreChange } from "../store.ts";
import { postTaskSuggestions, taskSuggestionsFromInput } from "../task-suggestions.ts";
import { createTaskSuggestionRoutes } from "./task-suggestions.ts";
import { PASS } from "./table.ts";
import { PublicError } from "../public-error.ts";

const person: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

function setup(options: { visible?: boolean; refusal?: string | null; sendStatus?: number; sendThrows?: Error; hold?: Promise<void>; noMessage?: boolean } = {}) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }), undefined, undefined, "en");
  const bot = store.createBot({ name: "Ava" });
  const changes: StoreChange[] = [];
  store.onChange((change) => changes.push(change));
  const sent: string[] = [];
  const send = async (_auth: RequestAuth, _botId: string, threadId: string, text: string) => {
    if (options.sendThrows) throw options.sendThrows;
    if (options.sendStatus) throw new PublicError("Ava is busy.", options.sendStatus);
    sent.push(text);
    await options.hold;
    return options.noMessage ? { ok: true as const } : { ok: true as const, message: store.appendMessage(threadId, { role: "user", kind: "text", text }) };
  };
  const route = createTaskSuggestionRoutes({ store, threadVisible: () => options.visible ?? true, sendRefusal: () => options.refusal ?? null, send });
  const card = postTaskSuggestions(store, bot.threadId, taskSuggestionsFromInput({ tasks: [{ title: "Draft the weekly summary" }, { title: "Plan next week" }] })!);
  const call = async (body: unknown, botId = bot.id, method = "POST", path = `/api/bots/${botId}/task-suggestions`) => {
    let answer: { status: number; body: any } | undefined;
    const handled = await route({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: person,
      json: (_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }, readBody: async () => body } as never);
    return handled === PASS ? "pass" : answer!;
  };
  const act = (action: string, suggestionId = "s1") => call({ threadId: bot.threadId, messageId: card.id, suggestionId, action });
  const stored = () => store.messagesFor(bot.threadId).find((line) => line.id === card.id)!.taskSuggestions!.suggestions;
  return { store, bot, card, call, act, sent, stored, changes };
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the task card route", () => {
  it("passes other paths and methods by", async () => {
    const s = setup();
    expect(await s.call({}, s.bot.id, "GET")).toBe("pass");
    expect(await s.call({}, s.bot.id, "POST", "/api/bots/x/other")).toBe("pass");
  });

  it("is open to a signed-in client, by POST only", () => {
    expect(requiredScope("POST", "/api/bots/b1/task-suggestions")).toBe("client");
    expect(requiredScope("DELETE", "/api/bots/b1/task-suggestions")).toBe("admin");
  });

  it("rejects ids and actions that are malformed with 400", async () => {
    const s = setup();
    const ok = { threadId: s.bot.threadId, messageId: s.card.id, suggestionId: "s1", action: "hide" };
    for (const bad of [{ threadId: "a b" }, { threadId: undefined }, { messageId: "../x" }, { suggestionId: "x".repeat(129) }, { action: "delete" }, { action: 3 }]) {
      expect(await s.call({ ...ok, ...bad }), JSON.stringify(bad)).toMatchObject({ status: 400 });
    }
    expect(await s.call(null)).toMatchObject({ status: 400 });
  });

  it("answers 404 for an unknown bot", async () => {
    const s = setup();
    expect(await s.call({ threadId: s.bot.threadId, messageId: s.card.id, suggestionId: "s1", action: "hide" }, "bot-none")).toEqual({ status: 404, body: { error: "no such bot" } });
  });

  it("answers 403 with the reason when the caller may not write there, and changes nothing", async () => {
    const s = setup({ refusal: "Not yours." });
    expect(await s.act("hide")).toEqual({ status: 403, body: { error: "Not yours." } });
    expect(s.stored()[0]?.state).toBe("open");
  });

  it("answers 404 when the line, the card or the task is missing, or the line is in another thread", async () => {
    const s = setup();
    const plain = s.store.appendMessage(s.bot.threadId, { role: "bot", kind: "text", text: "hello" });
    const other = s.store.createBot({ name: "Bo" });
    const missing = { status: 404, body: { errorKey: "serverError.taskSuggestion.missing" } };
    expect(await s.call({ threadId: s.bot.threadId, messageId: "m-none", suggestionId: "s1", action: "hide" })).toMatchObject(missing);
    expect(await s.call({ threadId: s.bot.threadId, messageId: plain.id, suggestionId: "s1", action: "hide" })).toMatchObject(missing);
    expect(await s.act("hide", "s9")).toMatchObject(missing);
    expect(await s.call({ threadId: other.threadId, messageId: s.card.id, suggestionId: "s1", action: "hide" })).toMatchObject(missing);
  });

  it("answers 404 when the caller cannot see the conversation, and changes nothing", async () => {
    const s = setup({ visible: false });
    expect(await s.act("hide")).toMatchObject({ status: 404, body: { errorKey: "serverError.taskSuggestion.missing" } });
    expect(await s.act("start")).toMatchObject({ status: 404 });
    expect(s.sent).toEqual([]);
    expect(s.stored()[0]?.state).toBe("open");
  });

  it("answers 404 when the thread is not that bot's, even if the line exists", async () => {
    const s = setup();
    const other = s.store.createBot({ name: "Bo" });
    expect(await s.call({ threadId: s.bot.threadId, messageId: s.card.id, suggestionId: "s1", action: "hide" }, other.id)).toMatchObject({ status: 404, body: { errorKey: "serverError.taskSuggestion.missing" } });
    expect(s.stored()[0]?.state).toBe("open");
  });

  it("hides and shows, patching the stored line and sending a message.patch frame", async () => {
    const s = setup();
    const hidden = await s.act("hide");
    expect(hidden).toMatchObject({ status: 200, body: { ok: true, message: { id: s.card.id } } });
    expect(hidden !== "pass" && hidden.body.message.taskSuggestions.suggestions[0]).toMatchObject({ state: "hidden", changedAt: expect.any(String) });
    expect(s.stored()[0]?.state).toBe("hidden");
    expect(s.changes.filter((change) => change.type === "message.patch")).toHaveLength(1);
    expect(await s.act("show")).toMatchObject({ status: 200, body: { ok: true } });
    expect(s.stored()[0]?.state).toBe("open");
    expect(s.sent).toEqual([]);
  });

  it("answers 200 with no patch for a repeated Hide or a Show on an open task", async () => {
    const s = setup();
    await s.act("hide");
    const patches = s.changes.length;
    expect(await s.act("hide")).toMatchObject({ status: 200, body: { ok: true } });
    expect(await s.act("show", "s2")).toMatchObject({ status: 200, body: { ok: true } });
    expect(s.changes).toHaveLength(patches);
  });

  it("answers 409 with the current line for Start on a hidden task and Hide on a started one", async () => {
    const s = setup();
    await s.act("hide");
    expect(await s.act("start")).toMatchObject({ status: 409, body: { errorKey: "serverError.taskSuggestion.changed", message: { id: s.card.id } } });
    await s.act("start", "s2");
    expect(await s.act("hide", "s2")).toMatchObject({ status: 409, body: { errorKey: "serverError.taskSuggestion.changed" } });
    expect(await s.act("start", "s2")).toMatchObject({ status: 409, body: { errorKey: "serverError.taskSuggestion.changed" } });
    expect(s.sent).toEqual(["Plan next week"]);
  });

  it("sends the title as the person's line on Start and links the line and the card both ways", async () => {
    const s = setup();
    const started = await s.act("start");
    const person = s.store.messagesFor(s.bot.threadId).find((line) => line.role === "user")!;
    expect(s.sent).toEqual(["Draft the weekly summary"]);
    expect(person.fromTaskSuggestion).toEqual({ messageId: s.card.id, suggestionId: "s1" });
    expect(started).toMatchObject({ status: 200, body: { ok: true, message: { id: s.card.id }, sent: { id: person.id, fromTaskSuggestion: { messageId: s.card.id, suggestionId: "s1" } } } });
    expect(s.stored()[0]).toMatchObject({ state: "started", startedMessageId: person.id, changedAt: expect.any(String) });
    expect(s.stored()[1]?.state).toBe("open");
  });

  it("marks the task started without a person line when the send stored none", async () => {
    const s = setup({ noMessage: true });
    const started = await s.act("start");
    expect(started).toMatchObject({ status: 200, body: { ok: true } });
    expect(started !== "pass" && "sent" in started.body).toBe(false);
    expect(s.stored()[0]?.state).toBe("started");
    expect(s.stored()[0]).not.toHaveProperty("startedMessageId");
  });

  it("answers any action on that card with 409 while a Start is on its way", async () => {
    let release!: () => void;
    const s = setup({ hold: new Promise<void>((resolve) => { release = resolve; }) });
    const first = s.act("start");
    await Promise.resolve();
    await Promise.resolve();
    const busy = { status: 409, body: { errorKey: "serverError.chat.answerSent" } };
    expect(await s.act("start")).toMatchObject(busy);
    expect(await s.act("hide", "s2")).toMatchObject(busy);
    release();
    expect(await first).toMatchObject({ status: 200 });
    expect(s.sent).toHaveLength(1);
    expect(await s.act("hide", "s2")).toMatchObject({ status: 200 });
  });

  it("leaves the card open and returns the refusal status when the send is refused", async () => {
    const s = setup({ sendStatus: 409 });
    expect(await s.act("start")).toEqual({ status: 409, body: { error: "Ava is busy." } });
    expect(s.stored()[0]?.state).toBe("open");
    expect(s.store.messagesFor(s.bot.threadId).filter((line) => line.role === "user")).toHaveLength(0);
  });

  it("rethrows an error that has no status, and frees the card", async () => {
    const s = setup({ sendThrows: new Error("boom") });
    await expect(s.act("start")).rejects.toThrow("boom");
    expect(s.stored()[0]?.state).toBe("open");
  });
});
