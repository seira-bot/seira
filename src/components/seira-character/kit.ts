import type { createBot } from "../../../brand/mascot/runtime/bot.js";
import kit from "../../assets/seira-character/kit.json";
import placement from "../../assets/seira-accessory/placement.json";

const FRAMES = "../../assets/seira-character/";
const SPRITES = "../../assets/seira-accessory/";
const frameUrls = import.meta.glob<string>("../../assets/seira-character/**/*.webp", { eager: true, query: "?url", import: "default" });
const spriteUrls = import.meta.glob<string>("../../assets/seira-accessory/*.webp", { eager: true, query: "?url", import: "default" });

export interface SeiraKit {
  createBot: typeof createBot;
  bases: object;
  stickers: object;
}

interface ViewJson {
  file: string;
  hair?: string;
  visor: string;
  pivot: number[];
  r: number;
  visorBox: number[];
  measuredYaw: number;
  anchors: Record<string, number[]>;
}

interface AccessoryJson {
  file: string;
  files?: Record<string, string>;
}

function urlOf(urls: Record<string, string>, base: string, file: string): string {
  const url = urls[base + file];
  if (!url) throw new Error(`Missing character asset ${file}`);
  return url;
}

function styleOf(style: { label: string; recolor: boolean; views: Record<string, ViewJson> }) {
  const views = Object.entries(style.views).map(([name, view]) => [name, {
    ...view,
    file: urlOf(frameUrls, FRAMES, view.file),
    hair: view.hair ? urlOf(frameUrls, FRAMES, view.hair) : undefined,
    visor: urlOf(frameUrls, FRAMES, view.visor),
  }] as const);
  return { label: style.label, gender: "f", recolor: style.recolor, views: Object.fromEntries(views) };
}

function accessoryOf(accessory: AccessoryJson) {
  const files = Object.entries(accessory.files ?? {}).map(([view, file]) => [view, urlOf(spriteUrls, SPRITES, file)] as const);
  return { ...accessory, file: urlOf(spriteUrls, SPRITES, accessory.file), files: Object.fromEntries(files) };
}

async function build(): Promise<SeiraKit> {
  const runtime = await import("../../../brand/mascot/runtime/bot.js");
  const hands = Object.entries(kit.hands).map(([name, hand]) => [name, { ...hand, side: "right", file: urlOf(frameUrls, FRAMES, hand.file) }] as const);
  const fx = Object.entries(kit.fx).map(([name, sprite]) => [name, { ...sprite, frames: sprite.frames.map((file) => urlOf(frameUrls, FRAMES, file)) }] as const);
  const accessories = Object.entries(placement.accessories as Record<string, AccessoryJson>).map(([id, accessory]) => [id, accessoryOf(accessory)] as const);
  const styles = Object.entries(kit.styles as Record<string, { label: string; recolor: boolean; views: Record<string, ViewJson> }>)
    .map(([id, style]) => [id, styleOf(style)] as const);
  return {
    createBot: runtime.createBot,
    bases: { version: 2, size: [768, 768], styles: Object.fromEntries(styles) },
    stickers: { version: 2, hands: Object.fromEntries(hands), accessories: Object.fromEntries(accessories), fx: Object.fromEntries(fx) },
  };
}

let pending: Promise<SeiraKit> | undefined;

/** Loads the runtime once. The runtime loads the images of the style that the bot wears. A failed load can be tried again. */
export function loadSeiraKit(): Promise<SeiraKit> {
  pending ??= build().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
