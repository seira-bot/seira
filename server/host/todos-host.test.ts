import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Audience } from "../audience.ts";
import { TODO_BOT_DAILY_MAX, TODO_MAX_DEPTH } from "../../shared/todo.ts";
import { workOrigin } from "../peer-provenance.ts";
import type { BotAccessLevel } from "../../shared/bot-access.ts";
import { publicTodo, TodoStore, type TodoPerson } from "../todos.ts";
import { createTodoLauncher, createTodosHost, TodoError, type TodoBot, type TodoRoutines } from "./todos-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const BOTS: TodoBot[] = [{ id: "atlas", name: "Atlas" }, { id: "scout", name: "Scout" }, { id: "chief", name: "Chief", chiefOfStaff: true }];
const person = { kind: "person" as const, name: "Rama" };

function setup(over: { routines?: TodoRoutines | null; audiences?: Record<string, Audience>; levelFor?: (person: TodoPerson | undefined, botId: string) => BotAccessLevel } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "todos-host-"));
  dirs.push(dir);
  const clock = { now: 1_800_000_000_000 };
  let n = 0;
  const store = new TodoStore({ dataDir: dir, now: () => clock.now, newId: () => `t${++n}` });
  const made: unknown[] = [];
  const removed: string[] = [];
  const updated: Array<[string, unknown]> = [];
  const routines: TodoRoutines = {
    create: (input) => { made.push(input); return { id: `r${made.length}` }; },
    remove: (id) => { removed.push(id); return true; },
    update: (id, patch) => { updated.push([id, patch]); return null; },
  };
  const host = createTodosHost({ store, bots: () => BOTS, routines: () => (over.routines === undefined ? routines : over.routines), teamCloud: false, levelFor: over.levelFor ?? (() => "chat"), audienceOf: (threadId) => over.audiences?.[threadId] ?? "team" });
  return { host, store, clock, made, removed, updated };
}

describe("add", () => {
  it("puts a todo with a bot last in that bot's queue, and a todo without a bot in Open (AC-02)", () => {
    const { host } = setup();
    const [a, b, open] = host.add([{ title: "One", botId: "atlas" }, { title: "Two", botId: "atlas" }, { title: "Three" }], person).todos;
    expect(a).toMatchObject({ status: "queued", botId: "atlas", rank: 1, start: { kind: "free" } });
    expect(b).toMatchObject({ status: "queued", rank: 2 });
    expect(open).toMatchObject({ status: "open" });
    expect(open!.botId).toBeUndefined();
    const more = host.add([{ title: "Four", botId: "atlas" }], person).todos[0]!;
    expect(more.rank).toBe(3);
  });

  it("points afterIndex at an earlier draft and refuses a later one", () => {
    const { host } = setup();
    const todos = host.add([{ title: "First", botId: "atlas" }, { title: "Second", botId: "atlas", afterIndex: 0 }], person).todos;
    expect(todos[1]!.start).toEqual({ kind: "after", todoId: todos[0]!.id });
    expect(() => host.add([{ title: "Bad", afterIndex: 0 }], person)).toThrow(TodoError);
  });

  it("refuses an empty title, a long title, an unknown bot and too many drafts", () => {
    const { host } = setup();
    expect(() => host.add([{ title: "  " }], person)).toThrow("Give the todo a title.");
    expect(() => host.add([{ title: "x".repeat(121) }], person)).toThrow(TodoError);
    expect(() => host.add([{ title: "ok", botId: "nope" }], person)).toThrow("That bot is not on your team.");
    expect(() => host.add(Array.from({ length: 11 }, () => ({ title: "t" })), person)).toThrow(TodoError);
  });

  it("makes a routine at once for a repeating todo with a bot, and keeps a botless one open (AC-11)", () => {
    const { host, made } = setup();
    const [withBot, without] = host.add([
      { title: "Daily digest", note: "Send it", botId: "atlas", repeat: { time: "09:00", weekdays: [1, 2, 3] } },
      { title: "Weekly look", repeat: { time: "10:30", weekdays: [] } },
    ], person).todos;
    expect(made).toEqual([{ name: "Daily digest", prompt: "Daily digest\n\nSend it", botId: "atlas", schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3] } }]);
    expect(withBot!.routineId).toBe("r1");
    expect(without).toMatchObject({ status: "open" });
    expect(without!.routineId).toBeUndefined();
  });

  it("makes the routine when an open repeating todo gets a bot, and drops it when the bot goes", () => {
    const { host, made, removed } = setup();
    const todo = host.add([{ title: "Weekly look", repeat: { time: "10:30", weekdays: [1] } }], person).todos[0]!;
    const given = host.patch(todo.id, { botId: "scout" }, person);
    expect(given).toMatchObject({ status: "queued", botId: "scout", routineId: "r1" });
    expect(made).toHaveLength(1);
    const open = host.patch(todo.id, { botId: null }, person);
    expect(open).toMatchObject({ status: "open" });
    expect(open.routineId).toBeUndefined();
    expect(removed).toEqual(["r1"]);
  });

  it("refuses a bad time for a repeat and a repeat when routines are off", () => {
    expect(() => setup().host.add([{ title: "x", botId: "atlas", repeat: { time: "9am", weekdays: [] } }], person)).toThrow(TodoError);
    expect(() => setup({ routines: null }).host.add([{ title: "x", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }], person)).toThrow(TodoError);
  });
});

describe("limits for a bot (AC-12)", () => {
  const bot = { kind: "bot" as const, botId: "atlas" };

  it("refuses the 21st todo in one day, and counts again after 24 hours", () => {
    const { host, clock } = setup();
    for (let i = 0; i < TODO_BOT_DAILY_MAX; i += 1) expect(host.add([{ title: `Job ${i}`, botId: "scout" }], bot).todos).toHaveLength(1);
    const refused = host.add([{ title: "One too many", botId: "scout" }], bot);
    expect(refused.todos).toEqual([]);
    expect(refused.refused[0]).toContain(String(TODO_BOT_DAILY_MAX));
    clock.now += 24 * 60 * 60_000 + 1;
    expect(host.add([{ title: "Next day", botId: "scout" }], bot).todos).toHaveLength(1);
  });

  it("refuses a todo from a bot working on a todo of the deepest level", () => {
    const { host } = setup();
    const parent = host.add([{ title: "Deep", botId: "atlas" }], bot, { depth: TODO_MAX_DEPTH - 1 }).todos[0]!;
    expect(parent.depth).toBe(TODO_MAX_DEPTH - 1);
    expect(host.add([{ title: "Too deep", botId: "scout" }], bot, { depth: TODO_MAX_DEPTH }).refused).toHaveLength(1);
    expect(host.add([{ title: "Too deep", botId: "scout" }], person).todos).toHaveLength(1);
  });

  it("returns the existing todo for a same-title todo of the same bot, ignoring case and spaces", () => {
    const { host } = setup();
    const first = host.add([{ title: "Check  the logs", botId: "scout" }], bot).todos[0]!;
    const again = host.add([{ title: "check the LOGS", botId: "scout" }], bot);
    expect(again.todos).toEqual([]);
    expect(again.existing.map((todo) => todo.id)).toEqual([first.id]);
    expect(host.add([{ title: "check the logs", botId: "atlas" }], bot).todos).toHaveLength(1);
  });

  it("gives a bot's todo its depth from the todo it works on, and zero from a person's chat", () => {
    const { host, store } = setup();
    const top = host.add([{ title: "Top", botId: "atlas" }], person).todos[0]!;
    store.update(top.id, (todo) => { todo.threadId = "th-top"; });
    expect(host.depthFor("th-top")).toBe(1);
    expect(host.depthFor("th-other")).toBe(0);
    const child = host.botAdd({ botId: "atlas", threadId: "th-top" }, [{ title: "Child", assigneeBotId: "Scout" }]).todos[0]!;
    expect(child).toMatchObject({ depth: 1, botId: "scout", madeBy: { kind: "bot", botId: "atlas" }, source: { threadId: "th-top", botId: "atlas" } });
  });
});

describe("patch and delete", () => {
  it("reorders in the queue with beforeId and to the end with null", () => {
    const { host, store } = setup();
    const [a, b, c] = host.add([{ title: "A", botId: "atlas" }, { title: "B", botId: "atlas" }, { title: "C", botId: "atlas" }], person).todos;
    host.patch(c!.id, { beforeId: a!.id }, person);
    const order = () => store.live().filter((todo) => todo.botId === "atlas").sort((x, y) => x.rank - y.rank).map((todo) => todo.title);
    expect(order()).toEqual(["C", "A", "B"]);
    host.patch(c!.id, { beforeId: null }, person);
    expect(order()).toEqual(["A", "B", "C"]);
    expect(() => host.patch(a!.id, { beforeId: "nope" }, person)).toThrow(TodoError);
    void b;
  });

  it("gives a todo to another bot at the end of that queue, and opens it again with a null bot", () => {
    const { host } = setup();
    host.add([{ title: "Scout work", botId: "scout" }], person);
    const todo = host.add([{ title: "Mine", botId: "atlas" }], person).todos[0]!;
    expect(host.patch(todo.id, { botId: "scout" }, person)).toMatchObject({ botId: "scout", rank: 2, status: "queued" });
    expect(host.patch(todo.id, { botId: null }, person)).toMatchObject({ status: "open" });
  });

  it("moves a todo to Done by hand, with who did it, and back to the queue", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Mine", botId: "atlas" }], person).todos[0]!;
    expect(host.patch(todo.id, { status: "done" }, person)).toMatchObject({ status: "done", closedBy: person });
    const back = host.patch(todo.id, { status: "queued" }, person);
    expect(back).toMatchObject({ status: "queued", attempts: 0 });
    expect(back.closedBy).toBeUndefined();
  });

  it("refuses to change the bot of a working todo", () => {
    const { host, store } = setup();
    const todo = host.add([{ title: "Mine", botId: "atlas" }], person).todos[0]!;
    store.claim(todo.id);
    expect(() => host.patch(todo.id, { botId: "scout" }, person)).toThrow(TodoError);
  });

  it("deletes with its routine and restores with a new routine", () => {
    const { host, store, removed, made } = setup();
    const todo = host.add([{ title: "Digest", botId: "atlas", repeat: { time: "08:00", weekdays: [] } }], person).todos[0]!;
    host.remove(todo.id);
    expect(removed).toEqual(["r1"]);
    expect(store.get(todo.id)).toBeUndefined();
    const back = host.restore(todo.id);
    expect(back.routineId).toBe("r2");
    expect(made).toHaveLength(2);
    expect(() => host.restore("nope")).toThrow(TodoError);
  });

  it("keeps the picker choice", () => {
    const { host } = setup();
    expect(host.picker()).toBe("chief");
    expect(host.setPicker("atlas")).toBe("atlas");
    expect(host.setPicker(null)).toBeNull();
    expect(() => host.setPicker("nope")).toThrow(TodoError);
  });
});

describe("tools for a bot (AC-16)", () => {
  const caller = { botId: "chief", threadId: "th" };

  it("lets the picker give an open todo to a bot with a reason, and records who picked", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Find numbers" }], person).todos[0]!;
    const assigned = host.botAssign(caller, { todoId: todo.id, assigneeBotId: "scout", reason: "Scout reads data" });
    expect(assigned).toMatchObject({ status: "queued", botId: "scout", pickedBy: { botId: "chief", reason: "Scout reads data" } });
  });

  it("refuses a bot that has no claim on the todo", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Scout work", botId: "scout" }], person).todos[0]!;
    expect(() => host.botAssign({ botId: "atlas", threadId: "t" }, { todoId: todo.id, assigneeBotId: "atlas", reason: "mine" })).toThrow(TodoError);
    expect(() => host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: todo.id, status: "done" })).toThrow(TodoError);
  });

  it("updates the todos it made or owns: done with a result, rename, back to the queue", () => {
    const { host } = setup();
    const own = host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Mine", assigneeBotId: "atlas" }]).todos[0]!;
    expect(host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: own.id, title: "Renamed", note: "n" })).toMatchObject({ title: "Renamed", note: "n" });
    expect(host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: own.id, status: "done", result: "All good" })).toMatchObject({ status: "done", result: "All good", closedBy: { kind: "bot", botId: "atlas" } });
    expect(host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: own.id, status: "queued" })).toMatchObject({ status: "queued" });
  });

  it("refuses a time that is no date and a bot that is not on the team", () => {
    const { host } = setup();
    expect(() => host.botAdd(caller, [{ title: "x", when: "someday" }])).toThrow(TodoError);
    expect(() => host.botAdd(caller, [{ title: "x", assigneeBotId: "ghost" }])).toThrow(TodoError);
  });

  it("lists only what the caller may read, in line order", () => {
    const { host } = setup();
    host.add([{ title: "A", botId: "atlas" }, { title: "B", botId: "scout" }], person);
    expect(host.botList({ assigneeBotId: "Scout" }, () => true).map((todo) => todo.title)).toEqual(["B"]);
    expect(host.botList({}, (todo) => todo.title === "A").map((todo) => todo.title)).toEqual(["A"]);
    expect(host.botList({ status: "done" }, () => true)).toEqual([]);
  });
});

describe("launch provenance", () => {
  function launcher(over: { audience?: Audience; adoptable?: boolean } = {}) {
    const adopted: Array<[string, string]> = [];
    const calls: Array<{ botId: string; text: string; opts: any }> = [];
    const lines: Array<Record<string, unknown>> = [];
    const queued: unknown[] = [];
    let admits = true;
    const opened: Array<[string, string]> = [];
    const launch = createTodoLauncher({
      store: {
        appendMessage: (_thread, message) => { lines.push(message); return { id: "line1", ...message }; },
      },
      openTask: (todo, title) => { opened.push([todo.id, title]); return { threadId: "th1" }; },
      startTurn: async (botId, text, opts) => { calls.push({ botId, text, opts }); },
      admits: () => admits,
      queue: (...args) => { queued.push(args); },
      botName: (id) => (id === "scout" ? "Scout" : undefined),
      audienceOf: () => over.audience ?? "team",
      adoptable: (audience) => audience === "team" || over.adoptable !== false,
      adopt: (threadId, audience) => { adopted.push([threadId, audience]); },
    });
    return { launch, calls, lines, queued, opened, adopted, deny: () => { admits = false; } };
  }
  const input = (over: { force?: boolean } = {}) => ({ line: "Do it", prompt: "Do it\n\nReply.", force: false, onThread: () => {}, onFailed: () => {}, ...over });
  const record = (madeBy: any, person?: TodoPerson) => ({ id: "td", title: "Do it", status: "working" as const, botId: "atlas", start: { kind: "free" as const }, rank: 1, madeBy, ...(person ? { person } : {}), attempts: 1, depth: 0, createdAt: 1, updatedAt: 1 });

  it("never labels a todo a bot made as the person's request", async () => {
    const { launch, calls, lines } = launcher();
    await launch(record({ kind: "bot", botId: "scout" }), input());
    expect(lines[0]).toMatchObject({ role: "user", fromTodo: "td", peerAsk: { botId: "scout", name: "Scout" } });
    expect(workOrigin(lines[0] as never)).toEqual({ kind: "outside" });
    expect(calls[0]!.opts).toMatchObject({ unattended: true, origin: { kind: "outside" }, peerAsk: { botId: "scout" }, trigger: { kind: "bot", botId: "scout" } });
  });

  it("runs a todo a person made as unattended outside work, like a routine", async () => {
    const { launch, calls, lines } = launcher();
    await launch(record({ kind: "person", name: "Rama" }), input());
    expect(lines[0]).toMatchObject({ fromTodo: "td", automated: true });
    expect(calls[0]!.opts).toMatchObject({ unattended: true, origin: { kind: "outside" }, trigger: { kind: "routine" } });
    expect(calls[0]!.opts.peerAsk).toBeUndefined();
  });

  it("makes the work conversation private to the audience of its todo before the first line (security)", async () => {
    const { launch, adopted, lines } = launcher({ audience: "member:rama" });
    await launch(record({ kind: "person", name: "Rama" }), input());
    expect(adopted).toEqual([["th1", "member:rama"]]);
    expect(lines).toHaveLength(1);
  });

  it("does not start work for an audience its conversation cannot be kept private to (security)", async () => {
    const { launch, opened, lines, calls } = launcher({ audience: "room:g", adoptable: false });
    await expect(launch(record({ kind: "person", name: "Rama" }), input())).rejects.toThrow("cannot be kept private");
    expect(opened).toEqual([]);
    expect(lines).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("opens a person's todo as that person and names them, without acting for them (security)", async () => {
    const { launch, calls, lines, opened } = launcher();
    const pat: TodoPerson = { key: "p_pat", viewer: { kind: "member", email: "pat@example.com" } };
    await launch(record({ kind: "person", name: "Pat" }, pat), input());
    expect(opened).toEqual([["td", "Do it"]]);
    expect(lines[0]!.sender).toEqual({ name: "Pat" });
    expect(calls[0]!.opts.sender).toEqual({ name: "Pat" });
    expect(calls[0]!.opts.trigger).toEqual({ kind: "routine", label: "Todo", email: "pat@example.com" });
    expect(calls[0]!.opts.origin).toEqual({ kind: "outside" });
  });

  it("names nobody on a todo a bot made", async () => {
    const { launch, calls, lines } = launcher();
    await launch(record({ kind: "bot", botId: "scout" }, { key: "p_pat" }), input());
    expect(lines[0]!.sender).toBeUndefined();
    expect(calls[0]!.opts.sender).toBeUndefined();
  });

  it("queues behind the bot's work for Start now and refuses an automatic start without room", async () => {
    const { launch, queued, calls, lines, deny } = launcher();
    deny();
    await expect(launch(record({ kind: "person", name: "R" }), input())).rejects.toThrow();
    expect(lines).toHaveLength(0);
    await launch(record({ kind: "person", name: "R" }), input({ force: true }));
    expect(lines).toEqual([expect.objectContaining({ role: "user", text: "Do it", fromTodo: "td" })]);
    expect(queued).toEqual([["atlas", "th1", "Do it", expect.objectContaining({ prompt: "Do it\n\nReply.", rowId: "line1", unattended: true, sender: { name: "R" } })]]);
    expect(calls).toHaveLength(0);
  });
});

describe("security: audience of a todo", () => {
  it("does not match a same-title todo of another audience, so the answer shows nothing of it", () => {
    const { host } = setup({ audiences: { mine: "member:rama", theirs: "member:sinta" } });
    const bot = { kind: "bot" as const, botId: "atlas" };
    const first = host.add([{ title: "Check the logs", botId: "scout", source: { threadId: "theirs" } }], bot).todos[0]!;
    const other = host.add([{ title: "check the logs", botId: "scout", source: { threadId: "mine" } }], bot);
    expect(other.existing).toEqual([]);
    expect(other.todos).toHaveLength(1);
    expect(other.todos[0]!.id).not.toBe(first.id);
    const same = host.add([{ title: "Check the LOGS", botId: "scout", source: { threadId: "mine" } }], bot);
    expect(same.todos).toEqual([]);
    expect(same.existing.map((todo) => todo.id)).toEqual([other.todos[0]!.id]);
    expect(host.add([{ title: "check the logs", botId: "scout" }], bot).existing).toEqual([]);
  });

  it("refuses a repeating todo from a private chat or a room, and keeps the todo out of the list", () => {
    const { host, store, made } = setup({ audiences: { mine: "member:rama", room: "room:g" } });
    for (const threadId of ["mine", "room"]) {
      expect(() => host.add([{ title: "Digest", botId: "atlas", repeat: { time: "09:00", weekdays: [] }, source: { threadId } }], person)).toThrow("shared place");
    }
    expect(made).toEqual([]);
    expect(store.live()).toEqual([]);
    expect(host.add([{ title: "Digest", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }], person).todos).toHaveLength(1);
    expect(made).toHaveLength(1);
  });
});

describe("security: repeating todos and reach", () => {
  const caller = { botId: "atlas", threadId: "th" };

  it("refuses a repeat from a bot and tells it to use the routine request tool", () => {
    const { host, made, store } = setup();
    expect(() => host.botAdd(caller, [{ title: "Daily", assigneeBotId: "atlas", repeat: { time: "09:00", weekdays: [] } }])).toThrow(/routine request tool/);
    expect(made).toEqual([]);
    expect(store.live()).toEqual([]);
  });

  it("does not let a bot give a repeating todo to another bot or change its text", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Digest", botId: "atlas", repeat: { time: "08:00", weekdays: [] } }], person).todos[0]!;
    expect(() => host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "r" })).toThrow(TodoError);
    expect(() => host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: todo.id, title: "Other" })).toThrow(TodoError);
  });

  it("refuses every bot change to a repeating todo, including done and result", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Digest", botId: "atlas", repeat: { time: "08:00", weekdays: [] } }], person).todos[0]!;
    for (const args of [{ status: "done" }, { status: "queued" }, { result: "x" }, { note: "n" }]) {
      expect(() => host.botUpdate({ botId: "atlas", threadId: "t" }, { todoId: todo.id, ...args })).toThrow("A repeating todo can be changed only by the person.");
    }
  });

  it("keeps the todo when the routine check refuses its removal", () => {
    const routines: TodoRoutines = { create: () => ({ id: "r1" }), remove: () => { throw new TodoError(403, "No."); }, update: () => null };
    const { host, store } = setup({ routines });
    const todo = host.add([{ title: "Digest", botId: "atlas", repeat: { time: "08:00", weekdays: [] } }], person).todos[0]!;
    expect(() => host.remove(todo.id)).toThrow("No.");
    expect(store.get(todo.id)).toBeDefined();
  });

  it("passes a refusal from the routine check on as the plain reason", () => {
    const refusing: TodoRoutines = { create: () => { throw new TodoError(403, "Not allowed here."); }, remove: () => true, update: () => null };
    expect(() => setup({ routines: refusing }).host.add([{ title: "x", botId: "atlas", repeat: { time: "09:00", weekdays: [] } }], person)).toThrow("Not allowed here.");
  });

  it("answers 'no such todo' for a todo the caller may not read, in assign and update", () => {
    const { host } = setup();
    const todo = host.add([{ title: "Secret" }], person).todos[0]!;
    const none = () => false;
    expect(() => host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "r" }, none)).toThrow("No todo has that id.");
    expect(() => host.botUpdate({ botId: "chief", threadId: "t" }, { todoId: todo.id, status: "done" }, none)).toThrow("No todo has that id.");
    expect(host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "r" }, () => true).botId).toBe("scout");
  });
});

describe("security: a person's todo reaches only bots that person may chat with", () => {
  const pat: TodoPerson = { key: "p_pat", viewer: { kind: "member", email: "pat@example.com" } };
  const patLevels = (levels: Record<string, BotAccessLevel>) => (one: TodoPerson | undefined, botId: string): BotAccessLevel =>
    one?.viewer?.email === "pat@example.com" ? levels[botId] ?? "none" : "edit";

  it("records whom the todo works for, and keeps it off the client copy", () => {
    const { host, store } = setup();
    const todo = host.add([{ title: "Plan" }], person, { person: pat }).todos[0]!;
    expect(store.get(todo.id)!.person).toEqual(pat);
    expect(publicTodo(store.get(todo.id)!)).not.toHaveProperty("person");
  });

  it("does not let the picker give the todo to a bot its writer cannot chat with", () => {
    const { host, store } = setup({ levelFor: patLevels({ atlas: "chat", scout: "view", chief: "chat" }) });
    const todo = host.add([{ title: "Read the payroll" }], person, { person: pat }).todos[0]!;
    expect(() => host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "fits" })).toThrow("cannot give work to Scout");
    expect(store.get(todo.id)).toMatchObject({ status: "open" });
    expect(store.get(todo.id)!.botId).toBeUndefined();
    expect(host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "atlas", reason: "fits" }).botId).toBe("atlas");
  });

  it("does not let the bot that has the todo hand it on to such a bot either", () => {
    const { host } = setup({ levelFor: patLevels({ atlas: "chat", scout: "none" }) });
    const todo = host.add([{ title: "Ship it", botId: "atlas" }], person, { person: pat }).todos[0]!;
    expect(() => host.botAssign({ botId: "atlas", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "busy" })).toThrow(TodoError);
  });

  it("does not let someone else on the Board give it to such a bot", () => {
    const { host, store } = setup({ levelFor: patLevels({ atlas: "chat", scout: "view" }) });
    const todo = host.add([{ title: "Ship it", botId: "atlas" }], person, { person: pat }).todos[0]!;
    expect(() => host.patch(todo.id, { botId: "scout" }, { kind: "person", name: "Admin" })).toThrow("cannot give work to this bot");
    expect(store.get(todo.id)!.botId).toBe("atlas");
    expect(() => host.add([{ title: "Direct", botId: "scout" }], person, { person: pat })).toThrow("You cannot give work to this bot.");
  });

  it("treats a todo with nobody recorded as nobody's", () => {
    const seen: Array<TodoPerson | undefined> = [];
    const { host, store } = setup({ levelFor: (one) => { seen.push(one); return one ? "chat" : "none"; } });
    store.insert({ id: "old", title: "Old", status: "open", start: { kind: "free" }, rank: 1, madeBy: person, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1 });
    expect(() => host.botAssign({ botId: "chief", threadId: "t" }, { todoId: "old", assigneeBotId: "atlas", reason: "r" })).toThrow(TodoError);
    expect(seen).toEqual([undefined]);
  });

  it("leaves a todo a bot made to the bot's own reach", () => {
    const { host } = setup({ levelFor: () => "none" });
    const todo = host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Follow up" }], { key: "p_pat" }).todos[0]!;
    expect(todo.person).toEqual({ key: "p_pat" });
    expect(host.botAssign({ botId: "atlas", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "r" }).botId).toBe("scout");
  });
});

describe("security: a todo of a personal Seira keeps its person's reach at every step", () => {
  const owner: TodoPerson = { key: "p_mira", viewer: { kind: "member", email: "mira@acme.test" } };
  const levels = (botId: string): BotAccessLevel => (botId === "scout" ? "view" : "chat");
  const world = () => setup({ levelFor: (who, botId) => (who?.viewer?.email ? levels(botId) : "chat") });

  it("refuses the bot it is first given to when its person may not chat with it", () => {
    const { host, store } = world();
    expect(() => host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Read payroll", assigneeBotId: "scout" }], owner)).toThrow(TodoError);
    expect(store.live()).toHaveLength(0);
  });

  it("refuses a later hand-over by a team bot to a bot its person may not chat with, and keeps the todo where it is", () => {
    const { host, store } = world();
    const todo = host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Follow up", assigneeBotId: "chief" }], owner).todos[0]!;
    expect(() => host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "fits" })).toThrow("cannot give work to Scout");
    expect(store.get(todo.id)!.botId).toBe("chief");
  });

  it("refuses the same final bot from the Board, the picker and a start", () => {
    const { host, store } = world();
    const todo = host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Follow up", assigneeBotId: "chief" }], owner).todos[0]!;
    expect(() => host.patch(todo.id, { botId: "scout" }, person)).toThrow(TodoError);
    expect(host.personMayGive(store.get(todo.id)!, "scout")).toBe(false);
    expect(host.personMayGive(store.get(todo.id)!, "atlas")).toBe(true);
  });

  it("leaves a bot-made todo with no recorded owner to the bots' own reach rules", () => {
    const { host } = world();
    const todo = host.botAdd({ botId: "atlas", threadId: "t" }, [{ title: "Follow up", assigneeBotId: "chief" }], { key: "p_pat" }).todos[0]!;
    expect(host.botAssign({ botId: "chief", threadId: "t" }, { todoId: todo.id, assigneeBotId: "scout", reason: "fits" }).botId).toBe("scout");
  });
});
