import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { KeyMarkIcon } from "./KeyRow";
import { keyEntry, shownKeyEntry, type KeyEntry, type KeyId } from "./key-catalog";

const icon = (entry: KeyEntry) => renderToStaticMarkup(createElement(KeyMarkIcon, { entry }));

describe("the mark on a key row", () => {
  it.each<[KeyId, string]>([
    ["composio", "composio"], ["elevenlabs", "elevenlabs"], ["geminiTts", "gemini"], ["fishAudio", "fishAudio"], ["box", "boat"],
    ["onePassword", "onePassword"], ["lmStudio", "lmStudio"], ["liveCalls", "openai"], ["liveKey", "openai"],
  ])("shows the %s row with the %s logo", (id, brand) => {
    const html = icon(keyEntry(id));
    expect(html).toContain(`data-brand-mark="${brand}"`);
    expect(html).not.toContain("lucide-");
  });

  it("keeps a plain icon for a row that stands for no brand, faded and lifted like the brand marks", () => {
    for (const id of ["openaiCompat", "vps"] as const) {
      const html = icon(keyEntry(id));
      expect(html, id).toContain("lucide-server");
      expect(html, id).toContain("text-ink-tertiary");
      expect(html, id).toContain("group-hover:text-ink ");
      expect(html, id).toContain("group-focus-within:text-ink");
    }
  });

  it("shows the logo of the voice provider that Live calls use", () => {
    const live = (provider: string) => icon(shownKeyEntry("liveKey", { live: { provider } } as unknown as ConfigStatus));
    expect(live("fish")).toContain('data-brand-mark="fishAudio"');
    expect(live("gemini")).toContain('data-brand-mark="gemini"');
    expect(live("elevenlabs")).toContain('data-brand-mark="elevenlabs"');
    expect(live("azure")).toContain("#0089D6");
    expect(live("custom")).toContain("lucide-server");
  });
});
