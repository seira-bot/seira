import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderMark } from "./ProviderIcons";

const DRIVER_KINDS = [
  "grokAgent", "kimiAgent", "droidAgent", "cursorAgent", "copilotAgent", "commandCodeAgent", "kiroAgent", "devinAgent",
  "claudeAgent", "codex", "antigravityAgent", "opencodeGo", "openai-compat", "mistral", "mistralVibeAgent", "cerebras", "groq",
  "greenference", "modelgo", "meta", "deepseekAgent", "museCode", "qwenAgent", "hermesAgent", "clineAgent", "piAgent", "ompAgent", "geminiAgent",
];
const mark = (driverKind: string) => renderToStaticMarkup(createElement(ProviderMark, { driverKind, size: 18 }));
const textNodes = (html: string) => html.replace(/<[^>]*>/g, "").trim();
const pathOf = (html: string) => /<path[^>]* d="([^"]+)"/.exec(html)?.[1];

describe("provider marks", () => {
  it("draws an svg and no letter for every driver in the default fleet", () => {
    for (const driverKind of DRIVER_KINDS) {
      const html = mark(driverKind);
      expect(html, driverKind).toContain("<svg");
      expect(textNodes(html), driverKind).toBe("");
    }
  });

  it("draws its own logo for Cerebras, Groq, Cline and OMP", () => {
    const paths = ["cerebras", "groq", "clineAgent", "ompAgent"].map((driverKind) => pathOf(mark(driverKind)));
    for (const path of paths) expect(path).toBeTruthy();
    expect(new Set(paths).size).toBe(4);
    expect(mark("cerebras")).toContain("#F15A29");
    expect(mark("groq")).toContain("var(--color-ink)");
    expect(mark("clineAgent")).toContain("var(--color-ink)");
    expect(mark("ompAgent")).toContain("linearGradient");
  });

  it("gives two OMP marks on one page their own gradient", () => {
    const html = renderToStaticMarkup(createElement("div", null, createElement(ProviderMark, { driverKind: "ompAgent" }), createElement(ProviderMark, { driverKind: "ompAgent" })));
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("draws the Gemini logo for Gemini CLI, a server icon for OpenAI-compatible, and a generic icon for an unknown driver", () => {
    expect(mark("geminiAgent")).toContain("#8E75B2");
    expect(mark("openai-compat")).toContain("lucide-server");
    const unknown = mark("somethingNew");
    expect(unknown).toContain("<svg");
    expect(unknown).toContain("lucide-cpu");
    expect(textNodes(unknown)).toBe("");
  });
});
