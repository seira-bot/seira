import { sizedImages, steelBodyImage } from "./steel-body";

// Seira's rendered head with an empty visor, cropped to the flat body's 240-unit square: src/assets/seira-body/front-<px>.webp,
// and the hair mask at the same crop: hair-<px>.png (white is hair).
const files = import.meta.glob<string>("../assets/seira-body/*.{webp,png}", { eager: true, query: "?url", import: "default" });
const IMAGES = sizedImages(files);

export interface SeiraPictures { head: string; hair: string }

/** The pictures for an avatar `size` CSS pixels wide, or null when the build has none. */
export function seiraPictures(size: number, density: number): SeiraPictures | null {
  const head = steelBodyImage("front", size, density, IMAGES);
  const hair = steelBodyImage("hair", size, density, IMAGES);
  return head && hair ? { head, hair } : null;
}
