import { afterEach, describe, expect, it } from "vitest";

import { BOT_BODY_IDS } from "../../shared/bot-body";
import { MASCOT_ACCESSORY_IDS } from "../../shared/mascot-accessories";
import { en, locales } from "@/locales";
import { setLocale } from "./i18n";
import { MAUS_COLOR_NAMES, PICKABLE_STATES } from "./mascot";
import { bodyName, colorName, expressionName } from "./mascot-names";

afterEach(() => {
  setLocale("en");
});

describe("mascot names", () => {
  const keys = [
    ...BOT_BODY_IDS.map((id) => `mascot.body.${id}`),
    ...MASCOT_ACCESSORY_IDS.map((id) => `mascot.accessory.${id}`),
    ...MAUS_COLOR_NAMES.map((color) => `mascot.color.${color}`),
    ...PICKABLE_STATES.map((state) => `mascot.expression.${state}`),
  ];

  it("has an English and a Brazilian Portuguese name for every body, colour and face the pickers show", () => {
    for (const key of keys) {
      expect(Object.hasOwn(en, key), key).toBe(true);
      expect(Object.hasOwn(locales["pt-br"]!, key), key).toBe(true);
    }
  });

  it("reads the names in the app language", () => {
    expect([bodyName("pumpkin"), colorName("red"), expressionName("happy")]).toEqual(["Pumpkin", "red", "happy"]);
    setLocale("pt-br");
    expect([bodyName("pumpkin"), colorName("red"), expressionName("happy")]).toEqual(["Abóbora", "vermelha", "feliz"]);
  });

  it("falls back to the id or name it was given when the catalog has none", () => {
    expect(expressionName("unknown-face")).toBe("unknown-face");
  });
});
