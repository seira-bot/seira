import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CONTEXTS_MAX, type TaskState } from "./protocol.ts";
import { CONTEXT_ENTRIES_MAX, RETENTION_MS, TASKS_MAX, createTaskIndex, frameId, threadKey, type TaskEntry } from "./tasks.ts";

const DAY = 24 * 60 * 60_000;

function fixture(start = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "seira-a2a-tasks-"));
  const clock = { now: start };
  const log = vi.fn();
  const open = () => createTaskIndex(dir, () => clock.now, log);
  return { dir, clock, log, open, file: join(dir, "a2a-tasks.json") };
}

const entry = (id: string, over: Partial<TaskEntry> = {}): TaskEntry => ({
  id, dir: "in", bot: "bot-1", context: `ctx-${id}`, thread: "t".repeat(32), state: "TASK_STATE_WORKING", at: 1_000_000, ...over,
});

describe("key derivation", () => {
  it("gives 32 lowercase hex characters", () => {
    expect(threadKey("bot-1", "ctx")).toMatch(/^[0-9a-f]{32}$/u);
    expect(frameId("peer", "msg")).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("is stable and depends on every part", () => {
    expect(threadKey("bot-1", "ctx")).toBe(threadKey("bot-1", "ctx"));
    expect(threadKey("bot-1", "ctx")).not.toBe(threadKey("bot-2", "ctx"));
    expect(threadKey("bot-1", "ctx")).not.toBe(threadKey("bot-1", "ctx2"));
    expect(frameId("peer-a", "msg")).toBe(frameId("peer-a", "msg"));
    expect(frameId("peer-a", "msg")).not.toBe(frameId("peer-b", "msg"));
    expect(frameId("peer-a", "msg")).not.toBe(frameId("peer-a", "msg2"));
  });

  it("does not let two part lists with the same joined text collide", () => {
    expect(threadKey("ab", "c")).not.toBe(threadKey("a", "bc"));
    expect(frameId("ab", "c")).not.toBe(frameId("a", "bc"));
  });

  it("is the first 32 hex characters of the sha256 of the parts joined by a zero byte", () => {
    const expected = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    expect(threadKey("bot-1", "ctx")).toBe(expected("bot-1", "ctx"));
    expect(frameId("peer", "msg")).toBe(expected("peer", "msg"));
  });
});

describe("tasks", () => {
  it("stores, replaces and reads a task by id", () => {
    const { open } = fixture();
    const index = open();
    expect(index.get("a")).toBeNull();
    index.put(entry("a"));
    index.put(entry("a", { state: "TASK_STATE_COMPLETED", at: 2_000_000 }));
    expect(index.get("a")).toMatchObject({ state: "TASK_STATE_COMPLETED", at: 2_000_000 });
  });

  it("cuts a note to its limit and refuses an invalid entry", () => {
    const { open } = fixture();
    const index = open();
    index.put(entry("a", { note: "n".repeat(5_000) }));
    expect(index.get("a")?.note).toHaveLength(2_000);
    expect(() => index.put(entry("", {}))).toThrow();
    expect(() => index.put(entry("b", { state: "bogus" as TaskState }))).toThrow();
    expect(() => index.put(entry("c", { context: "c".repeat(257) }))).toThrow();
  });

  it("reads the file back after a restart", () => {
    const { open } = fixture();
    const first = open();
    first.put(entry("a", { farTask: "far-1" }));
    first.setContext("thread-1", "far-ctx", "input-1");
    const second = open();
    expect(second.get("a")).toMatchObject({ farTask: "far-1", dir: "in" });
    expect(second.outOf("thread-1")).toEqual({ far: "far-ctx", inputTask: "input-1" });
  });

  it("writes the file with mode 600 and no result text", () => {
    const { open, file } = fixture();
    open().put(entry("a"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["v", "tasks", "contexts"]);
  });
});

describe("contexts of inbound work", () => {
  it("counts distinct inbound contexts, not tasks and not outbound work", () => {
    const { open } = fixture();
    const index = open();
    index.put(entry("a", { context: "c1" }));
    index.put(entry("b", { context: "c1" }));
    index.put(entry("c", { context: "c2" }));
    index.put(entry("d", { dir: "out", context: "c3" }));
    expect(index.contextCount()).toBe(2);
    expect(index.hasContext("c1")).toBe(true);
    expect(index.hasContext("c3")).toBe(false);
  });

  it("lets a caller enforce the cap of 50 new contexts", () => {
    const { open } = fixture();
    const index = open();
    const admit = (context: string, id: string): boolean => {
      if (!index.hasContext(context) && index.contextCount() >= CONTEXTS_MAX) return false;
      index.put(entry(id, { context }));
      return true;
    };
    for (let n = 0; n < CONTEXTS_MAX; n += 1) expect(admit(`c${n}`, `t${n}`)).toBe(true);
    expect(index.contextCount()).toBe(50);
    expect(admit("c-new", "t-new")).toBe(false);
    expect(admit("c0", "t-again")).toBe(true);
  });
});

describe("far context of outbound work", () => {
  it("stores one far context per thread and replaces it", () => {
    const { open } = fixture();
    const index = open();
    expect(index.outOf("th")).toBeNull();
    index.setContext("th", "far-1");
    expect(index.outOf("th")).toEqual({ far: "far-1" });
    index.setContext("th", "far-2", "task-9");
    expect(index.outOf("th")).toEqual({ far: "far-2", inputTask: "task-9" });
    index.setContext("th", "far-3");
    expect(index.outOf("th")).toEqual({ far: "far-3" });
    expect(index.outOf("other")).toBeNull();
  });

  it("refuses a far id over its limit", () => {
    const { open } = fixture();
    expect(() => open().setContext("th", "f".repeat(257))).toThrow();
  });
});

describe("pruning", () => {
  it("drops ended tasks after 7 days and keeps open ones", () => {
    const { open, clock } = fixture(10 * DAY);
    const index = open();
    index.put(entry("done-old", { state: "TASK_STATE_COMPLETED", at: clock.now }));
    index.put(entry("failed-old", { state: "TASK_STATE_FAILED", at: clock.now }));
    index.put(entry("open-old", { state: "TASK_STATE_WORKING", at: clock.now }));
    index.put(entry("done-new", { state: "TASK_STATE_COMPLETED", at: clock.now + 6 * DAY }));
    clock.now += RETENTION_MS - 1;
    expect(index.prune()).toBe(0);
    clock.now += 2;
    expect(index.prune()).toBe(2);
    expect(index.get("done-old")).toBeNull();
    expect(index.get("failed-old")).toBeNull();
    expect(index.get("open-old")).not.toBeNull();
    expect(index.get("done-new")).not.toBeNull();
  });

  it("saves a prune, so a restart does not bring the tasks back", () => {
    const { open, clock } = fixture(10 * DAY);
    const index = open();
    index.put(entry("a", { state: "TASK_STATE_CANCELED", at: clock.now }));
    clock.now += 8 * DAY;
    index.prune();
    expect(open().get("a")).toBeNull();
  });

  it("prunes on put and on load", () => {
    const { open, clock } = fixture(10 * DAY);
    const index = open();
    index.put(entry("old", { state: "TASK_STATE_REJECTED", at: clock.now }));
    clock.now += 8 * DAY;
    index.put(entry("fresh", { at: clock.now }));
    expect(index.get("old")).toBeNull();
    expect(open().get("fresh")).not.toBeNull();
  });

  it("drops old far contexts", () => {
    const { open, clock } = fixture(10 * DAY);
    const index = open();
    index.setContext("old", "far");
    clock.now += 8 * DAY;
    index.setContext("new", "far");
    expect(index.outOf("old")).toBeNull();
    expect(index.outOf("new")).not.toBeNull();
    const again = fixture(10 * DAY);
    const stored = again.open();
    stored.setContext("old", "far");
    again.clock.now += 8 * DAY;
    expect(stored.prune()).toBe(0);
    expect(again.open().outOf("old")).toBeNull();
  });

  it("holds at most 1,000 tasks and drops the oldest ended tasks first", () => {
    const { open, clock } = fixture();
    const index = open();
    for (let n = 0; n < TASKS_MAX; n += 1) {
      index.put(entry(`t${n}`, { state: n < 10 ? "TASK_STATE_WORKING" : "TASK_STATE_COMPLETED", at: clock.now + n }));
    }
    index.put(entry("extra", { state: "TASK_STATE_COMPLETED", at: clock.now + TASKS_MAX }));
    expect(index.get("extra")).not.toBeNull();
    expect(index.get("t0")).not.toBeNull();
    expect(index.get("t10")).toBeNull();
    expect(index.get("t11")).not.toBeNull();
  });

  it("drops the oldest open task when every task is open", () => {
    const { open, clock } = fixture();
    const index = open();
    for (let n = 0; n <= TASKS_MAX; n += 1) index.put(entry(`t${n}`, { at: clock.now + n }));
    expect(index.get("t0")).toBeNull();
    expect(index.get(`t${TASKS_MAX}`)).not.toBeNull();
    expect(open().get("t1")).not.toBeNull();
  });

  it("caps the far contexts", () => {
    const { open, clock } = fixture();
    const index = open();
    for (let n = 0; n <= CONTEXT_ENTRIES_MAX; n += 1) {
      clock.now += 1;
      index.setContext(`th${n}`, "far");
    }
    expect(index.outOf("th0")).toBeNull();
    expect(index.outOf(`th${CONTEXT_ENTRIES_MAX}`)).not.toBeNull();
  });
});

describe("a broken file", () => {
  it("starts empty with one log line and replaces the file on the next save", () => {
    const { open, file, log } = fixture();
    writeFileSync(file, "{ not json");
    const index = open();
    expect(index.get("a")).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    index.put(entry("a"));
    expect(JSON.parse(readFileSync(file, "utf8")).tasks).toHaveLength(1);
    expect(open().get("a")).not.toBeNull();
  });

  it("treats a wrong version or a wrong shape as broken", () => {
    const { open, file, log } = fixture();
    for (const text of [JSON.stringify({ v: 2, tasks: [], contexts: {} }), JSON.stringify({ tasks: [] }), "[]", "null"]) {
      writeFileSync(file, text);
      expect(open().get("a")).toBeNull();
    }
    expect(log).toHaveBeenCalledTimes(4);
  });

  it("keeps the valid tasks of a file that holds an invalid one", () => {
    const { open, file, log } = fixture();
    writeFileSync(file, JSON.stringify({ v: 1, tasks: [entry("good"), { id: "bad" }, entry("worse", { state: "TASK_STATE_NEW" as TaskState })],
      contexts: { ok: { far: "f", at: 1 }, bad: { far: 5 } } }));
    const index = open();
    expect(index.get("good")).not.toBeNull();
    expect(index.get("bad")).toBeNull();
    expect(index.get("worse")).toBeNull();
    expect(index.outOf("ok")).toEqual({ far: "f" });
    expect(index.outOf("bad")).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("starts empty when the file does not exist and creates the folder on save", () => {
    const base = mkdtempSync(join(tmpdir(), "seira-a2a-tasks-"));
    const dir = join(base, "peer", "nested");
    const index = createTaskIndex(dir, () => 1);
    expect(index.get("a")).toBeNull();
    index.put(entry("a", { at: 1 }));
    expect(statSync(join(dir, "a2a-tasks.json")).isFile()).toBe(true);
  });

  it("keeps working in memory and logs when the save fails", () => {
    const { dir, log } = fixture();
    const blocked = join(dir, "file");
    writeFileSync(blocked, "x");
    const index = createTaskIndex(join(blocked, "inside"), () => 1, log);
    index.put(entry("a", { at: 1 }));
    expect(index.get("a")).not.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not be saved"));
  });
});
