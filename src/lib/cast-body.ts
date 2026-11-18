import { sizedImages, steelBodyImage, type SteelImage } from "./steel-body";

// The cast's rendered heads with an empty visor, cropped to the flat body's 240-unit square:
// src/assets/cast-body/<id>/front-<px>.webp, hair in the preset's own colour. Beside each one, hair-<px>.webp is the hair
// alone in neutral grey, for the bot-colour tint. brand/mascot/cast/tools/avatars.py makes both.
const files = import.meta.glob<string>("../assets/cast-body/*/*.webp", { eager: true, query: "?url", import: "default" });

const grouped: Record<string, Record<string, string>> = {};
for (const [path, url] of Object.entries(files)) {
  const id = /\/cast-body\/([a-z]+)\//.exec(path)?.[1];
  if (id) (grouped[id] ??= {})[path] = url;
}
const IMAGES = new Map<string, SteelImage[]>(Object.entries(grouped).map(([id, own]) => [id, sizedImages(own)]));

export interface CastPictures { head: string; hair: string }

export function castPictures(body: string, size: number, density: number): CastPictures | null {
  const images = IMAGES.get(body);
  if (!images) return null;
  const head = steelBodyImage("front", size, density, images);
  const hair = steelBodyImage("hair", size, density, images);
  return head && hair ? { head, hair } : null;
}

// The grey hair stores shade / SMAX. Above shade 1 a highlight rises to PMAX, as in brand/mascot/runtime/recolor.js.
// avatars.py uses the same two values.
const SMAX = 1.2;
const PMAX = 0.3;
const STEPS = 12;

/** Gradient-map tables (red, green, blue) that turn the grey hair into hair of `hex`, highlights included. */
export function castHairMap(hex: string): [string, string, string] {
  const n = Number.parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const table = (t: number) => Array.from({ length: STEPS + 1 }, (_, i) => {
    const shade = (i / STEPS) * SMAX;
    const spec = PMAX * Math.max(0, Math.min(1, (shade - 1) / (SMAX - 1)));
    return Math.round((Math.min(1, t * shade) * (1 - spec) + spec) * 1000) / 1000;
  }).join(" ");
  return [table(rgb[0]!), table(rgb[1]!), table(rgb[2]!)];
}
