import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CAST_CHARACTERS, castCharacterOf } from "./cast-characters.ts";
import { mascotAccessories } from "./mascot-accessories.ts";
import { SEIRA_COLOR_NAMES } from "./wire.ts";

interface Preset {
  id: string;
  name: string;
  style: string;
  accessories: string[];
}

const presets = (JSON.parse(readFileSync(new URL("../brand/mascot/cast/cast.json", import.meta.url), "utf8")) as Preset[])
  .filter((preset) => preset.id !== "seira");

describe("cast characters", () => {
  it("has one entry per cast preset without Seira", () => {
    expect(CAST_CHARACTERS).toHaveLength(25);
    expect(new Set(CAST_CHARACTERS.map((character) => character.id)).size).toBe(CAST_CHARACTERS.length);
    expect(CAST_CHARACTERS.map((character) => character.id).sort()).toEqual(presets.map((preset) => preset.id).sort());
  });

  it("matches the cast file", () => {
    for (const preset of presets) {
      const character = CAST_CHARACTERS.find((entry) => entry.id === preset.id);
      expect(character, preset.id).toBeDefined();
      expect(character!.name).toBe(preset.name);
      expect(character!.mascotBody).toBe(preset.style);
      for (const accessory of character!.mascotAccessories) expect(preset.accessories).toContain(accessory);
      if (preset.accessories.length > 0) expect(character!.mascotAccessories.length).toBeGreaterThan(0);
    }
  });

  it("wears only valid accessories and colours", () => {
    for (const character of CAST_CHARACTERS) {
      expect(mascotAccessories([...character.mascotAccessories])).toEqual(character.mascotAccessories);
      expect(SEIRA_COLOR_NAMES).toContain(character.color);
    }
  });

  it("finds a character from its look, in any accessory order", () => {
    for (const character of CAST_CHARACTERS) {
      const look = { color: character.color, mascotBody: character.mascotBody, mascotAccessories: [...character.mascotAccessories] };
      expect(castCharacterOf(look)?.id).toBe(character.id);
      expect(castCharacterOf({ ...look, mascotAccessories: [...look.mascotAccessories].reverse() })?.id).toBe(character.id);
    }
  });

  it("returns null for a look that is not a character", () => {
    const rhea = CAST_CHARACTERS.find((character) => character.id === "rhea")!;
    expect(castCharacterOf({ color: "green", mascotBody: rhea.mascotBody, mascotAccessories: ["glasses", "earring"] })).toBeNull();
    expect(castCharacterOf({ color: rhea.color, mascotBody: rhea.mascotBody, mascotAccessories: ["glasses"] })).toBeNull();
    expect(castCharacterOf({ color: rhea.color, mascotBody: null, mascotAccessories: null })).toBeNull();
  });
});
