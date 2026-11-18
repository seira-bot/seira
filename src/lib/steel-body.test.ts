import { describe, expect, it } from "vitest";

import { steelBodyImage, type SteelImage } from "./steel-body";

const images: SteelImage[] = [40, 56, 88, 128, 192, 256].map((px) => ({ body: "cursor", px, url: `/steel/cursor-${px}.webp` }));

describe("Seira's rendered steel body", () => {
  it("picks the smallest image with a device pixel for every pixel drawn, from the popup down to the cursor", () => {
    expect(steelBodyImage("cursor", 20, 2, images)).toBe("/steel/cursor-40.webp");
    expect(steelBodyImage("cursor", 28, 2, images)).toBe("/steel/cursor-56.webp");
    expect(steelBodyImage("cursor", 44, 1, images)).toBe("/steel/cursor-56.webp");
    expect(steelBodyImage("cursor", 96, 2, images)).toBe("/steel/cursor-192.webp");
    expect(steelBodyImage("cursor", 112, 3, images)).toBe("/steel/cursor-256.webp");
    expect(steelBodyImage("cursor", 28, 0, images)).toBe("/steel/cursor-40.webp");
  });

  it("keeps the drawn steel for a body with no images", () => {
    expect(steelBodyImage("circle", 44, 2, images)).toBeNull();
    expect(steelBodyImage("cursor", 44, 2, [])).toBeNull();
  });
});
