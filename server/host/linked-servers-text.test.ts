import { describe, expect, it, vi } from "vitest";

import { clean, defuse } from "../records-block.ts";
import { ADMIT, createIntake } from "./linked-servers-admit.ts";
import { farFileName, farFrame, readFar } from "./linked-servers-text.ts";

vi.mock("../records-block.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../records-block.ts")>();
  return { ...actual, clean: vi.fn(actual.clean), defuse: vi.fn(actual.defuse) };
});

const HIDDEN = "‮​\u{e0041}ㅤ\u0007";
const SPACED = (word: string) => new RegExp(`^${word[0]} *${word.slice(1)}$`, "u");

describe("what a guest peer says", () => {
  it("loses its invisible and control characters in its place, its bots, a hand-off's sender, words and files, and a result's words", () => {
    expect(farFrame({ t: "hello", place: { id: "p", name: `Far${HIDDEN}Place` }, bots: [{ id: "b", name: `B${HIDDEN}ot`, title: `T${HIDDEN}`, description: `D${HIDDEN}` }] }))
      .toEqual({ t: "hello", place: { id: "p", name: "Far Place" }, bots: [{ id: "b", name: "B ot", title: "T", description: "D" }] });
    const handoff = farFrame({ t: "handoff", id: "h1", to: "writer", from: { botId: "b", name: `S${HIDDEN}am`, threadId: "t" }, thread: "t", text: `W${HIDDEN}ork`, mode: "work",
      origin: { kind: "outside" }, files: [{ name: `pic${HIDDEN}.png`, mime: "image/png", kind: "image", bytes: 1 }] }) as { from: { name: string }; text: string; files: Array<{ name: string }> };
    expect([handoff.from.name, handoff.text, handoff.files[0]!.name]).toEqual(["S am", expect.stringMatching(SPACED("Work")), "pic .png"]);
    expect((farFrame({ t: "result", id: "h1", ok: true, text: `D${HIDDEN}one` }) as { text: string }).text).toMatch(SPACED("Done"));
  });

  it("names a file, a place or a bot with nothing left in its name by a plain fallback", () => {
    const hello = farFrame({ t: "hello", place: { id: "p", name: HIDDEN }, bots: [{ id: "b", name: HIDDEN }] });
    expect([farFileName(HIDDEN), hello]).toEqual(["file", { t: "hello", place: { id: "p", name: "Another Seira" }, bots: [{ id: "b", name: "Teammate" }] }]);
  });

  const UNSAFE = ["a\nb", "a\u202eb", "a\u200bb", "a\u0000b", "a b", "a\tb", "a\u2028b", "", `a${"b".repeat(200)}`, "a/b", "a[b"];
  const honest = {
    handoff: { t: "handoff", id: "7f1c2d9e-3a4b-4c5d-8e6f-0123456789ab", to: "writer_2", from: { botId: "room-9f2e-1", name: "Sam", threadId: "0123456789abcdef0123456789abcdef" }, thread: "fedcba9876543210fedcba9876543210", text: "Work", mode: "work", origin: { kind: "outside" } },
    result: { t: "result", id: "7f1c2d9e-3a4b-4c5d-8e6f-0123456789ab", ok: true, text: "Done" },
    done: { t: "done", id: "7f1c2d9e-3a4b-4c5d-8e6f-0123456789ab" },
    cancel: { t: "cancel", id: "7f1c2d9e-3a4b-4c5d-8e6f-0123456789ab" },
    bye: { t: "bye" },
  };
  const fields: Array<[string, (value: string) => unknown]> = [
    ["handoff id", (id) => ({ ...honest.handoff, id })],
    ["handoff to", (to) => ({ ...honest.handoff, to })],
    ["handoff thread", (thread) => ({ ...honest.handoff, thread })],
    ["handoff sender bot", (botId) => ({ ...honest.handoff, from: { ...honest.handoff.from, botId } })],
    ["handoff sender thread", (threadId) => ({ ...honest.handoff, from: { ...honest.handoff.from, threadId } })],
    ["result id", (id) => ({ ...honest.result, id })],
    ["done id", (id) => ({ ...honest.done, id })],
    ["cancel id", (id) => ({ ...honest.cancel, id })],
  ];

  for (const [name, make] of fields) {
    it(`refuses a frame whose ${name} is unsafe, and does not rewrite it`, () => {
      for (const unsafe of UNSAFE) expect(farFrame(make(unsafe))).toBeNull();
      expect(farFrame(make("ok_id-1"))).not.toBeNull();
    });
  }

  it("passes an honest frame of each kind with its ids as they are", () => {
    expect(farFrame(honest.handoff)).toEqual(honest.handoff);
    expect(farFrame(honest.result)).toEqual(honest.result);
    expect(farFrame(honest.done)).toEqual(honest.done);
    expect(farFrame(honest.cancel)).toEqual(honest.cancel);
    expect(farFrame(honest.bye)).toEqual(honest.bye);
  });

  it("leaves what is not a frame to the link's own check", () => {
    expect([farFrame("x"), farFrame(null), farFrame([1])]).toEqual(["x", null, [1]]);
  });
});

describe("reading a guest peer's frame", () => {
  const result = (text: string) => ({ t: "result", id: "r1", ok: true, text });
  const handoffFrom = (name: string) => ({ t: "handoff", id: "h1", to: "writer", from: { botId: "b", name, threadId: "t" }, thread: "t", text: "Work", mode: "work",
    origin: { kind: "outside", quote: "Q" }, doneWhen: "When", files: [{ name: "a.png", mime: "image/png", kind: "image", bytes: 1 }] });

  it("is null at no price for a frame that does not parse, and nothing for a frame with no words", () => {
    const unread = { frame: null, price: 0 };
    expect([readFar(null), readFar("x"), readFar({ t: "result", id: "r1" }), readFar(result("x".repeat(200_001)))]).toEqual([unread, unread, unread, unread]);
    expect([readFar({ t: "done", id: "d" }), readFar({ t: "cancel", id: "c" }), readFar({ t: "bye" })].map((one) => one.price)).toEqual([0, 0, 0]);
  });

  it("prices the characters farFrame cleans in what parsed", () => {
    expect(readFar(result("abc"))).toEqual({ frame: result("abc"), price: 3 });
    expect(readFar(handoffFrom("Sam")).price).toBe("Work".length + "When".length + "Sam".length + "Q".length + "a.png".length);
    expect(readFar({ t: "hello", place: { id: "p", name: "Far" }, bots: [{ id: "b", name: "Bot", title: "T", description: "Desc", model: "M" }] }).price).toBe(3 + 3 + 1 + 4 + 1);
  });

  it("prices a hello with many keys it does not know from what parsed, without writing the frame out, in a few milliseconds", () => {
    const bot: Record<string, unknown> = { id: "b", name: "Bot" };
    for (let index = 0; index < 450_000; index++) bot[`k${index}`] = 0;
    const wide = { t: "hello", place: { id: "p", name: "Far" }, bots: [bot] };
    const stringify = vi.spyOn(JSON, "stringify");
    const start = performance.now();
    const prices = Array.from({ length: ADMIT.exchanges }, () => readFar(wide).price);
    const ms = performance.now() - start;
    const calls = stringify.mock.calls.length;
    stringify.mockRestore();
    expect([calls, new Set(prices)]).toEqual([0, new Set([6])]);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  it("never reads the space around a name: the cleaner gets the name as the schema trimmed it", () => {
    const pad = " ".repeat(2_000_000);
    vi.mocked(clean).mockClear();
    vi.mocked(defuse).mockClear();
    const hello = readFar({ t: "hello", place: { id: "p", name: `${pad}Far${pad}` }, bots: [{ id: "b", name: `${pad}Bot${pad}` }] });
    const handoff = readFar(handoffFrom(`${pad}Sam${pad}`));
    expect([hello.price, handoff.price]).toEqual([6, "Work".length + "When".length + "Sam".length + "Q".length + "a.png".length]);
    expect(farFrame(hello.frame)).toEqual({ t: "hello", place: { id: "p", name: "Far" }, bots: [{ id: "b", name: "Bot" }] });
    expect((farFrame(handoff.frame) as { from: { name: string } }).from.name).toBe("Sam");
    const read = [...vi.mocked(clean).mock.calls, ...vi.mocked(defuse).mock.calls].map(([text]) => text.length);
    expect(Math.max(...read)).toBeLessThanOrEqual(5);
  });

  it("reads a frame nested too deep to write out without throwing, and the hello after it does not jam", () => {
    let deep: unknown = 0;
    for (let index = 0; index < 100_000; index++) deep = [deep];
    const hello = { t: "hello", place: { id: "p", name: "Far" }, bots: [{ id: "b", name: "Bot", extra: deep }] };
    expect(() => JSON.stringify(hello)).toThrow(RangeError);
    expect(readFar(hello)).toEqual({ frame: { t: "hello", place: { id: "p", name: "Far" }, bots: [{ id: "b", name: "Bot" }] }, price: 6 });
    expect(readFar({ ...result("x"), text: deep })).toEqual({ frame: null, price: 0 });
    const intake = createIntake(() => 0, {}, readFar);
    expect(intake.take("a", [hello, { t: "cancel", id: "c1" }], false)).toMatchObject({ count: 2, frames: [readFar(hello).frame, { t: "cancel", id: "c1" }] });
    expect(intake.take("a", [{ t: "hello", place: { id: "p", name: "Next" }, bots: [] }], false).frames).toEqual([{ t: "hello", place: { id: "p", name: "Next" }, bots: [] }]);
  });

  it("charges the largest hello that parses to the character budget, over as many windows as its price needs", () => {
    const text = (length: number) => "\u0001".repeat(length);
    const bot = (index: number) => ({ id: `bot-${index}`, name: text(120), title: text(200), description: text(400), model: text(200) });
    const largest = { t: "hello", place: { id: "p", name: text(120) }, bots: Array.from({ length: 500 }, (_, index) => bot(index)) };
    const read = readFar(largest);
    expect(read.price).toBe(120 + 500 * (120 + 200 + 400 + 200));
    let now = 0;
    const intake = createIntake(() => now, {}, readFar);
    const taken = (frames: unknown[]) => intake.take("a", frames, false).frames.length;
    expect(taken([largest])).toBe(1);
    expect(taken([result("x")])).toBe(0);
    now = ADMIT.windowMs;
    const room = 2 * ADMIT.chars - read.price;
    expect(taken([result("x".repeat(room + 1))])).toBe(0);
    expect(taken([result("x".repeat(room))])).toBe(1);
    expect(taken([result("x")])).toBe(0);
  });

  it("reads no text of a frame past the schema's limits, in a few milliseconds", () => {
    const huge = "[".repeat(4_000_000);
    const frames = [result(huge), handoffFrom(huge), { t: "hello", place: { id: "p", name: huge }, bots: [] }];
    const start = performance.now();
    const out = frames.map((frame) => readFar(frame));
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(out).toEqual([{ frame: null, price: 0 }, { frame: null, price: 0 }, { frame: null, price: 0 }]);
  }, 30_000);
});
