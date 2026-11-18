import { describe, expect, it } from "vitest";

import { MASCOT_ACCESSORIES, MASCOT_ACCESSORY_IDS, MAX_MASCOT_ACCESSORIES, mascotAccessories, mascotAccessoriesSchema, toggleMascotAccessory } from "./mascot-accessories.ts";

describe("mascot accessories", () => {
  it("keeps known ids, the first one in each slot, and at most three", () => {
    expect(mascotAccessories(["glasses", "sunglasses", "cap", "nope", "scarf", "earring"])).toEqual(["glasses", "cap", "scarf"]);
    expect(mascotAccessories("glasses")).toEqual([]);
    expect(mascotAccessories(null)).toEqual([]);
    expect(mascotAccessories(["toString"])).toEqual([]);
  });

  it("validates a list for the wire", () => {
    expect(mascotAccessoriesSchema.safeParse(["glasses", "cap"]).success).toBe(true);
    expect(mascotAccessoriesSchema.safeParse(["glasses", "sunglasses"]).success).toBe(false);
    expect(mascotAccessoriesSchema.safeParse(["glasses", "cap", "scarf", "earring"]).success).toBe(false);
    expect(mascotAccessoriesSchema.safeParse(["crown"]).success).toBe(false);
  });

  it("replaces the accessory in the same slot and takes one off when it is on", () => {
    expect(toggleMascotAccessory([], "glasses")).toEqual(["glasses"]);
    expect(toggleMascotAccessory(["glasses"], "sunglasses")).toEqual(["sunglasses"]);
    expect(toggleMascotAccessory(["glasses", "cap"], "glasses")).toEqual(["cap"]);
  });

  it("drops the oldest accessory past the limit", () => {
    expect(toggleMascotAccessory(["glasses", "cap", "scarf"], "earring")).toEqual(["cap", "scarf", "earring"]);
    expect(MAX_MASCOT_ACCESSORIES).toBe(3);
  });

  it("gives every accessory one slot", () => {
    expect(MASCOT_ACCESSORY_IDS).toHaveLength(12);
    for (const id of MASCOT_ACCESSORY_IDS) expect(["face", "ear", "hair", "top", "neck"]).toContain(MASCOT_ACCESSORIES[id]);
  });
});
