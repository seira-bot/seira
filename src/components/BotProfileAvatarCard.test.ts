import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { PICKER_BODY_IDS } from "../../shared/bot-body";
import { MASCOT_ACCESSORY_IDS } from "../../shared/mascot-accessories";
import { bodyName } from "@/lib/mascot-names";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "Maus",
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

const HAIR = PICKER_BODY_IDS.length > 1;

describe("BotProfileAvatarCard hair picker", () => {
  it("shows one option per hair of the picker, and none while there is only one", () => {
    const markup = renderCard(makeBot());

    expect(markup).not.toContain(">Body<");
    expect(markup.includes(">Hair<")).toBe(HAIR);
    for (const id of PICKER_BODY_IDS) {
      expect(markup.includes(`aria-label="Use the ${bodyName(id)} hair"`)).toBe(HAIR);
    }
  });

  it("offers no old body and no festival row", () => {
    const markup = renderCard(makeBot({ mascotBody: "jalebi" }));

    for (const name of ["Cursor", "Blob", "Pumpkin", "Kaju katli"]) expect(markup).not.toContain(`Use the ${name} body`);
    expect(markup).not.toContain(">Halloween<");
    expect(markup).not.toContain(">Diwali<");
  });

  it("offers no facial features row", () => {
    expect(renderCard(makeBot())).not.toContain("data-avatar-face-color");
    expect(renderCard(makeBot({ mascotBody: "cursor" }))).not.toContain("data-avatar-face-color");
  });

  it("marks the current hair pressed, defaulting to Seira", () => {
    if (!HAIR) return;
    expect(renderCard(makeBot())).toContain('aria-pressed="true" aria-label="Use the Seira hair"');
    expect(renderCard(makeBot({ mascotBody: "cursor" }))).toContain('aria-pressed="true" aria-label="Use the Seira hair"');
  });

  it("offers zoom and drag framing for a custom image", () => {
    const markup = renderCard(makeBot({
      avatarUrl: "/api/attachments/cat.webp",
      avatarCrop: "circle",
      avatarZoom: 1.5,
    }));
    expect(markup).toContain('aria-label="Zoom avatar"');
    expect(markup).toContain("Drag the picture to reposition it");
    expect(markup).toContain("150%");
    expect(markup).toContain("Reset framing");
  });

  it("hides zoom controls for the mascot", () => {
    const markup = renderCard(makeBot());
    expect(markup).not.toContain('aria-label="Zoom avatar"');
  });

  it("hides hair, accessories and expressions for every flat crop", () => {
    for (const crop of ["circle", "rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarCrop: crop }));

      expect(markup).not.toContain(">Hair<");
      expect(markup).not.toContain(">Accessories<");
      expect(markup).not.toContain("data-avatar-accessory=");
    }
  });
});

function colorButton(markup: string, color: string): string {
  const tag = markup.match(new RegExp(`<button[^>]*aria-label="Use ${color} mascot color"[^>]*>`))?.[0];
  expect(tag, `${color} color button`).toBeDefined();
  return tag ?? "";
}

describe("BotProfileAvatarCard color picker", () => {
  it("keeps the color picker for a custom photo in every flat crop", () => {
    for (const crop of ["circle", "rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: crop, color: "blue" }));

      expect(markup).toContain(">Color<");
      expect(colorButton(markup, "blue")).toContain('aria-pressed="true"');
      expect(colorButton(markup, "green")).toContain('aria-pressed="false"');
      expect(markup).not.toContain(">Expression<");
    }
  });

  it("lists Color, then Accessories, then Expression for the mascot", () => {
    const markup = renderCard(makeBot());

    expect(markup.indexOf(">Color<")).toBeLessThan(markup.indexOf(">Accessories<"));
    expect(markup.indexOf(">Accessories<")).toBeLessThan(markup.indexOf(">Expression<"));
    expect(markup.match(/data-avatar-accessory="/g)).toHaveLength(MASCOT_ACCESSORY_IDS.length);
    expect(markup).toContain('aria-label="Wear Headset mic"');
    expect(markup).toContain(">Expression<");
    expect(markup).toContain(">Color<");
    expect(markup).toContain('aria-label="Use green mascot color"');
  });

  it("marks the accessories a bot wears as pressed", () => {
    const markup = renderCard(makeBot({ mascotAccessories: ["glasses", "cap"] }));

    expect(markup).toMatch(/aria-pressed="true"[^>]*aria-label="Wear Glasses"/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*aria-label="Wear Cap"/);
    expect(markup).toMatch(/aria-pressed="false"[^>]*aria-label="Wear Scarf"/);
  });
});
