import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SIMPLE_NAV_ROW, SimpleSectionLabel } from "./SidebarSimpleNav";
import { SimpleRoomStack } from "./SidebarSimpleRoom";

describe("Simple's nav rows and labels", () => {
  it("draws a 32px nav row that fills when current", () => {
    expect(SIMPLE_NAV_ROW).toContain("h-8");
    expect(SIMPLE_NAV_ROW).toContain("aria-[current=true]:bg-raised");
  });

  it("draws a 12px tertiary label, with a plus that shows on hover, focus and touch", () => {
    const html = renderToStaticMarkup(createElement(SimpleSectionLabel, { name: "Team", addLabel: "New bot", onAdd: vi.fn() }));
    expect(html).toContain("text-[12px] font-medium text-ink-tertiary");
    expect(html).toMatch(/aria-label="New bot"[^>]*class="[^"]*\bopacity-0\b/);
    for (const reveal of ["group-hover/label:opacity-100", "focus-visible:opacity-100", "touch:opacity-100"]) expect(html).toContain(reveal);
    expect(renderToStaticMarkup(createElement(SimpleSectionLabel, { name: "Team" }))).not.toContain("<button");
  });

  it("falls back to one people icon for a room with no known members", () => {
    const html = renderToStaticMarkup(createElement(SimpleRoomStack, { members: [] }));
    expect(html).toContain("data-room-stack");
    expect(html).toContain("lucide-users");
  });
});
