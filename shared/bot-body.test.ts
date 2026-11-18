import { describe, expect, it } from "vitest";

import { BOT_BODY_IDS, DEFAULT_BOT_BODY, PICKER_BODY_IDS, botBodyId, botBodySchema, isBrandBody } from "./bot-body.ts";
import { BRAND_BODY_IDS, CARVED_BODY_IDS } from "./carved-bodies.ts";
import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";

describe("bot bodies", () => {
  it("still parses every stored body id", () => {
    expect(BOT_BODY_IDS).toEqual([...MASCOT_BODY_IDS, ...CARVED_BODY_IDS]);
    for (const id of BOT_BODY_IDS) expect(botBodySchema.safeParse(id).success).toBe(true);
  });

  it("reads every body that is not a Seira look as Seira", () => {
    for (const id of BRAND_BODY_IDS) expect(botBodyId(id)).toBe(id);
    expect(botBodyId("star")).toBe("seira");
    expect(botBodyId("cursor")).toBe("seira");
    expect(botBodyId("pumpkin")).toBe("seira");
    expect(botBodyId("nonsense")).toBe("seira");
    expect(botBodyId(undefined)).toBe("seira");
    expect(DEFAULT_BOT_BODY).toBe("seira");
  });

  it("offers only the Seira looks in the picker, Seira first", () => {
    expect(PICKER_BODY_IDS[0]).toBe("seira");
    expect(PICKER_BODY_IDS).toEqual(BRAND_BODY_IDS);
    for (const id of MASCOT_BODY_IDS) expect(PICKER_BODY_IDS).not.toContain(id);
  });

  it("tells a Seira look from the other bodies", () => {
    expect(isBrandBody("seira")).toBe(true);
    expect(isBrandBody("cursor")).toBe(false);
    expect(isBrandBody(null)).toBe(false);
  });
});
