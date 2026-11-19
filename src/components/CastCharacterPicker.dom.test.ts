// @vitest-environment happy-dom
// The cast character picker alone, and inside the welcome's look editor.
import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("./Avatar", () => ({ MausAvatar: () => null, BotAvatar: () => null }));
vi.mock("./AvatarImageGenerator", () => ({ AvatarImageGenerator: () => null }));

const { CastCharacterPicker } = await import("./CastCharacterPicker");
const { MausBotCustomize } = await import("./MausBotCustomize");

let host: HTMLDivElement;
let root: Root;
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
};
const characters = () => [...host.querySelectorAll("[data-cast-character]")];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("CastCharacterPicker", () => {
  const render = (props: Partial<Parameters<typeof CastCharacterPicker>[0]> = {}) => {
    const onPick = vi.fn();
    flushSync(() => root.render(createElement(CastCharacterPicker, { look: { color: "green" }, selectable: true, onPick, ...props })));
    return onPick;
  };

  it("names a group of characters and shows ten of them, then 25 after the toggle", () => {
    render();
    expect(host.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Characters");
    expect(characters()).toHaveLength(10);
    expect(characters().map((button) => button.textContent).slice(0, 3)).toEqual(["Mira", "Lumi", "Rhea"]);
    expect(characters()[0]!.getAttribute("aria-label")).toBe("Use the look of Mira");
    expect(characters()[0]!.getAttribute("title")).toBe("Mira");
    const more = host.querySelector("[data-cast-more]")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.textContent).toBe("Show all 25 characters");
    click(more);
    expect(characters()).toHaveLength(25);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe("Show fewer characters");
    click(more);
    expect(characters()).toHaveLength(10);
  });

  it("sends the whole look of the character that is pressed", () => {
    const onPick = render();
    click(host.querySelector('[data-cast-character="kiri"]'));
    expect(onPick).toHaveBeenCalledWith({ color: "red", mascotBody: "long-wavy", mascotAccessories: ["earring", "hairpin"] });
  });

  it("presses the worn character, in any accessory order", () => {
    render({ look: { color: "red", mascotBody: "ponytail", mascotAccessories: ["earring", "glasses"] } });
    expect(characters().filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.getAttribute("data-cast-character"))).toEqual(["rhea"]);
  });

  it("presses nothing when the bot shows a picture", () => {
    render({ look: { color: "red", mascotBody: "ponytail", mascotAccessories: ["earring", "glasses"] }, selectable: false });
    expect(characters().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("starts open when the worn character is past the first ten", () => {
    render({ look: { color: "yellow", mascotBody: "center-part", mascotAccessories: ["glasses", "bowtie"] } });
    expect(characters()).toHaveLength(25);
    expect(host.querySelector('[data-cast-character="ellis"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("[data-cast-more]")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("does nothing while disabled", () => {
    const onPick = render({ disabled: true });
    expect(characters().every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    click(characters()[0]!);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("the welcome look editor", () => {
  const preview = { id: "p", threadId: "t", name: "Seira", title: "", description: "", notifications: false, color: "green", unread: false,
    modelSelection: { instanceId: "claude", model: "m" }, messages: [] } as Bot;
  const render = (bot: Bot) => {
    const onPatch = vi.fn();
    const image = { fileRef: createRef<HTMLInputElement>(), busy: false, uploading: false, generating: false, error: null, upload: vi.fn(), removeImage: vi.fn(), generate: vi.fn() };
    flushSync(() => root.render(createElement(MausBotCustomize, {
      preview: bot, name: "", nameRef: createRef<HTMLInputElement>(), image: image as never, onName: vi.fn(), onPatch,
    })));
    return onPatch;
  };

  it("puts the characters above the hair and sends the look with the mascot crop", () => {
    const onPatch = render(preview);
    const group = host.querySelector('[role="group"][aria-label="Characters"]')!;
    const hair = host.querySelector("[data-mausbot-welcome-body]");
    if (hair) expect(group.compareDocumentPosition(hair) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(characters()).toHaveLength(10);
    click(host.querySelector('[data-cast-character="pippa"]'));
    expect(onPatch).toHaveBeenCalledWith({ color: "coral", mascotBody: "twin-tails", mascotAccessories: ["ribbon"], avatarCrop: "mascot" });
  });

  it("presses the worn character, and none while a picture shows", () => {
    render({ ...preview, color: "teal", mascotBody: "short-neat", mascotAccessories: ["glasses", "headphones"] } as Bot);
    expect(host.querySelector('[data-cast-character="bix"]')!.getAttribute("aria-pressed")).toBe("true");
    render({ ...preview, color: "teal", mascotBody: "short-neat", mascotAccessories: ["glasses", "headphones"], avatarUrl: "/a.png", avatarCrop: "circle" } as Bot);
    expect(characters().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
  });
});
