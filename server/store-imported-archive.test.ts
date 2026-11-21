import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb, searchMessages } from "./message-db.ts";
import { Store, toWireTask } from "./store.ts";
import { appendImportedMessages, createImportedThreads, importedMark, importedThreadStats, removeImportedMessages, type ImportedMessageInput, type ImportedThreadInput } from "./store-imported.ts";

const appendOne = (store: Store, threadId: string, messages: ImportedMessageInput[], activeLeafId: string | null) =>
  appendImportedMessages(store, [{ threadId, messages, activeLeafId }]);

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const mark = { kind: "chatgpt", label: "ChatGPT export" } as const;

const input = (threadId: string, title = "Old chat"): ImportedThreadInput =>
  ({ threadId, title, createdAt: 1_000, updatedAt: 2_000, imported: mark });
const line = (id: string, parentId: string | null, at: number, text = `${id} text`): ImportedMessageInput =>
  ({ id, parentId, role: id.startsWith("u") ? "user" : "bot", text, at });

function setup() {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  return { store, bot };
}

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("imported archive", () => {
  it("creates archived imported threads with a label", () => {
    const { store, bot } = setup();
    const activeBefore = store.bot(bot.id)!.threadId;
    const made = createImportedThreads(store, bot.id, [input("imp-a"), input("imp-b", "Second")])!;
    expect(made.map((task) => task.threadId)).toEqual(["imp-a", "imp-b"]);
    for (const task of made) {
      expect(task.archivedAt).toBeTypeOf("number");
      expect(task.imported).toEqual(mark);
      expect(task.createdAt).toBe(1_000);
      expect(task.updatedAt).toBe(2_000);
    }
    expect(store.bot(bot.id)!.threadId).toBe(activeBefore);
    expect(importedMark(store, bot.id, "imp-a")).toEqual(mark);
    expect(importedMark(store, bot.id, activeBefore)).toBeUndefined();
    const wire = toWireTask(made[0]!, selection());
    expect(wire).not.toHaveProperty("imported");
    expect(createImportedThreads(store, "no-such-bot", [input("imp-x")])).toBeNull();
  });

  it("is idempotent by thread id", () => {
    const { store, bot } = setup();
    const [first] = createImportedThreads(store, bot.id, [input("imp-a")])!;
    const before = store.bot(bot.id)!.tasks!.length;
    const [again] = createImportedThreads(store, bot.id, [{ ...input("imp-a", "Changed"), updatedAt: 9_000 }])!;
    expect(again).toBe(first);
    expect(again!.title).toBe("Old chat");
    expect(store.bot(bot.id)!.tasks!.length).toBe(before);
  });

  it("appends a batch in one transaction", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a")]);
    const rows = [line("u1", null, 10), line("b1", "u1", 11)];
    expect(appendOne(store, "imp-a", rows, "b1")).toBe(2);
    expect(appendOne(store, "imp-a", rows, "b1")).toBe(0);
    expect(importedThreadStats("imp-a")).toEqual({ messages: 2, activeLeafId: "b1" });
    expect(store.activePath("imp-a").map((m) => m.id)).toEqual(["u1", "b1"]);
    expect(store.activePath("imp-a")[0]).toMatchObject({ kind: "text", role: "user", text: "u1 text", at: 10 });

    const broken = [line("u2", null, 20), { ...line("b2", "u2", 21), at: Number.NaN }];
    expect(() => appendOne(store, "imp-a", broken, "b2")).toThrow();
    expect(importedThreadStats("imp-a")).toEqual({ messages: 2, activeLeafId: "b1" });
  });

  it("writes several threads in one transaction", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a"), input("imp-b")]);
    const added = appendImportedMessages(store, [
      { threadId: "imp-a", messages: [line("u1", null, 10), line("b1", "u1", 11)], activeLeafId: "b1" },
      { threadId: "imp-b", messages: [line("u1", null, 30)], activeLeafId: "u1" },
    ]);
    expect(added).toBe(3);
    expect(importedThreadStats("imp-a")).toEqual({ messages: 2, activeLeafId: "b1" });
    expect(importedThreadStats("imp-b")).toEqual({ messages: 1, activeLeafId: "u1" });
    expect(store.bot(bot.id)!.tasks!.find((task) => task.threadId === "imp-b")!.updatedAt).toBe(2_000);

    const failing = [
      { threadId: "imp-a", messages: [line("u9", null, 40)], activeLeafId: "u9" },
      { threadId: "imp-b", messages: [{ ...line("u8", null, 41), at: Number.NaN }], activeLeafId: "u8" },
    ];
    expect(() => appendImportedMessages(store, failing)).toThrow();
    expect(importedThreadStats("imp-a")).toEqual({ messages: 2, activeLeafId: "b1" });
    expect(importedThreadStats("imp-b")).toEqual({ messages: 1, activeLeafId: "u1" });
  });

  it("keeps inactive branches out of the timeline", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a")]);
    appendOne(store, "imp-a", [
      line("u1", null, 10), line("b1", "u1", 11), line("b2", "u1", 12), line("u2", "b2", 13),
    ], "b1");
    expect(store.activePath("imp-a").map((m) => m.id)).toEqual(["u1", "b1"]);
    expect(importedThreadStats("imp-a")).toEqual({ messages: 4, activeLeafId: "b1" });
  });

  it("removes imported messages and restores the leaf", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a")]);
    appendOne(store, "imp-a", [line("u1", null, 10, "keepword alpha"), line("b1", "u1", 11, "removeword beta")], "b1");
    expect(removeImportedMessages(store, "imp-a", ["b1", "missing"], "u1")).toBe(1);
    expect(importedThreadStats("imp-a")).toEqual({ messages: 1, activeLeafId: "u1" });
    expect(store.activePath("imp-a").map((m) => m.id)).toEqual(["u1"]);
    expect(searchMessages("removeword", 10, "imp-a")).toEqual([]);
    expect(searchMessages("keepword", 10, "imp-a")).toHaveLength(1);
    expect(removeImportedMessages(store, "imp-a", ["u1"], null)).toBe(1);
    expect(importedThreadStats("imp-a")).toEqual({ messages: 0, activeLeafId: null });
    expect(importedThreadStats("imp-none")).toBeNull();
  });

  it("imported text is searchable", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a")]);
    appendOne(store, "imp-a", [line("u1", null, 10, "the quartzfish migration plan")], "u1");
    const hits = searchMessages("quartzfish");
    expect(hits.map((hit) => [hit.threadId, hit.messageId])).toEqual([["imp-a", "u1"]]);
  });

  it("keeps the mark after reload", () => {
    const { store, bot } = setup();
    createImportedThreads(store, bot.id, [input("imp-a")]);
    const reloaded = new Store(selection);
    expect(importedMark(reloaded, bot.id, "imp-a")).toEqual(mark);
    expect(reloaded.taskByThread(bot.id, "imp-a")!.archivedAt).toBeTypeOf("number");
  });
});
