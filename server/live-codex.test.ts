import { describe, expect, it } from "vitest";
import { codexCallHistory, codexVoiceInstructions, codexWorkInstructions } from "./live-codex.ts";

describe("Codex call instructions", () => {
  it("names the bot and tells the voice to speak as one assistant", () => {
    const text = codexVoiceInstructions({ name: "Rigel" });
    expect(text).toContain("Rigel");
    expect(text).toContain("first person");
    expect(text.toLowerCase()).not.toContain("delegat");
    expect(text).not.toContain("Backend tools");
  });

  it("tells the work model to end with a short answer that can be spoken", () => {
    const text = codexWorkInstructions({ name: "Rigel" });
    expect(text).toContain("Rigel");
    expect(text).toContain("easy to speak");
    expect(text).toContain("no Markdown");
  });

  it("keeps the last 8 messages, cut to 600 characters, newest within the total limit", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i}`.padEnd(900, "x") })) as never[];
    const trimmed = codexCallHistory(history);
    expect(trimmed.length).toBeLessThanOrEqual(8);
    expect(trimmed.every((m) => m.text.length <= 600)).toBe(true);
    expect(trimmed.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(6_000);
    expect(trimmed.at(-1)!.text.startsWith("11")).toBe(true);
  });
});
