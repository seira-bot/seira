import { describe, expect, it } from "vitest";

import { ADMIT, createFrameBudget, createSendPace, limitLog } from "./linked-servers-admit.ts";

const W = ADMIT.windowMs;
const sizeOf = (frame: unknown) => Buffer.byteLength(JSON.stringify(frame));
const result = (id: string, length: number) => ({ frame: { t: "result", id, ok: true, text: "x".repeat(length) } });
const done = (id: string) => ({ frame: { t: "done", id } });
const hello = { frame: { t: "hello", place: { id: "p", name: "Far" }, bots: [] } };

describe("a frame budget", () => {
  it("says how long until a number fits: at once, when enough of what was spent leaves the window, or a whole window", () => {
    let now = 0;
    const budget = createFrameBudget(() => now, 10);
    budget.spend("a", 4);
    now = 10_000;
    budget.spend("a", 4);
    now = 20_000;
    expect([budget.left("a"), budget.waitFor("a", 2), budget.waitFor("a", 5), budget.waitFor("a", 9), budget.waitFor("a", 11)]).toEqual([2, 0, W - 20_000, W - 10_000, W]);
    expect(budget.waitFor("b", 10)).toBe(0);
  });

  it("gives back part of what was spent, from the newest spending first, and never more than was spent", () => {
    let now = 0;
    const budget = createFrameBudget(() => now, 10);
    budget.spend("a", 4);
    now = 10_000;
    budget.spend("a", 3);
    budget.giveBack("a", 5);
    expect(budget.left("a")).toBe(8);
    now = W;
    expect(budget.left("a")).toBe(10);
    budget.spend("a", 6);
    budget.giveBack("a", 100);
    expect(budget.left("a")).toBe(10);
    budget.giveBack("b", 3);
    expect(budget.left("b")).toBe(10);
  });
});

describe("the pace of what a side sends a link", () => {
  it("sends the start of what waits: the frames before the first work frame past its bytes for the window, and waits until that frame fits", () => {
    let now = 0;
    const pace = createSendPace(() => now, { bytes: 1_000 });
    const frames = [done("d1"), result("r1", 450), hello, result("r2", 450), done("d2")];
    const first = pace.next("a", frames);
    expect(first.count).toBe(3);
    pace.sent("a", frames.slice(0, first.count));
    const spent = sizeOf(frames[0]!.frame) + sizeOf(frames[1]!.frame) + sizeOf(frames[2]!.frame);
    expect(1_000 - spent).toBeLessThan(sizeOf(frames[3]!.frame));
    now = 1_000;
    expect(pace.next("a", frames.slice(3))).toEqual({ count: 0, waitMs: W - 1_000 });
    expect(pace.next("a", [done("d3"), ...frames.slice(3)])).toEqual({ count: 1, waitMs: W - 1_000 });
    now = W;
    expect(pace.next("a", frames.slice(3))).toEqual({ count: 2, waitMs: 0 });
    expect(pace.next("b", frames.slice(0, 3))).toEqual({ count: 3, waitMs: 0 });
  });

  it("sends one work frame larger than its bytes alone, in an empty window only", () => {
    let now = 0;
    const pace = createSendPace(() => now, { bytes: 100 });
    const large = result("r1", 500);
    expect(pace.next("a", [large, done("d1"), result("r2", 10)])).toEqual({ count: 2, waitMs: expect.any(Number) });
    pace.sent("a", [large, done("d1")]);
    now = 1_000;
    expect(pace.next("a", [result("r2", 500)])).toEqual({ count: 0, waitMs: W - 1_000 });
    now = W;
    expect(pace.next("a", [result("r2", 500)]).count).toBe(1);
  });

  it("holds back work frames for a pause that doubles up to its limit while the other side takes none, and sends the others", () => {
    let now = 0;
    const pace = createSendPace(() => now, { bytes: 1_000_000, pauseMs: 5_000, pauseMax: 10_000 });
    const frames = [done("d1"), result("r1", 10)];
    pace.took("a", 0, 0);
    expect(pace.next("a", frames)).toEqual({ count: 2, waitMs: 0 });
    pace.took("a", 2, 0);
    expect(pace.next("a", frames)).toEqual({ count: 1, waitMs: 5_000 });
    now = 5_000;
    expect(pace.next("a", frames).count).toBe(2);
    const pauses: number[] = [];
    for (const at of [5_000, 15_000, 25_000]) {
      now = at;
      pace.took("a", 1, 0);
      pauses.push(pace.next("a", frames).waitMs);
    }
    expect(pauses).toEqual([10_000, 10_000, 10_000]);
    pace.took("a", 3, 1);
    expect(pace.next("a", frames)).toEqual({ count: 2, waitMs: 0 });
    pace.took("a", 1, 0);
    expect(pace.next("a", frames).waitMs).toBe(5_000);
    pace.forget("a");
    expect(pace.next("a", frames)).toEqual({ count: 2, waitMs: 0 });
  });
});

describe("a link's log", () => {
  it("passes twenty lines a minute, then one line that says the rest were dropped, and passes again in the next minute", () => {
    let now = 0;
    const lines: string[] = [];
    const log = limitLog((line) => { lines.push(line); }, () => now);
    for (let index = 0; index < 50; index++) log(`line ${index}`);
    expect(lines).toEqual([...Array.from({ length: 20 }, (_, index) => `line ${index}`), "linked servers: a link wrote more than 20 lines in a minute; the rest were dropped"]);
    now = W / 2;
    log("late");
    expect(lines).toHaveLength(21);
    now = W;
    for (let index = 0; index < 22; index++) log(`next ${index}`);
    expect(lines.slice(21)).toEqual([...Array.from({ length: 20 }, (_, index) => `next ${index}`), "linked servers: a link wrote more than 20 lines in a minute; the rest were dropped"]);
  });
});
