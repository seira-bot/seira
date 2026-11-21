import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PasteSource } from "../../../shared/ai-import/api";
import { AI_IMPORT_LIMITS } from "../../../shared/ai-import/limits";
import { pastePrompt, PASTE_SOURCES } from "../../../shared/ai-import/paste";
import { PasteStep, type PasteStepProps } from "./PasteStep";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const draw = (overrides: Partial<PasteStepProps> = {}) => renderToStaticMarkup(createElement(PasteStep, {
  ai: "chatgpt", text: "", destination: { kind: "new" }, bots: [], onAi: vi.fn(), onText: vi.fn(), onDestination: vi.fn(), onCopy: vi.fn(), onImport: vi.fn(), onBack: vi.fn(), ...overrides,
}));

describe("the paste step", () => {
  it("prompt per AI: each AI shows its own prompt and one Copy button", () => {
    const seen = new Set<string>();
    for (const ai of PASTE_SOURCES) {
      const markup = draw({ ai: ai as PasteSource });
      const prompt = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(markup)![1]!;
      expect(text(prompt)).toContain(text(pastePrompt(ai).split("\n")[0]!));
      seen.add(prompt);
      expect(markup.match(/data-ai-import-copy/g)).toHaveLength(1);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(text(draw())).toContain("Copy");
    expect(text(draw({ copied: true }))).toContain("Copied");
  });

  it("lists every AI to pick from", () => {
    const shown = text(draw());
    for (const name of ["ChatGPT", "Claude.ai", "Gemini", "Grok", "Copilot", "Another AI"]) expect(shown).toContain(name);
  });

  it("shows counts: each group's count before import", () => {
    const markup = draw({ text: "About you\n- Runs a bakery\n- Lives in Surabaya\nHow to reply\n- Keep it short" });
    expect(text(markup)).toContain("About you: 2. How to reply: 1.");
    expect(markup).not.toMatch(/data-ai-import-paste-import=""[^>]*disabled/);
  });

  it("empty and too long: Import stays off and the reason sits beside it", () => {
    const empty = draw({ text: "  " });
    expect(empty).toMatch(/data-ai-import-paste-import=""[^>]*disabled/);
    expect(text(empty)).toContain("Paste an answer to import.");
    const long = draw({ text: "a".repeat(AI_IMPORT_LIMITS.pasteChars + 1) });
    expect(long).toMatch(/data-ai-import-paste-import=""[^>]*disabled/);
    expect(text(long)).toContain("The answer is longer than 100,000 characters. Shorten it to import.");
    expect(long).not.toContain("data-ai-import-paste-counts");
  });

  it("keeps Import off while sending", () => {
    expect(draw({ text: "- Likes tea", busy: true })).toMatch(/data-ai-import-paste-import=""[^>]*disabled/);
  });
});
