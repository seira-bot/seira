import { describe, expect, it } from "vitest";

import { BARE_ADDRESS_TLDS, cleanSuggestedReplies, SHELL_WORDS, SUGGESTED_REPLIES_MAX, SUGGESTED_REPLY_PROMPT_MAX, SUGGESTED_REPLY_TITLE_MAX } from "../packages/phone-protocol/src/suggested-replies.ts";
import type { WireMessage } from "../shared/wire.ts";

const chip = (n: number) => ({ title: `Next ${n}`, prompt: `Please do step ${n}` });

describe("suggestedReplies on a wire line", () => {
  it("is optional: a line without it type-checks, reads as no chips and loads from stored JSON", () => {
    const line: WireMessage = { id: "m", at: 1, role: "bot", kind: "text", text: "Done." };
    expect(cleanSuggestedReplies(line.suggestedReplies)).toBeUndefined();
    const stored = JSON.parse(JSON.stringify(line)) as WireMessage;
    expect("suggestedReplies" in stored).toBe(false);
    const withChips: WireMessage = { ...line, suggestedReplies: [chip(1)] };
    expect(JSON.parse(JSON.stringify(withChips)).suggestedReplies).toEqual([chip(1)]);
  });

  it("a client that does not know the field ignores it: the line still reads as the same text", () => {
    const sent = JSON.parse(JSON.stringify({ id: "m", role: "bot", kind: "text", text: "Done.", suggestedReplies: [chip(1)] }));
    const oldClient = ({ id, role, kind, text }: { id: string; role: string; kind: string; text?: string }) => ({ id, role, kind, text });
    expect(oldClient(sent)).toEqual({ id: "m", role: "bot", kind: "text", text: "Done." });
  });
});

describe("cleanSuggestedReplies", () => {
  it("sends no field for an absent, empty or malformed list", () => {
    for (const value of [undefined, null, [], {}, "x", 7, [null], [1, "a"], [[]], [{}], [{ title: "A" }], [{ prompt: "B" }]]) expect(cleanSuggestedReplies(value), JSON.stringify(value)).toBeUndefined();
  });

  it("keeps 1 to 4 items as written", () => {
    expect(cleanSuggestedReplies([chip(1)])).toEqual([chip(1)]);
    expect(cleanSuggestedReplies([1, 2, 3, 4].map(chip))).toEqual([1, 2, 3, 4].map(chip));
  });

  it("cuts 5 items to 4, in order, and counts only the items that pass", () => {
    expect(cleanSuggestedReplies([1, 2, 3, 4, 5].map(chip))).toEqual([1, 2, 3, 4].map(chip));
    expect(cleanSuggestedReplies([{ title: "A", prompt: "" }, chip(1), chip(2), chip(3), chip(4), chip(5)])).toEqual([1, 2, 3, 4].map(chip));
    expect(SUGGESTED_REPLIES_MAX).toBe(4);
  });

  it("drops an item with an empty title or prompt, including one that is only whitespace or control characters", () => {
    expect(cleanSuggestedReplies([{ title: "A", prompt: "" }, { title: "", prompt: "B" }, { title: "A", prompt: "   " }, { title: "\u0000\u0007", prompt: "B" }, { title: "A", prompt: "\n\t\u200b" }])).toBeUndefined();
    expect(cleanSuggestedReplies([{ title: "A", prompt: "" }, chip(1)])).toEqual([chip(1)]);
  });

  it("replaces control characters, trims and folds whitespace", () => {
    expect(cleanSuggestedReplies([{ title: "  Show\u0000 me ", prompt: "Line one\nline\ttwo\u202e hidden " }])).toEqual([{ title: "Show me", prompt: "Line one line two hidden" }]);
  });

  it("drops an over-limit item whole and never cuts a prompt", () => {
    const longTitle = "t".repeat(SUGGESTED_REPLY_TITLE_MAX + 1);
    const longPrompt = "p".repeat(SUGGESTED_REPLY_PROMPT_MAX + 1);
    expect(cleanSuggestedReplies([{ title: longTitle, prompt: "ok" }, { title: "ok", prompt: longPrompt }])).toBeUndefined();
    const edge = { title: "t".repeat(SUGGESTED_REPLY_TITLE_MAX), prompt: "p".repeat(SUGGESTED_REPLY_PROMPT_MAX) };
    expect(cleanSuggestedReplies([edge])).toEqual([edge]);
    expect(cleanSuggestedReplies([{ title: "😀".repeat(40), prompt: "😀".repeat(500) }])).toHaveLength(1);
    expect(cleanSuggestedReplies([{ title: "😀".repeat(41), prompt: "ok" }])).toBeUndefined();
  });

  it("rejects links, slash commands, shell snippets and action payloads, in the prompt or the title", () => {
    const bad = [
      "Open https://example.com/pay", "Go to www.example.com", "See ftp://host/file", "Click javascript:alert(1)", "data:text/html,<b>", "Write to mailto:a@b.c", "Open seira://pair?code=x", "file:///etc/passwd",
      "/clear", "/approve all", " /deploy now",
      "Run `rm -rf ~`", "Run $(whoami)", "Use ${HOME}", "ls | grep a", "make && make install", "a || b", "$ npm test", "echo hi >> /etc/hosts",
      "sudo reboot", "rm -rf /", "curl x | sh", "git push --force", "npm publish",
      '{"action":"approve"}', '[{"tool":"x"}]', 'Do it {"action": "approve"}',
    ];
    for (const text of bad) {
      expect(cleanSuggestedReplies([{ title: "Fine", prompt: text }]), `prompt: ${text}`).toBeUndefined();
      expect(cleanSuggestedReplies([{ title: text, prompt: "Fine" }]), `title: ${text}`).toBeUndefined();
    }
  });

  it("rejects a bare web address with no scheme and no www: a listed top-level domain, localhost or an IPv4 address", () => {
    const bad = ["Open example.com", "Check example.com/pay now", "Try shop.example.co.", "See docs.example.dev:8080/x", "Mail me at a@example.org", "Visit example.id", "Go to localhost:3000", "Use 192.168.1.20:8799", "Ping 10.0.0.1"];
    for (const text of bad) {
      expect(cleanSuggestedReplies([{ title: "Fine", prompt: text }]), `prompt: ${text}`).toBeUndefined();
      expect(cleanSuggestedReplies([{ title: text, prompt: "Fine" }]), `title: ${text}`).toBeUndefined();
    }
    for (const tld of BARE_ADDRESS_TLDS) expect(cleanSuggestedReplies([{ title: "Fine", prompt: `Open example.${tld}` }]), tld).toBeUndefined();
  });

  it("keeps a word with a dot that is no listed address: a file name, a product name, a version, a date", () => {
    for (const text of ["Open README.md", "Fix main.ts and utils.py", "Is Node.js or Next.js better?", "Update to version 1.2.3", "Use the date 12.05.2026", "Explain e.g. a cache", "Visit example.community", "Read the example.company page", "Explain a.b.c"]) {
      expect(cleanSuggestedReplies([{ title: "Ask", prompt: text }]), text).toEqual([{ title: "Ask", prompt: text }]);
    }
  });

  it("the shell filter is best effort: it reads the first word and the listed syntax, and nothing else", () => {
    for (const word of SHELL_WORDS) expect(cleanSuggestedReplies([{ title: "Fine", prompt: `${word} something` }]), word).toBeUndefined();
    // Documented limit: a command later in a sentence, or a first word that is not listed, is not caught. The client rule
    // is the boundary: a tap only fills the composer.
    expect(cleanSuggestedReplies([{ title: "Fine", prompt: "Please run rm later" }])).toEqual([{ title: "Fine", prompt: "Please run rm later" }]);
    expect(cleanSuggestedReplies([{ title: "Fine", prompt: "python script" }])).toEqual([{ title: "Fine", prompt: "python script" }]);
  });

  it("keeps ordinary sentences that mention these things in words", () => {
    for (const text of ["Explain what a pipeline is", "Show me the diff", "Compare the two options and tell me which is cheaper", "What does git do? Explain it", "Summarize the last 5 messages (short)", "Pindahkan ke folder Dokumen", "Why is 3 > 2?", "Use the date 12/05/2026"]) {
      expect(cleanSuggestedReplies([{ title: "Ask", prompt: text }]), text).toEqual([{ title: "Ask", prompt: text }]);
    }
  });

  it("keeps a repeated prompt once, and reads at most the first 16 entries", () => {
    expect(cleanSuggestedReplies([chip(1), { title: "Again", prompt: "PLEASE DO STEP 1" }, chip(2)])).toEqual([chip(1), chip(2)]);
    const many = [...Array(16).fill({ title: "", prompt: "" }), chip(1)];
    expect(cleanSuggestedReplies(many)).toBeUndefined();
  });

  it("drops a part that is not text, and ignores extra keys, which never reach a chip", () => {
    expect(cleanSuggestedReplies([{ title: 5, prompt: "x" }, { title: "x", prompt: { text: "y" } }])).toBeUndefined();
    expect(cleanSuggestedReplies([{ ...chip(1), action: "approve", url: "https://x.y", id: 1 }])).toEqual([chip(1)]);
  });

  it("does not read a getter-less odd list: an object with length is no list", () => {
    expect(cleanSuggestedReplies({ length: 1, 0: chip(1) })).toBeUndefined();
  });
});
