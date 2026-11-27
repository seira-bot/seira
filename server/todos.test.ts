import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TODO_DONE_WINDOW_MS, TODO_UNDO_MS, type Todo } from "../shared/todo.ts";
import { effectivePicker, publicTodo, readyQueue, startIsReady, TodoStore, todoVisible, type TodoRecord } from "./todos.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function open(clock = { now: 1_800_000_000_000 }, dir = mkdtempSync(join(tmpdir(), "todos-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  let n = 0;
  return { dir, clock, store: new TodoStore({ dataDir: dir, now: () => clock.now, newId: () => `t${++n}` }) };
}

function todo(over: Partial<TodoRecord> = {}): TodoRecord {
  return { id: "x", title: "Do it", status: "queued", start: { kind: "free" }, rank: 1, madeBy: { kind: "person", name: "Rama" }, attempts: 0, depth: 0, createdAt: 1, updatedAt: 1, ...over };
}

describe("TodoStore", () => {
  it("keeps todos in todos.json with mode 0600 and reads them back (AC-01)", () => {
    const { store, dir, clock } = open();
    store.insert(todo({ id: "a", title: "Write notes", botId: "atlas", note: "short", source: { threadId: "th", quote: "q" } }));
    expect((statSync(join(dir, "todos.json")).mode & 0o777).toString(8)).toBe("600");
    const again = open(clock, dir).store.get("a")!;
    expect(again).toMatchObject({ title: "Write notes", botId: "atlas", note: "short", start: { kind: "free" }, madeBy: { kind: "person", name: "Rama" }, source: { threadId: "th", quote: "q" } });
  });

  it("puts a todo last in its bot's queue and a todo before another at the midpoint", () => {
    const { store } = open();
    expect(store.endRank("atlas")).toBe(1);
    store.insert(todo({ id: "a", botId: "atlas", rank: 1 }));
    store.insert(todo({ id: "b", botId: "atlas", rank: 2 }));
    store.insert(todo({ id: "c", botId: "other", rank: 7 }));
    expect(store.endRank("atlas")).toBe(3);
    expect(store.rankBefore("atlas", "b", "z")).toBe(1.5);
    expect(store.rankBefore("atlas", "a", "z")).toBe(0);
    expect(store.rankBefore("atlas", "c", "z")).toBeUndefined();
    expect(store.frontRank("atlas")).toBe(0);
  });

  it("claims a queued todo once: compare-and-set from queued to working (AC-06)", () => {
    const { store, clock } = open();
    store.insert(todo({ id: "a", botId: "atlas" }));
    const first = store.claim("a");
    expect(first).toMatchObject({ status: "working", attempts: 1, startedAt: clock.now });
    expect(store.claim("a")).toBeUndefined();
    expect(store.get("a")!.attempts).toBe(1);
  });

  it("deletes softly, restores within the undo window and then forgets it", () => {
    const { store, clock } = open();
    store.insert(todo({ id: "a" }));
    store.remove("a");
    expect(store.get("a")).toBeUndefined();
    expect(store.live()).toEqual([]);
    expect(store.restore("a")?.id).toBe("a");
    store.remove("a");
    clock.now += TODO_UNDO_MS + 1;
    expect(store.restore("a")).toBeUndefined();
    store.live();
    expect(store.everything()).toEqual([]);
  });

  it("prunes done todos after the done window", () => {
    const { store, clock } = open();
    store.insert(todo({ id: "a", status: "done", finishedAt: clock.now }));
    store.insert(todo({ id: "b", status: "done", finishedAt: clock.now - TODO_DONE_WINDOW_MS - 1 }));
    expect(store.live().map((one) => one.id)).toEqual(["a"]);
  });

  it("keeps the picker choice and the picker conversations", () => {
    const { store, dir, clock } = open();
    expect(store.chosenPicker()).toBeUndefined();
    store.setPicker(null);
    store.setPickerThread("atlas", "th1");
    const again = open(clock, dir).store;
    expect(again.chosenPicker()).toBeNull();
    expect(again.pickerThread("atlas")).toBe("th1");
  });

  it("tells listeners about a change but not about a lease touch", () => {
    const { store } = open();
    let calls = 0;
    store.onChange(() => { calls += 1; });
    store.insert(todo({ id: "a", status: "working" }));
    store.touch("a", 5);
    expect(calls).toBe(1);
    expect(store.get("a")!.leaseAt).toBe(5);
  });

  it("does not show internal fields to a client", () => {
    const shown = publicTodo(todo({ offeredIn: "th", offeredAt: 1, leaseAt: 2, deletedAt: 3 }));
    expect(Object.keys(shown)).not.toEqual(expect.arrayContaining(["offeredIn"]));
    expect(shown).not.toHaveProperty("leaseAt");
    expect(shown).not.toHaveProperty("deletedAt");
  });
});

describe("effectivePicker", () => {
  const bots = [{ id: "a" }, { id: "chief", chiefOfStaff: true }, { id: "hid", chiefOfStaff: true, hidden: true }];
  it("defaults to the visible Chief of Staff", () => expect(effectivePicker(undefined, bots)).toBe("chief"));
  it("is nobody when the person chose nobody", () => expect(effectivePicker(null, bots)).toBeNull());
  it("is nobody when the chosen bot is gone", () => expect(effectivePicker("gone", bots)).toBeNull());
  it("is nobody without a Chief of Staff", () => expect(effectivePicker(undefined, [{ id: "a" }])).toBeNull());
  it("is the chosen bot", () => expect(effectivePicker("a", bots)).toBe("a"));
});

describe("start rules", () => {
  const NOW = 1000;
  const list: Todo[] = [
    todo({ id: "first", botId: "a", rank: 1, start: { kind: "after", todoId: "dep" } }),
    todo({ id: "dep", botId: "b", rank: 1, status: "working" }),
    todo({ id: "timed", botId: "a", rank: 2, start: { kind: "at", at: NOW + 5 } }),
    todo({ id: "free", botId: "a", rank: 3 }),
    todo({ id: "gone", botId: "a", rank: 4, start: { kind: "after", todoId: "missing" } }),
    todo({ id: "routine", botId: "a", rank: 0, routineId: "r" }),
  ];
  it("waits for a time and for an unfinished todo; a missing todo no longer blocks (AC-10)", () => {
    expect(readyQueue(list, "a", NOW).map((one) => one.id)).toEqual(["free", "gone"]);
    expect(readyQueue(list, "a", NOW + 5).map((one) => one.id)).toEqual(["timed", "free", "gone"]);
    const done = list.map((one) => (one.id === "dep" ? { ...one, status: "done" as const } : one));
    expect(readyQueue(done, "a", NOW).map((one) => one.id)).toEqual(["first", "free", "gone"]);
  });
  it("never starts a repeating todo through the queue", () => expect(readyQueue(list, "a", NOW).some((one) => one.id === "routine")).toBe(false));
  it("startIsReady follows the start rule", () => expect(startIsReady({ start: { kind: "free" } }, () => undefined, 0)).toBe(true));
});

describe("todoVisible (AC-14)", () => {
  const viewer = { bot: (id: string) => id !== "hidden", thread: (id: string) => id !== "secret" };
  it("needs the bot and the source conversation to be seen", () => {
    expect(todoVisible({ botId: "atlas" }, viewer)).toBe(true);
    expect(todoVisible({}, viewer)).toBe(true);
    expect(todoVisible({ botId: "hidden" }, viewer)).toBe(false);
    expect(todoVisible({ botId: "atlas", source: { threadId: "secret" } }, viewer)).toBe(false);
  });
});
