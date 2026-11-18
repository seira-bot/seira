import { describe, expect, it } from "vitest";

import { BOT_BODY_IDS, DEFAULT_BOT_BODY, FESTIVAL_IDS, FESTIVALS, PICKER_BODY_IDS, botBodyId, botBodySchema, isBrandBody, isCarvedBody, isFestival, isFestivalBody } from "./bot-body.ts";
import { BRAND_BODY_IDS, CARVED_BODY_IDS, DIWALI_BODY_IDS, HALLOWEEN_BODY_IDS } from "./carved-bodies.ts";
import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";
import { MAUS_COLOR_NAMES } from "./wire.ts";

describe("bot bodies", () => {
  it("accepts every gradient body and every festival body", () => {
    expect(BOT_BODY_IDS).toEqual([...MASCOT_BODY_IDS, ...CARVED_BODY_IDS]);
    for (const id of BOT_BODY_IDS) expect(botBodySchema.safeParse(id).success).toBe(true);
  });

  it("falls back to Seira for anything it does not know", () => {
    expect(botBodyId("pumpkin")).toBe("pumpkin");
    expect(botBodyId("laddu")).toBe("laddu");
    expect(botBodyId("star")).toBe("star");
    expect(botBodyId("hexagram")).toBe("seira");
    expect(botBodyId("nonsense")).toBe("seira");
    expect(botBodyId(undefined)).toBe("seira");
    expect(DEFAULT_BOT_BODY).toBe("seira");
  });

  it("shows Seira first in the picker, then the gradient bodies", () => {
    expect(PICKER_BODY_IDS[0]).toBe("seira");
    expect(PICKER_BODY_IDS).toEqual([...BRAND_BODY_IDS, ...MASCOT_BODY_IDS]);
  });

  it("tells the brand body and the festival bodies apart", () => {
    expect(isBrandBody("seira")).toBe(true);
    expect(isBrandBody("pumpkin")).toBe(false);
    expect(isBrandBody("cursor")).toBe(false);
    expect(isFestivalBody("seira")).toBe(false);
    expect(isFestivalBody("cursor")).toBe(false);
    expect(isFestivalBody("pumpkin")).toBe(true);
    expect(isFestivalBody("laddu")).toBe(true);
    for (const id of [...HALLOWEEN_BODY_IDS, ...DIWALI_BODY_IDS]) expect(isFestivalBody(id)).toBe(true);
  });

  it("tells the festival bodies apart", () => {
    expect(isCarvedBody("ghost")).toBe(true);
    expect(isCarvedBody("jalebi")).toBe(true);
    expect(isCarvedBody("cursor")).toBe(false);
    expect(isCarvedBody(null)).toBe(false);
  });

  it("splits the festival bodies between the festivals, one pack each", () => {
    expect(FESTIVAL_IDS).toEqual(["halloween", "diwali"]);
    expect(FESTIVAL_IDS.flatMap((festival) => FESTIVALS[festival].bodies)).toEqual([...HALLOWEEN_BODY_IDS, ...DIWALI_BODY_IDS]);
    expect(isFestival("diwali")).toBe(true);
    expect(isFestival("midnight")).toBe(false);
    expect(isFestival("toString")).toBe(false);
  });

  it.each(FESTIVAL_IDS)("gives every bot colour but silver and chrome its own %s costume from that festival", (festival) => {
    const { bodies, costumes } = FESTIVALS[festival];
    const dressed = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
    expect(Object.keys(costumes).sort()).toEqual([...dressed].sort());
    expect(new Set(Object.values(costumes)).size).toBe(dressed.length);
    for (const body of Object.values(costumes)) expect(bodies).toContain(body);
  });
});
