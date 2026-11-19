import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_OPEN_SIZE,
  TRANSCRIPT_STEP_SIZE,
  TRANSCRIPT_WINDOW_SIZE,
  expandWindowStart,
  focusWindowRange,
  followWindowStart,
  resolveTranscriptWindow,
  tailWindowStart,
  withRestingCard,
} from "./transcript-window";

const thread = (total: number): number[] => Array.from({ length: total }, (_, i) => i);

describe("tailWindowStart", () => {
  it("shows everything when the thread is shorter than the window", () => {
    expect(tailWindowStart(10)).toBe(0);
  });

  it("shows everything when the thread is exactly one window", () => {
    expect(tailWindowStart(TRANSCRIPT_OPEN_SIZE)).toBe(0);
  });

  it("starts one opening window back from the tail of a long thread", () => {
    expect(tailWindowStart(300)).toBe(300 - TRANSCRIPT_OPEN_SIZE);
    expect(tailWindowStart(2_000)).toBe(2_000 - TRANSCRIPT_OPEN_SIZE);
  });

  it("is zero for an empty thread", () => {
    expect(tailWindowStart(0)).toBe(0);
  });
});

describe("followWindowStart", () => {
  const tail = 300 - TRANSCRIPT_OPEN_SIZE;
  const turn = (asked: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ role: i === asked ? "user" : "bot" }));

  it("is the tail window when the newest message is inside it", () => {
    expect(followWindowStart(turn(tail + 10, 300), 0)).toBe(tail);
  });

  it("stops at the newest message when a long turn follows it", () => {
    expect(followWindowStart(turn(tail - 100, 300), 0)).toBe(tail - 100);
  });

  it("stops at most two full windows back from the end", () => {
    const limit = 300 - 2 * TRANSCRIPT_WINDOW_SIZE;
    expect(followWindowStart(turn(limit, 300), 0)).toBe(limit);
    expect(followWindowStart(turn(limit - 1, 300), 0)).toBe(tail);
  });

  it("does not stop at a message that is already above the window", () => {
    expect(followWindowStart(turn(100, 300), tail - 10)).toBe(tail);
  });

  it("is the tail window when the person has not written", () => {
    expect(followWindowStart(turn(-1, 300), 0)).toBe(tail);
    expect(followWindowStart([], 0)).toBe(0);
  });

  it("moves back to the tail when the thread got shorter than the boundary allows", () => {
    const shorter = 560 - TRANSCRIPT_OPEN_SIZE;
    expect(followWindowStart(turn(450, 560), 500)).toBe(shorter);
    expect(followWindowStart(turn(shorter + 1, 560), 500)).toBe(shorter);
    expect(followWindowStart(turn(-1, 20), 500)).toBe(0);
  });
});

describe("expandWindowStart", () => {
  it("pulls the boundary back by one step per click", () => {
    expect(expandWindowStart(300)).toBe(300 - TRANSCRIPT_STEP_SIZE);
  });

  it("clamps an expansion past the start of the thread to zero", () => {
    expect(expandWindowStart(TRANSCRIPT_STEP_SIZE - 1)).toBe(0);
  });

  it("stays at zero once fully expanded", () => {
    expect(expandWindowStart(0)).toBe(0);
  });
});

describe("resolveTranscriptWindow", () => {
  it("keeps a short thread fully visible with nothing hidden", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10));
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
    expect(result.startIndex).toBe(0);
    expect(result.laterCount).toBe(0);
  });

  it("windows a long thread to its tail", () => {
    const result = resolveTranscriptWindow(thread(300), tailWindowStart(300));
    expect(result.visible).toHaveLength(TRANSCRIPT_OPEN_SIZE);
    expect(result.visible[0]).toBe(300 - TRANSCRIPT_OPEN_SIZE);
    expect(result.visible.at(-1)).toBe(299);
    expect(result.hiddenCount).toBe(300 - TRANSCRIPT_OPEN_SIZE);
  });

  it("grows the window when messages append past an anchored boundary", () => {
    const start = tailWindowStart(300);
    const result = resolveTranscriptWindow(thread(310), start);
    expect(result.startIndex).toBe(start);
    expect(result.visible).toHaveLength(TRANSCRIPT_OPEN_SIZE + 10);
    expect(result.visible.at(-1)).toBe(309);
  });

  it("expands by one step per call until the start of the thread", () => {
    const messages = thread(100);
    const once = resolveTranscriptWindow(messages, expandWindowStart(tailWindowStart(100)));
    expect(once.visible).toHaveLength(TRANSCRIPT_OPEN_SIZE + TRANSCRIPT_STEP_SIZE);
    expect(once.hiddenCount).toBe(100 - TRANSCRIPT_OPEN_SIZE - TRANSCRIPT_STEP_SIZE);
    const twice = resolveTranscriptWindow(messages, expandWindowStart(once.startIndex));
    expect(twice.visible).toHaveLength(100);
    expect(twice.hiddenCount).toBe(0);
  });

  it("falls back to a tail window when the thread shrinks under the boundary", () => {
    const result = resolveTranscriptWindow(thread(150), 180);
    expect(result.startIndex).toBe(150 - TRANSCRIPT_OPEN_SIZE);
    expect(result.visible).toHaveLength(TRANSCRIPT_OPEN_SIZE);
    expect(result.hiddenCount).toBe(150 - TRANSCRIPT_OPEN_SIZE);
  });

  it("resets a boundary sitting exactly at the end of the thread", () => {
    const result = resolveTranscriptWindow(thread(TRANSCRIPT_OPEN_SIZE), TRANSCRIPT_OPEN_SIZE);
    expect(result.startIndex).toBe(0);
    expect(result.visible).toHaveLength(TRANSCRIPT_OPEN_SIZE);
  });

  it("resolves an empty thread to an empty window", () => {
    const result = resolveTranscriptWindow([], 0);
    expect(result.visible).toHaveLength(0);
    expect(result.hiddenCount).toBe(0);
  });

  it("respects a custom window size", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10, 4), 4);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(6);
  });

  it("keeps a finite search-focus window instead of mounting through the tail", () => {
    const result = resolveTranscriptWindow(thread(1_000), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(440);
    expect(result.visible.at(-1)).toBe(559);
    expect(result.hiddenCount).toBe(440);
    expect(result.laterCount).toBe(440);
    expect(result.endIndex).toBe(560);
  });

  it("falls back to the tail if a finite window becomes invalid after a rewind", () => {
    const result = resolveTranscriptWindow(thread(100), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible[0]).toBe(0);
    expect(result.visible.at(-1)).toBe(99);
    expect(result.laterCount).toBe(0);
  });
});

describe("focusWindowRange", () => {
  it.each([10, 500, 990])("contains target %i in a bounded window", (target) => {
    const range = focusWindowRange(1_000, target);
    expect(target).toBeGreaterThanOrEqual(range.start);
    expect(target).toBeLessThan(range.end);
    expect(range.end - range.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE);
  });

  it("uses the full short transcript", () => {
    expect(focusWindowRange(20, 10)).toEqual({ start: 0, end: 20 });
  });
});

describe("withRestingCard", () => {
  const rows = thread(300);
  const range = resolveTranscriptWindow(rows, tailWindowStart(rows.length));

  it("puts the newest resting card back on top when the range has left it behind", () => {
    const shown = withRestingCard(rows, range.visible, range.startIndex, (row) => row === 10 || row === 40);
    expect(shown[0]).toBe(40);
    expect(shown.slice(1)).toEqual(range.visible);
  });

  it("adds nothing when the newest resting card is already in the range", () => {
    expect(withRestingCard(rows, range.visible, range.startIndex, (row) => row === 10 || row === 300 - TRANSCRIPT_OPEN_SIZE + 10)).toBe(range.visible);
  });

  it("adds nothing when no card rests on the person", () => {
    expect(withRestingCard(rows, range.visible, range.startIndex, () => false)).toBe(range.visible);
    expect(withRestingCard(rows, range.visible, range.startIndex)).toBe(range.visible);
  });
});
