import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotCharacter, TurnFace } from "./BotCharacter";

const fallback = createElement("i", { "data-fallback": "" });
const render = (bot: Parameters<typeof BotCharacter>[0]["bot"], state: "idle" | "sleep" = "idle") =>
  renderToStaticMarkup(createElement(BotCharacter, { bot, state, size: 96, fallback }));

describe("BotCharacter", () => {
  it("draws Seira's character for a bot with the shipped body and no picture", () => {
    const markup = render({ color: "blue" });
    expect(markup).toContain('data-seira-state="idle"');
    expect(markup).not.toContain("data-fallback");
  });

  it("keeps the bot's own face when it has an uploaded picture or another body", () => {
    expect(render({ color: "blue", avatarUrl: "/api/attachments/b.png", avatarCrop: "circle" })).toContain("data-fallback");
    expect(render({ color: "blue", mascotBody: "cursor" })).toContain("data-fallback");
  });

  it("treats a picture cropped as the mascot as no picture", () => {
    expect(render({ color: "blue", avatarUrl: "/api/attachments/b.png", avatarCrop: "mascot" })).toContain('data-seira-state="idle"');
  });

  it("follows the state it is given", () => {
    expect(render({ color: "green" }, "sleep")).toContain('data-seira-state="sleep"');
  });
});

describe("TurnFace", () => {
  it("works while a tool runs and thinks otherwise", () => {
    expect(renderToStaticMarkup(createElement(TurnFace, { bot: { color: "green" }, working: true, size: 36 }))).toContain('data-seira-state="working"');
    expect(renderToStaticMarkup(createElement(TurnFace, { bot: { color: "green" }, working: false, size: 36 }))).toContain('data-seira-state="thinking"');
  });
});
