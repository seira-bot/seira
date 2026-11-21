import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SetupDetection } from "../../shared/setup-import";
import { AiAppsImportView, type AiAppsImportViewProps } from "./ImportSettings";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const FOUND: SetupDetection = {
  skills: [{ name: "pdf", source: "claudeCode" }, { name: "review", source: "codex" }],
  tools: [{ name: "notion", source: "cursor" }],
};
const apps = (overrides: Partial<AiAppsImportViewProps> = {}) => text(renderToStaticMarkup(createElement(AiAppsImportView, {
  local: true, detection: FOUND, chosen: { skills: true, tools: true }, status: "idle", result: null, onChoose: vi.fn(), onBring: vi.fn(), ...overrides,
})));

describe("Settings → Import", () => {
  it("offers the welcome step's rows, with its counts, sources and switched-off note", () => {
    const shown = apps();
    expect(shown).toContain("2 from Claude Code and Codex");
    expect(shown).toContain("1 MCP server from Cursor");
    expect(shown).toContain("Added switched off.");
    expect(shown).toContain("Bring them in");
  });

  it("says what happened: looking, nothing new, not this computer, or the result", () => {
    expect(apps({ detection: undefined })).toContain("Looking on this computer…");
    expect(apps({ detection: { skills: [], tools: [] } })).toContain("Nothing new to bring in from your AI apps.");
    expect(apps({ local: false })).toContain("Only the desktop app on the computer running Seira");
    expect(apps({ result: { skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] } } })).toContain("Added 1 skill.");
  });
});
