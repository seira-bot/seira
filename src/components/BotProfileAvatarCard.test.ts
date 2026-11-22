import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Seira",
    title: "Seira",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function renderCard(bot: Bot) {
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(BotProfileAvatarCard, {
        bot,
        activeState: "idle",
        mascotMotion: null,
        onPatch: vi.fn(),
      }),
    ),
  );
}

describe("BotProfileAvatarCard", () => {
  it("opens on the Seira tab with hair first, and offers no shape, character, reset or expression list", () => {
    const markup = renderCard(makeBot());
    expect(markup).toContain('data-avatar-tab="seira"');
    expect(markup).toContain("data-avatar-surprise");
    expect(markup).not.toMatch(/Characters|Reset mascot|Expression|Shape|Rounded|Square/);
    expect(markup).not.toContain("data-cast-character");
  });

  it("offers zoom and drag framing for a custom image, on the Upload tab", () => {
    const markup = renderCard(makeBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 1.5,
    }));
    expect(markup).toContain('aria-label="Zoom avatar"');
    expect(markup).toContain("Drag the picture to reposition it");
    expect(markup).toContain("150%");
    expect(markup).toContain("Reset framing");
    expect(markup).toContain("Remove picture");
  });

  it("hides zoom controls for the mascot", () => {
    const markup = renderCard(makeBot());
    expect(markup).not.toContain('aria-label="Zoom avatar"');
  });

  it("draws a bot saved with a flat shape as stored, and offers no shape choice", () => {
    for (const crop of ["rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: crop }));
      expect(markup).toContain('data-avatar-tab="upload"');
      expect(markup).not.toContain("data-avatar-crop");
      expect(markup).not.toMatch(/>(Circle|Rounded|Square)</);
    }
  });
});
