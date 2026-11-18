import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BotCharacter, TurnFace } from "./BotCharacter";

vi.mock("./seira-character", () => ({
  SeiraCharacter: (props: { state: string; hairStyle?: string; accessories?: readonly string[] }) =>
    createElement("canvas", {
      "data-seira-state": props.state,
      "data-hair-style": props.hairStyle,
      "data-accessories": props.accessories?.join(","),
    }),
}));

const fallback = createElement("i", { "data-fallback": "" });
const render = (bot: Parameters<typeof BotCharacter>[0]["bot"], state: "idle" | "sleep" = "idle") =>
  renderToStaticMarkup(createElement(BotCharacter, { bot, state, size: 96, fallback }));

describe("BotCharacter", () => {
  it("draws Seira's character for a bot with the shipped body and no picture", () => {
    const markup = render({ color: "blue" });
    expect(markup).toContain('data-seira-state="idle"');
    expect(markup).not.toContain("data-fallback");
  });

  it("keeps the bot's own face when it has an uploaded picture", () => {
    expect(render({ color: "blue", avatarUrl: "/api/attachments/b.png", avatarCrop: "circle" })).toContain("data-fallback");
  });

  it("draws every Seira hair style, and reads an unknown body as Seira", () => {
    expect(render({ color: "blue", mascotBody: "bob" })).toContain('data-seira-state="idle"');
    expect(render({ color: "blue", mascotBody: "none" })).toContain('data-seira-state="idle"');
    const old = render({ color: "blue", mascotBody: "cursor" });
    expect(old).toContain('data-hair-style="seira"');
    expect(old).not.toContain("data-fallback");
  });

  it("passes the hair style and the accessories of the bot to the character", () => {
    const markup = render({ color: "blue", mascotBody: "bob", mascotAccessories: ["glasses"] });
    expect(markup).toContain('data-hair-style="bob"');
    expect(markup).toContain('data-accessories="glasses"');
    expect(markup).not.toContain("data-fallback");
  });

  it("gives Seira's own style and no accessories to a bot without a look", () => {
    const markup = render({ color: "blue" });
    expect(markup).toContain('data-hair-style="seira"');
    expect(markup).toContain('data-accessories=""');
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
