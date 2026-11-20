import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BotEditorStore, initialState, type AppState } from "@/state/store";
import { t } from "@/lib/i18n";
import { LiveProviderSettings } from "./LiveProviderSettings";
import type { LiveSettings } from "../../shared/wire";

const render = (live: Partial<LiveSettings>) => {
  const config = { live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5, ...live } } as AppState["config"];
  const value = { state: { ...initialState, config }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return renderToStaticMarkup(createElement(BotEditorStore, { value, children: createElement(LiveProviderSettings) }));
};

describe("LiveProviderSettings", () => {
  it("offers Codex where the Codex engine is installed", () => {
    expect(render({ codexAvailable: true })).toContain('<option value="codex">Codex</option>');
  });

  it("does not offer Codex where the engine is absent or unknown", () => {
    expect(render({ codexAvailable: false })).not.toContain('value="codex"');
    expect(render({})).not.toContain('value="codex"');
  });

  it("keeps Codex in the list while it is the saved choice, and says what a Codex call uses", () => {
    const html = render({ provider: "codex", codexAvailable: false });
    expect(html).toContain('<option value="codex" selected="">Codex</option>');
    expect(html).toContain(t("call.live.codexHint"));
  });

  it("shows no Codex hint for another provider", () => {
    expect(render({ codexAvailable: true })).not.toContain(t("call.live.codexHint"));
  });
});
