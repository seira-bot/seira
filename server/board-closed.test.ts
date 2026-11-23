import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_CLOSE_REASON_CHARS, BOARD_DONE_WINDOW_MS } from "../shared/board.ts";
import { createBoardClosures } from "./board-closed.ts";

const NOW = 1_800_000_000_000;
let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "board-closed-"));
  clock = NOW;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = () => createBoardClosures({ dataDir: dir, now: () => clock });

describe("board closures", () => {
  it("keeps who closed a card, when and why, and reads it back after a restart", () => {
    open().close("handoff:a", { kind: "person", name: "Rama" }, "Fixed by hand");
    open().close("thread:b", { kind: "bot", botId: "scout" });
    const again = open();
    expect(again.get("handoff:a")).toEqual({ at: NOW, by: { kind: "person", name: "Rama" }, reason: "Fixed by hand" });
    expect(again.get("thread:b")).toEqual({ at: NOW, by: { kind: "bot", botId: "scout" } });
    expect(again.get("thread:none")).toBeUndefined();
  });

  it("keeps the reason on one line, at most BOARD_CLOSE_REASON_CHARS long, and drops a blank one", () => {
    const closures = open();
    closures.close("a", { kind: "person", name: "Rama" }, `  one\n two ${"x".repeat(500)}`);
    closures.close("b", { kind: "person", name: "Rama" }, "   ");
    expect(closures.get("a")!.reason).toHaveLength(BOARD_CLOSE_REASON_CHARS);
    expect(closures.get("a")!.reason!.startsWith("one two ")).toBe(true);
    expect(closures.get("b")).not.toHaveProperty("reason");
  });

  it("drops what is older than the Done window when it writes", () => {
    open().close("old", { kind: "person", name: "Rama" });
    clock = NOW + BOARD_DONE_WINDOW_MS + 1;
    const closures = open();
    closures.close("new", { kind: "person", name: "Rama" });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "board-closed.json"), "utf8")))).toEqual(["new"]);
  });

  it("keeps at most 1000 entries, newest last", () => {
    const closures = open();
    for (let i = 0; i < 1005; i++) closures.close(`card:${i}`, { kind: "person", name: "Rama" });
    expect(closures.get("card:0")).toBeUndefined();
    expect(closures.get("card:1004")).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "board-closed.json"), "utf8")))).toHaveLength(1000);
  });

  it("starts empty when the file is damaged, and skips a damaged entry", () => {
    writeFileSync(join(dir, "board-closed.json"), "{not json");
    expect(open().get("a")).toBeUndefined();
    writeFileSync(join(dir, "board-closed.json"), JSON.stringify({ bad: { at: "x", by: {} }, ok: { at: NOW, by: { kind: "bot", botId: "s" } } }));
    const closures = open();
    expect(closures.get("bad")).toBeUndefined();
    expect(closures.get("ok")).toMatchObject({ at: NOW });
  });
});
