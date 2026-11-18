import { describe, expect, it } from "vitest";

import { locales } from "./index";

const OLD_NAME = /(?<![A-Za-z0-9])(?:Open)?MausBot(?![A-Za-z0-9])/;

describe("the product name", () => {
  it("is Seira in every language, never MausBot or OpenMausBot", () => {
    const offending = Object.entries(locales).flatMap(([code, pack]) =>
      Object.entries(pack)
        .filter(([, value]) => OLD_NAME.test(value ?? ""))
        .map(([key]) => `${code}: ${key}`));
    expect(offending).toEqual([]);
  });
});
