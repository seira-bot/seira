import placement from "../assets/seira-accessory/placement.json";
import { mascotAccessories, type MascotAccessoryId } from "../../shared/mascot-accessories";

// The accessory stickers of brand/mascot/art/stickers as src/assets/seira-accessory/<id>.webp, and placement.json:
// the head radius and the named points of each hair style in the flat body's 240-unit square, and each sticker's
// anchor, width (in head radii), pivot, and size. brand/mascot/cast/tools/avatars.py makes both.
const files = import.meta.glob<string>("../assets/seira-accessory/*.webp", { eager: true, query: "?url", import: "default" });

// Points are [x, y].
interface StylePlacement { r: number; anchors: Partial<Record<string, number[]>> }
interface StickerPlacement { anchor?: string; width?: number; pivot?: number[]; size: number[]; file: string }

const STYLES = placement.styles as Record<string, StylePlacement>;
const STICKERS = placement.accessories as Record<string, StickerPlacement>;

/** The flat avatar's own drawing box, glow and lean included. */
export const AVATAR_BOX = { x: -14, y: -14, side: 268 } as const;

export interface AccessorySprite {
  id: MascotAccessoryId;
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The accessories on hair style `style`, in the 240-unit square, in draw order. The "eyes" anchor is the centre of
 * the eye pair `eyes`, so glasses sit on the eyes that the avatar draws. A style without placement gets none. */
export function accessorySprites(style: string, ids: readonly MascotAccessoryId[], eyes: { cx: number; cy: number }): AccessorySprite[] {
  const head = STYLES[style];
  if (!head) return [];
  return mascotAccessories(ids).flatMap((id) => {
    const sticker = STICKERS[id];
    const href = sticker && files[`../assets/seira-accessory/${sticker.file}`];
    if (!sticker || !href) return [];
    const anchor = sticker.anchor ?? "top";
    const [ax, ay] = anchor === "eyes" ? [eyes.cx, eyes.cy] : head.anchors[anchor] ?? [];
    if (ax === undefined || ay === undefined) return [];
    const [w = 1, h = 1] = sticker.size;
    const scale = ((sticker.width ?? 1) * head.r) / w;
    const [px = w / 2, py = h / 2] = sticker.pivot ?? [];
    return [{ id, href, x: r2(ax - px * scale), y: r2(ay - py * scale), width: r2(w * scale), height: r2(h * scale) }];
  });
}

/** The square viewBox that shows the avatar box and every sprite: the head stays centred across, and only grows smaller
 * when a sprite reaches out of the avatar box. */
export function spritesViewBox(sprites: readonly AccessorySprite[]): string {
  const { x, y, side } = AVATAR_BOX;
  if (!sprites.length) return `${x} ${y} ${side} ${side}`;
  const centre = x + side / 2;
  const minX = Math.min(x, ...sprites.map((s) => s.x));
  const maxX = Math.max(x + side, ...sprites.map((s) => s.x + s.width));
  const minY = Math.min(y, ...sprites.map((s) => s.y));
  const maxY = Math.max(y + side, ...sprites.map((s) => s.y + s.height));
  const width = 2 * Math.max(centre - minX, maxX - centre);
  const fit = Math.max(width, maxY - minY);
  return `${r2(centre - fit / 2)} ${r2(minY - (fit - (maxY - minY)) / 2)} ${r2(fit)} ${r2(fit)}`;
}
