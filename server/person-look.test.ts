import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAST_CHARACTERS } from "../shared/cast-characters.ts";
import { personLookSchema, randomPersonLook } from "../shared/person-look.ts";
import { DATA_DIR, loadConfig, parseConfigPatch } from "./config.ts";
import { ensureProfileLook } from "./person-look.ts";

const file = join(DATA_DIR, "config.json");

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ profile: { name: "Ada" } }));
});
afterEach(() => rmSync(file, { force: true }));

describe("the person's default look", () => {
  it("picks a look from the bot avatar parts on the first start and saves it beside the rest of the profile", () => {
    const cfg = loadConfig();
    ensureProfileLook(cfg, { random: () => 0 });
    expect(cfg.profile?.look).toEqual({ mascotBody: CAST_CHARACTERS[0]!.mascotBody, mascotAccessories: [...CAST_CHARACTERS[0]!.mascotAccessories], color: CAST_CHARACTERS[0]!.color });
    expect(loadConfig().profile).toEqual({ name: "Ada", look: cfg.profile?.look });
  });

  it("keeps the same look across restarts, whatever the dice say", () => {
    ensureProfileLook(loadConfig(), { random: () => 0 });
    const first = loadConfig().profile?.look;
    const restarted = loadConfig();
    ensureProfileLook(restarted, { random: () => 0.99 });
    expect(restarted.profile?.look).toEqual(first);
    expect(loadConfig().profile?.look).toEqual(first);
  });

  it("starts without a look when the file cannot be saved", () => {
    const cfg = loadConfig();
    ensureProfileLook(cfg, { save: () => { throw new Error("read-only"); } });
    expect(cfg.profile?.look).toBeUndefined();
  });

  it("accepts only parts a bot can wear", () => {
    const generated = randomPersonLook(() => 0.5);
    const look = JSON.parse(JSON.stringify(generated));
    expect(parseConfigPatch({ profile: { look } })).toEqual({ profile: { look } });
    expect(personLookSchema.safeParse({ ...look, color: "plaid" }).success).toBe(false);
    expect(personLookSchema.safeParse({ ...look, mascotBody: "dragon" }).success).toBe(false);
  });

  it("shuffles to a look that differs from the current one", () => {
    for (const character of CAST_CHARACTERS) {
      const current = { mascotBody: character.mascotBody, mascotAccessories: [...character.mascotAccessories], color: character.color };
      for (const dice of [0, 0.5, 0.999]) expect(randomPersonLook(() => dice, current)).not.toEqual(current);
    }
  });
});
