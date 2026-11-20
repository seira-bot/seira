import { describe, expect, it } from "vitest";

import { locales } from "./index";

const OLD_PRODUCT = /(?<![A-Za-z0-9])(?:OpenMaus|MausBot)|maus\.example/i;
const OLD_BOT_WORD = /(?<![A-Za-z0-9])Maus(?![A-Za-z0-9])/;
const LANGUAGES_WHERE_MAUS_MEANS_MOUSE = new Set(["de"]);

describe("the product name", () => {
  it("is Seira in every language, never an upstream name or example domain", () => {
    const offending = Object.entries(locales).flatMap(([code, pack]) =>
      Object.entries(pack)
        .filter(([, value]) => OLD_PRODUCT.test(value ?? "")
          || (!LANGUAGES_WHERE_MAUS_MEANS_MOUSE.has(code) && OLD_BOT_WORD.test(value ?? "")))
        .map(([key]) => `${code}: ${key}`));
    expect(offending).toEqual([]);
  });
});
