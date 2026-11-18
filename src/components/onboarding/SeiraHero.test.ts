// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const seen = vi.hoisted(() => ({ character: [] as Array<Record<string, unknown>>, avatar: [] as Array<Record<string, unknown>> }));
vi.mock("@/components/seira-character", () => ({
  SeiraCharacter: (props: Record<string, unknown>) => { seen.character.push(props); return null; },
}));
vi.mock("@/components/Avatar", () => ({
  BotAvatar: (props: Record<string, unknown>) => { seen.avatar.push(props); return null; },
}));
import { SeiraHero, seiraHair, takeOff } from "./SeiraHero";

const bot = { id: "b1", name: "Ada", color: "green" } as unknown as Bot;

describe("seiraHair", () => {
  it("gives Seira the color of a bot", () => {
    expect(seiraHair("green")).toBe("green");
  });

  it("keeps her own silver hair for the grey colors", () => {
    expect(seiraHair("silver")).toBeUndefined();
    expect(seiraHair("chrome")).toBeUndefined();
  });
});

describe("SeiraHero", () => {
  it("shows the character in the state and size it is given", () => {
    seen.character.length = 0;
    const html = renderToStaticMarkup(createElement(SeiraHero, { bot, state: "greet", size: 120 }));
    expect(seen.character[0]).toMatchObject({ state: "greet", size: 120, hairColor: "green" });
    expect(html).toContain("width:120px;height:120px");
  });

  it("hides a flat stand-in from people and from the pointer", () => {
    const html = renderToStaticMarkup(createElement(SeiraHero, { bot, state: "idle", size: 96 }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("data-flight-stand-in");
    expect(html).toContain("opacity-0");
    expect(seen.avatar.at(-1)).toMatchObject({ bot, size: 96, animated: false, trackPointer: false });
  });
});

describe("takeOff", () => {
  it("shows the stand-in so that the copy of the element is not blank", () => {
    const host = document.createElement("span");
    host.innerHTML = '<canvas></canvas><span data-flight-stand-in="" style="opacity:0"></span>';
    takeOff(host);
    expect(host.querySelector<HTMLElement>("[data-flight-stand-in]")!.style.opacity).toBe("1");
  });

  it("does nothing without an element", () => {
    expect(() => takeOff(null)).not.toThrow();
    expect(() => takeOff(document.createElement("span"))).not.toThrow();
  });
});
