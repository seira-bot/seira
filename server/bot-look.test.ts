import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BRAND_BODY_IDS } from "../shared/carved-bodies.ts";
import { mascotAccessories } from "../shared/mascot-accessories.ts";
import { freshLook, giveCharactersOnce, STARTER_CHARACTERS, STARTER_COLORS, wearsPlainLook } from "./bot-look.ts";

describe("a new bot's first look", () => {
  it("is a cast character, never Seira's own hair or a metal colour", () => {
    expect(STARTER_COLORS).not.toContain("silver");
    expect(STARTER_COLORS).not.toContain("chrome");
    for (const character of STARTER_CHARACTERS) {
      expect(BRAND_BODY_IDS).toContain(character.mascotBody);
      expect(character.mascotBody).not.toBe("seira");
      expect(mascotAccessories(character.mascotAccessories)).toEqual(character.mascotAccessories);
    }
    for (const roll of [0, 0.5, 0.999]) expect(freshLook([], () => roll).mascotBody).not.toBe("seira");
  });

  it("picks its colour at random, preferring one no bot here wears yet", () => {
    expect(freshLook([], () => 0).color).not.toBe(freshLook([], () => 0.999).color);
    const worn = [{ color: "red" as const }, { color: "blue" as const }];
    for (const roll of [0, 0.3, 0.6, 0.999]) expect(["red", "blue"]).not.toContain(freshLook(worn, () => roll).color);
  });

  it("picks a hair style no bot here wears yet while one is left", () => {
    expect(freshLook([], () => 0).mascotBody).not.toBe(freshLook([], () => 0.999).mascotBody);
    const bots: Array<{ color: "green"; mascotBody: string; mascotAccessories: string[] }> = [];
    const styles = new Set(STARTER_CHARACTERS.map((character) => character.mascotBody));
    for (let i = 0; i < styles.size; i++) {
      const look = freshLook(bots, Math.random);
      expect(bots.map((bot) => bot.mascotBody)).not.toContain(look.mascotBody);
      bots.push({ color: "green", mascotBody: look.mascotBody, mascotAccessories: look.mascotAccessories });
    }
    expect(new Set(bots.map((bot) => bot.mascotBody))).toEqual(styles);
  });

  it("then picks a character no bot here wears yet", () => {
    const bots = STARTER_CHARACTERS.slice(0, -1).map((character) => ({ color: "green" as const, ...character }));
    const last = STARTER_CHARACTERS.at(-1)!;
    for (const roll of [0, 0.5, 0.999]) expect(freshLook(bots, () => roll)).toMatchObject(last);
  });
});

describe("the plain look older builds gave", () => {
  it("is no hair, the old triangle, or Seira's hair, with no accessories and no picture", () => {
    for (const mascotBody of [undefined, null, "cursor", "seira"]) expect(wearsPlainLook({ color: "red", mascotBody })).toBe(true);
    expect(wearsPlainLook({ color: "red", mascotBody: "bob" })).toBe(false);
    expect(wearsPlainLook({ color: "red", mascotBody: "blob" })).toBe(false);
    expect(wearsPlainLook({ color: "red", mascotBody: "seira", mascotAccessories: ["cap"] })).toBe(false);
    expect(wearsPlainLook({ color: "red", avatarUrl: "/api/attachments/a.png" })).toBe(false);
  });

  it("is never the Seira's", () => {
    expect(wearsPlainLook({ color: "chrome", defaultBot: {} })).toBe(false);
  });
});

describe("giving plain bots a character", () => {
  const dirs: string[] = [];
  const dataDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-bot-look-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("gives each plain bot its own hair style once, and saves before it marks the folder", () => {
    const dir = dataDir();
    const bots = [
      { color: "red" as const },
      { color: "blue" as const, mascotBody: "seira" },
      { color: "green" as const, mascotBody: "bob", mascotAccessories: ["headset-mic"] },
      { color: "pink" as const, home: {} },
    ];
    const saves: Array<[boolean, boolean]> = [];
    giveCharactersOnce(bots, dir, true, (changed) => saves.push([changed, existsSync(join(dir, "characters-given"))]));
    expect(saves).toEqual([[true, false]]);
    expect(existsSync(join(dir, "characters-given"))).toBe(true);
    expect(new Set(bots.slice(0, 3).map((bot) => bot.mascotBody)).size).toBe(3);
    expect(bots[2]).toMatchObject({ mascotBody: "bob", mascotAccessories: ["headset-mic"] });
    expect(bots[3]).not.toHaveProperty("mascotBody");
    const again = bots.map((bot) => ({ ...bot }));
    giveCharactersOnce(bots, dir, true, (changed) => saves.push([changed, true]));
    expect(saves.at(-1)).toEqual([false, true]);
    expect(bots).toEqual(again);
  });

  it("tries again on the next start when the bots could not be read or saved", () => {
    const dir = dataDir();
    const saves: boolean[] = [];
    giveCharactersOnce([{ color: "red" }], dir, false, (changed) => saves.push(changed));
    expect(saves).toEqual([false]);
    expect(() => giveCharactersOnce([{ color: "red" }], dir, true, () => { throw new Error("fixture disk full"); })).toThrow("fixture disk full");
    expect(existsSync(join(dir, "characters-given"))).toBe(false);
  });
});
