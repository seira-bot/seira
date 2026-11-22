import { afterEach, describe, expect, it } from "vitest";

import {
  beginCallSession,
  callSession,
  CAPTION_LINES_SHOWN,
  foldCaption,
  formatCallTime,
  lastCaptions,
  liveCallPresence,
  patchCallSession,
  pushCaption,
  resetCallSession,
  setCallMinimized,
  type CaptionLine,
} from "./call-session";

let id = 0;
const next = () => ++id;
const fold = (lines: readonly CaptionLine[], who: "bot" | "you", text: string) => foldCaption(lines, who, text, next);

afterEach(() => resetCallSession());

describe("foldCaption", () => {
  it("grows one line while an utterance gets longer", () => {
    let lines = fold([], "you", "hel");
    lines = fold(lines, "you", "hello");
    lines = fold(lines, "you", "hello there");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ who: "you", text: "hello there" });
  });

  it("starts a new line when the speaker changes or the text is a new sentence", () => {
    let lines = fold([], "you", "hello");
    lines = fold(lines, "bot", "hello");
    lines = fold(lines, "bot", "How can I help?");
    expect(lines.map((line) => `${line.who}:${line.text}`)).toEqual(["you:hello", "bot:hello", "bot:How can I help?"]);
  });

  it("ignores empty text and a repeat of the last line", () => {
    const lines = fold([], "bot", "Hi");
    expect(fold(lines, "bot", "  ")).toBe(lines);
    expect(fold(lines, "bot", "Hi")).toBe(lines);
  });

  it("keeps the longer text when a shorter prefix arrives late", () => {
    const lines = fold([], "bot", "Good morning");
    expect(fold(lines, "bot", "Good")[0]?.text).toBe("Good morning");
  });

  it("keeps the last 40 lines", () => {
    let lines: readonly CaptionLine[] = [];
    for (let index = 0; index < 50; index += 1) lines = fold(lines, index % 2 ? "bot" : "you", `line ${index}`);
    expect(lines).toHaveLength(40);
    expect(lines[0]?.text).toBe("line 10");
  });
});

describe("captions in the call session", () => {
  it("shows the last four lines, newest last", () => {
    beginCallSession("atlas");
    for (const text of ["one", "two", "three", "four", "five", "six"]) pushCaption("bot", text);
    expect(CAPTION_LINES_SHOWN).toBe(4);
    expect(lastCaptions(callSession().captions).map((line) => line.text)).toEqual(["three", "four", "five", "six"]);
  });
});

describe("call session", () => {
  it("starts a call full screen with empty captions, and starts it once for a bot", () => {
    beginCallSession("atlas");
    pushCaption("you", "hi");
    patchCallSession({ stage: "connected" });
    setCallMinimized(true);
    beginCallSession("atlas");
    expect(callSession()).toMatchObject({ botId: "atlas", stage: "connected", minimized: true });
    expect(callSession().captions).toHaveLength(1);
    beginCallSession("juniper");
    expect(callSession()).toMatchObject({ botId: "juniper", stage: "calling", minimized: false, captions: [] });
  });

  it("clears the session when the call ends", () => {
    beginCallSession("atlas");
    resetCallSession();
    expect(callSession().botId).toBeNull();
  });
});

describe("liveCallPresence", () => {
  it("reports ending, muted, listening and speaking in that order", () => {
    expect(liveCallPresence({ phase: "ending", muted: true, heard: "" }, true)).toBe("ending");
    expect(liveCallPresence({ phase: "live", muted: true, heard: "" }, true)).toBe("muted");
    expect(liveCallPresence({ phase: "live", muted: false, heard: "hi" }, true)).toBe("listening");
    expect(liveCallPresence({ phase: "live", muted: false, heard: "" }, true)).toBe("speaking");
    expect(liveCallPresence({ phase: "live", muted: false, heard: "" }, false)).toBe("listening");
  });
});

describe("formatCallTime", () => {
  it("shows minutes and two-digit seconds", () => {
    expect(formatCallTime(0)).toBe("0:00");
    expect(formatCallTime(65_000)).toBe("1:05");
    expect(formatCallTime(-5)).toBe("0:00");
    expect(formatCallTime(3_725_000)).toBe("62:05");
  });
});
