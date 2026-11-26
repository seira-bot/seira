import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store, type StoreChange } from "./store.ts";
import { answerTaskSuggestion, offerTaskSuggestions, postTaskSuggestions, taskSuggestionsFromInput, TaskSuggestionTurns, TASK_SUGGESTIONS_NONE } from "./task-suggestions.ts";

const make = () => {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }), undefined, undefined, "en");
  const bot = store.createBot({ name: "Ava" });
  const changes: StoreChange[] = [];
  store.onChange((change) => changes.push(change));
  return { store, bot, changes };
};
const tasks = [{ title: "Draft the weekly summary", icon: "document" }, { title: "Plan next week", description: "From your calendar", icon: "nope" }];

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the task card input", () => {
  it("keeps at most 5 plain tasks with ids, an icon fallback and no repeated title", () => {
    const card = taskSuggestionsFromInput({ intro: "Try these:", tasks: [...tasks, { title: "plan next week" }, ...Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}` }))] });
    expect(card?.intro).toBe("Try these:");
    expect(card?.suggestions.map((one) => one.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(card?.suggestions[1]).toMatchObject({ title: "Plan next week", icon: "idea", state: "open", description: "From your calendar" });
  });

  it("drops a task that is empty, too long, a link, or holds a secret; null when none is left", () => {
    const card = taskSuggestionsFromInput({ tasks: [{ title: "" }, { title: "x".repeat(81) }, { title: "Open https://example.com now" }, { title: "Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, { title: "Tidy the inbox" }] });
    expect(card?.suggestions.map((one) => one.title)).toEqual(["Tidy the inbox"]);
    expect(taskSuggestionsFromInput({ tasks: [{ title: "" }] })).toBeNull();
    expect(taskSuggestionsFromInput({ tasks: "no" })).toBeNull();
    expect(taskSuggestionsFromInput(null)).toBeNull();
  });
});

describe("posting and answering a card", () => {
  it("stores one bot line with the card and its readable text", () => {
    const { store, bot } = make();
    const card = taskSuggestionsFromInput({ tasks })!;
    const line = postTaskSuggestions(store, bot.threadId, card);
    expect(store.messagesFor(bot.threadId).at(-1)).toMatchObject({ id: line.id, role: "bot", kind: "text", text: expect.stringContaining("- Draft the weekly summary"), taskSuggestions: card });
  });

  it("hides and shows with a new card object, a changedAt time and a message.patch frame; the state reads back from the store", () => {
    const { store, bot, changes } = make();
    const line = postTaskSuggestions(store, bot.threadId, taskSuggestionsFromInput({ tasks })!);
    const before = store.messagesFor(bot.threadId).at(-1)!.taskSuggestions;
    const hidden = answerTaskSuggestion(store, bot.threadId, line.id, "s1", "hide");
    expect(hidden.kind).toBe("change");
    const after = store.messagesFor(bot.threadId).at(-1)!.taskSuggestions!;
    expect(after).not.toBe(before);
    expect(after.suggestions[0]).toMatchObject({ state: "hidden", changedAt: expect.any(String) });
    expect(after.suggestions[1]?.state).toBe("open");
    expect(changes.filter((change) => change.type === "message.patch")).toHaveLength(1);
    expect(answerTaskSuggestion(store, bot.threadId, line.id, "s1", "hide").kind).toBe("same");
    expect(changes.filter((change) => change.type === "message.patch")).toHaveLength(1);
    expect(answerTaskSuggestion(store, bot.threadId, line.id, "s1", "show").kind).toBe("change");
    expect(store.messagesFor(bot.threadId).at(-1)!.taskSuggestions!.suggestions[0]?.state).toBe("open");
  });

  it("refuses Start on a hidden task and reports a missing line or task", () => {
    const { store, bot } = make();
    const line = postTaskSuggestions(store, bot.threadId, taskSuggestionsFromInput({ tasks })!);
    answerTaskSuggestion(store, bot.threadId, line.id, "s1", "hide");
    expect(answerTaskSuggestion(store, bot.threadId, line.id, "s1", "start").kind).toBe("refused");
    expect(answerTaskSuggestion(store, bot.threadId, line.id, "s9", "hide").kind).toBe("missing");
    expect(answerTaskSuggestion(store, bot.threadId, "nope", "s1", "hide").kind).toBe("missing");
  });

  it("records the started line id on Start", () => {
    const { store, bot } = make();
    const line = postTaskSuggestions(store, bot.threadId, taskSuggestionsFromInput({ tasks })!);
    answerTaskSuggestion(store, bot.threadId, line.id, "s2", "start", { startedMessageId: "m-9" });
    expect(store.messagesFor(bot.threadId).at(-1)!.taskSuggestions!.suggestions[1]).toMatchObject({ state: "started", startedMessageId: "m-9" });
  });
});

describe("the card request from a bot", () => {
  const deps = (store: Store, room = false, person = true) => ({ store, turns: new TaskSuggestionTurns(), isRoom: () => room, personStarted: () => person });

  it("stores the card and answers 201 with the message id and the kept count", () => {
    const { store, bot } = make();
    const answer = offerTaskSuggestions(deps(store), bot.threadId, "g1", { tasks });
    expect(answer).toEqual({ status: 201, body: { ok: true, messageId: store.messagesFor(bot.threadId).at(-1)!.id, kept: 2 } });
  });

  it("answers 400 with words the model can read when no task is kept, and stores nothing", () => {
    const { store, bot } = make();
    const lines = store.messagesFor(bot.threadId).length;
    expect(offerTaskSuggestions(deps(store), bot.threadId, "g1", { tasks: [{ title: "see http://x.example" }] })).toEqual({ status: 400, body: { error: TASK_SUGGESTIONS_NONE } });
    expect(store.messagesFor(bot.threadId)).toHaveLength(lines);
  });

  it("refuses a turn that a person did not start with 409 and stores nothing", () => {
    const { store, bot } = make();
    const lines = store.messagesFor(bot.threadId).length;
    expect(offerTaskSuggestions(deps(store, false, false), bot.threadId, "g1", { tasks }).status).toBe(409);
    expect(store.messagesFor(bot.threadId)).toHaveLength(lines);
  });

  it("leaves out an intro that holds a secret and keeps the tasks", () => {
    const card = taskSuggestionsFromInput({ intro: "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", tasks });
    expect(card?.intro).toBeUndefined();
    expect(card?.suggestions).toHaveLength(2);
  });

  it("refuses a room with 409 and stores nothing", () => {
    const { store, bot } = make();
    const lines = store.messagesFor(bot.threadId).length;
    expect(offerTaskSuggestions(deps(store, true), bot.threadId, "g1", { tasks }).status).toBe(409);
    expect(store.messagesFor(bot.threadId)).toHaveLength(lines);
  });

  it("refuses a second card in the same turn with 409 and allows one in the next turn", () => {
    const { store, bot } = make();
    const lines = store.messagesFor(bot.threadId).length;
    const shared = deps(store);
    expect(offerTaskSuggestions(shared, bot.threadId, "g1", { tasks }).status).toBe(201);
    expect(offerTaskSuggestions(shared, bot.threadId, "g1", { tasks }).status).toBe(409);
    expect(offerTaskSuggestions(shared, bot.threadId, "g2", { tasks }).status).toBe(201);
    shared.turns.clear(bot.threadId);
    expect(offerTaskSuggestions(shared, bot.threadId, "g2", { tasks }).status).toBe(201);
    expect(store.messagesFor(bot.threadId)).toHaveLength(lines + 3);
  });
});
