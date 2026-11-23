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
});
