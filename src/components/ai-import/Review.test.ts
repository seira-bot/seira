import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReviewView } from "./Review";
import { job, READY } from "./test-jobs";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const props = { bots: [{ id: "b-9", name: "Sample helper" }, { id: "b-2", name: "Other bot" }], choices: {}, onChoose: vi.fn(), onImport: vi.fn(), onCancel: vi.fn() };

describe("the review screen", () => {
  it("defaults and one button: each bot with its counts, its default destination, one Import", () => {
    const markup = renderToStaticMarkup(createElement(ReviewView, { job: READY, ...props }));
    const shown = text(markup);
    expect(shown).toContain("Sample project");
    expect(shown).toContain("Sample helper");
    expect(shown).toMatch(/Chats\s+12/);
    expect(shown).toMatch(/Skills\s+1/);
    expect(shown).toMatch(/Routines\s+2/);
    expect(shown).not.toMatch(/Tools\s+\d/);
    expect(markup.match(/data-ai-import-apply/g)).toHaveLength(1);
    expect(shown).toContain("Import");
    const selects = markup.match(/<select[^>]*>[\s\S]*?<\/select>/g)!;
    expect(selects).toHaveLength(2);
    expect(selects[0]).toMatch(/<option value="new" selected/);
    expect(selects[1]).toMatch(/<option value="bot:b-9" selected/);
    expect(selects[0]).toContain("A new bot");
    expect(selects[0]).toContain("Other bot");
  });

  it("uses a choice the person made over the default", () => {
    const markup = renderToStaticMarkup(createElement(ReviewView, { job: READY, ...props, choices: { a1: { kind: "bot", botId: "b-2" } } }));
    expect(markup.match(/<select[^>]*>[\s\S]*?<\/select>/g)![0]).toMatch(/<option value="bot:b-2" selected/);
  });

  it("keeps Import off when there is nothing to bring in, and says so", () => {
    const markup = renderToStaticMarkup(createElement(ReviewView, { job: job({ agents: [] }), ...props }));
    expect(markup).toMatch(/data-ai-import-apply=""[^>]*disabled/);
    expect(text(markup)).toContain("There is nothing to bring in from this source.");
  });

  it("mentions items that could not be read", () => {
    expect(text(renderToStaticMarkup(createElement(ReviewView, { job: READY, ...props })))).toContain("2 items could not be read. The report lists them.");
  });
});
