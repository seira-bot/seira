import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BRAND_MARKS, BrandMark, type BrandId } from "./BrandMarks";
import * as providerIcons from "./ProviderIcons";

const BRANDS = Object.keys(BRAND_MARKS) as BrandId[];
const draw = (brand: BrandId) => renderToStaticMarkup(createElement(BrandMark, { brand, size: 18 }));
const textNodes = (html: string) => [...html.matchAll(/>([^<]*)</g)].map((match) => match[1]).join("").trim();
const shape = (html: string) => [...html.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]).join("|");
const coloured = (html: string) => /#[0-9a-f]{3,8}\b|url\(#/i.test(html);

describe("brand marks", () => {
  it.each(BRANDS)("draws the %s logo as an svg with no letters, hidden from screen readers", (brand) => {
    const html = draw(brand);
    expect(html).toMatch(/^<svg [^>]*aria-hidden="true"/);
    expect(textNodes(html)).toBe("");
    expect(shape(html).length).toBeGreaterThan(40);
  });

  it("draws a different shape for every brand", () => {
    expect(new Set(BRANDS.map((brand) => shape(draw(brand)))).size).toBe(BRANDS.length);
  });

  it.each(BRANDS)("fades the %s logo as a coloured one exactly when it carries its own colours", (brand) => {
    expect(BRAND_MARKS[brand].tone).toBe(coloured(draw(brand)) ? "brand" : "mono");
  });

  it("draws the black logos in the text colour, so the dark skins show their white version", () => {
    for (const brand of ["openai", "xai", "elevenlabs", "lmStudio", "composio", "typesafe", "fishAudio"] as const) expect(draw(brand), brand).toContain("var(--color-ink)");
  });

  it("gives two gradient marks on one page their own gradients", () => {
    for (const brand of ["codex", "gemini", "minimax"] as const) {
      const html = renderToStaticMarkup(createElement("div", null, createElement(BrandMark, { brand }), createElement(BrandMark, { brand })));
      const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]!);
      expect(ids.length, brand).toBeGreaterThan(1);
      expect(new Set(ids).size, brand).toBe(ids.length);
      for (const id of ids) expect(html, brand).toContain(`url(#${id})`);
    }
  });

  it("fades a subtle mark at rest the way a provider row does", () => {
    const composio = renderToStaticMarkup(createElement(BrandMark, { brand: "composio", size: 16, subtle: true }));
    expect(composio).toMatch(/^<span data-provider-mark="mono" data-brand-mark="composio"/);
    expect(composio).toContain("[--color-ink:var(--color-ink-tertiary)]");
    expect(composio).toContain('style="width:16px;height:16px"');
    const cloudflare = renderToStaticMarkup(createElement(BrandMark, { brand: "cloudflare", size: 16, subtle: true }));
    expect(cloudflare).toMatch(/^<span data-provider-mark="brand" data-brand-mark="cloudflare" class="[^"]*\bopacity-60\b/);
  });

  it("names where each logo comes from", () => {
    const source = readFileSync(join(process.cwd(), "src", "components", "BrandMarks.tsx"), "utf8");
    const marks = [...source.matchAll(/(\/\*\*[^\n]*\*\/)\nexport function (\w+Mark)\(/g)].filter((match) => match[2] !== "BrandMark");
    expect(marks.map((match) => match[2]).sort()).toEqual(Object.values(BRAND_MARKS).map((entry) => entry.Mark.name).sort());
    for (const [, comment] of marks) expect(comment).toMatch(/\bfrom\b/);
  });

  it("exports the marks the other settings pages use", () => {
    for (const name of ["CloudflareMark", "TypeSafeMark", "GeminiMark", "OpenAIMark", "OpenRouterMark", "XaiMark"]) {
      expect(typeof (providerIcons as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
