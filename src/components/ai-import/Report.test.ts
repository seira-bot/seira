import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ReportView } from "./Report";
import { DONE, job } from "./test-jobs";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const draw = (given = DONE, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReportView, { job: given, onUndo: vi.fn(), onDone: vi.fn(), onRetry: vi.fn(), ...extra }));

describe("the report", () => {
  it("counts and reasons: brought in, updated, two copies, not brought in, each with its reason", () => {
    const markup = draw();
    const shown = text(markup);
    expect(shown).toMatch(/Brought in\s+21/);
    expect(shown).toMatch(/Updated\s+3/);
    expect(shown).toMatch(/Kept as two copies\s+2/);
    expect(shown).toMatch(/Not brought in\s+2/);
    expect(shown).toContain("Chat Broken chat: Could not be read");
    expect(shown).toContain("File: Not in the export file");
    expect(markup).toContain("<details");
  });

  it("next steps: Add key, Allow skill, Connect again and Resume routine", () => {
    const shown = text(draw());
    expect(shown).toContain("Add key");
    expect(shown).toContain("Sample project: add the key for notes");
    expect(shown).toContain("Allow skill");
    expect(shown).toContain("Sample project: pdf-tools");
    expect(shown).toContain("Connect again");
    expect(shown).toContain("Sample project: telegram");
    expect(shown).toContain("Resume routine");
    expect(shown).toContain("Sample project: Morning digest");
  });

  it("leaves out a next-step group that has nothing in it", () => {
    const quiet = job({ state: "done", report: { ...DONE.report!, next: { addKey: [], allowSkill: [], connectAgain: [], resumeRoutine: [] }, leftovers: [] }, undoUntil: DONE.undoUntil });
    const markup = draw(quiet);
    expect(markup).not.toContain("data-ai-import-next");
    expect(markup).not.toContain("<details");
  });

  it("no confirm dialog: Undo is one button, with the date it lasts to", () => {
    const markup = draw();
    expect(markup.match(/data-ai-import-undo/g)).toHaveLength(1);
    expect(markup).not.toMatch(/role="(?:alert)?dialog"/);
    expect(text(markup)).not.toMatch(/are you sure|confirm/i);
    expect(text(markup)).toContain("You can undo this until");
  });

  it("offers no Undo once it is over or when the window has closed", () => {
    expect(draw(job({ ...DONE, undoUntil: null }))).not.toContain("data-ai-import-undo");
    expect(draw(job({ ...DONE, state: "undone" }))).not.toContain("data-ai-import-undo");
  });

  it("shows the Undo result with the items it kept", () => {
    const shown = text(draw(job({ ...DONE, state: "undone", undoResult: { removed: 20, restored: 3, kept: ["Notes on tea", "Morning digest"] } })));
    expect(shown).toContain("Undone: 20 removed, 3 restored.");
    expect(shown).toContain("Kept because you changed them after the import:");
    expect(shown).toContain("Notes on tea");
    expect(shown).toContain("Morning digest");
  });

  it("a stopped apply keeps its report and Undo", () => {
    const markup = draw(job({ ...DONE, state: "cancelled" }));
    expect(text(markup)).toContain("Stopped");
    expect(markup).toContain("data-ai-import-undo");
  });

  it("a failed apply says nothing was kept and offers Try again", () => {
    const markup = draw(job({ state: "failed", error: null }));
    expect(text(markup)).toContain("Nothing from this import was kept.");
    expect(markup).toContain("data-ai-import-retry");
  });

  it("says partly brought in", () => {
    expect(text(draw(job({ ...DONE, state: "partly-done" })))).toContain("Partly brought in");
  });
});
