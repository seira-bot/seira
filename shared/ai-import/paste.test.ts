import { describe, expect, it } from "vitest";

import { AI_IMPORT_LIMITS } from "./limits.ts";
import { checkPaste, parsePaste, pastePrompt, PASTE_SOURCES } from "./paste.ts";

describe("paste prompts", () => {
  it("gives each AI a prompt that asks for the two groups", () => {
    for (const ai of PASTE_SOURCES) {
      const prompt = pastePrompt(ai);
      expect(prompt).toContain("About you");
      expect(prompt).toContain("How to reply");
    }
    expect(new Set(PASTE_SOURCES.map(pastePrompt)).size).toBeGreaterThan(1);
  });
});

describe("parsePaste", () => {
  it("sorts lines under their headings and drops bullets and dates", () => {
    const parsed = parsePaste([
      "About you",
      "- Lives in Surabaya",
      "- 2025-03-02: Runs a small bakery",
      "",
      "**How to reply**",
      "1. Keep answers short",
      "* Use plain words",
    ].join("\n"));
    expect(parsed.aboutYou).toEqual(["Lives in Surabaya", "Runs a small bakery"]);
    expect(parsed.howToReply).toEqual(["Keep answers short", "Use plain words"]);
  });

  it("reads lines with no heading by what they say, and keeps each line once", () => {
    const parsed = parsePaste("Works as a designer\nAlways answer in Indonesian\nWorks as a designer\nNever use emoji");
    expect(parsed.aboutYou).toEqual(["Works as a designer"]);
    expect(parsed.howToReply).toEqual(["Always answer in Indonesian", "Never use emoji"]);
  });

  it("accepts a heading with a colon and a markdown heading", () => {
    const parsed = parsePaste("## About you:\nHas two cats\n# Instructions\nBe brief");
    expect(parsed).toEqual({ aboutYou: ["Has two cats"], howToReply: ["Be brief"] });
  });

  it("returns nothing for empty text", () => {
    expect(parsePaste("  \n\n")).toEqual({ aboutYou: [], howToReply: [] });
  });
});

describe("checkPaste", () => {
  it("refuses empty text and text over the limit", () => {
    expect(checkPaste("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkPaste("a".repeat(AI_IMPORT_LIMITS.pasteChars + 1))).toEqual({ ok: false, reason: "too-long" });
    expect(checkPaste("a".repeat(AI_IMPORT_LIMITS.pasteChars))).toEqual({ ok: true });
  });
});
