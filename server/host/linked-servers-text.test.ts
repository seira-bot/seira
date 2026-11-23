import { describe, expect, it } from "vitest";

import { farFileName, farFrame } from "./linked-servers-text.ts";

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
