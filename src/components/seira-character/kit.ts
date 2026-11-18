import type { createBot } from "../../../brand/mascot/runtime/bot.js";
import kit from "../../assets/seira-character/kit.json";

const ASSETS = "../../assets/seira-character/";
const assetUrls = import.meta.glob<string>("../../assets/seira-character/**/*.webp", { query: "?url", import: "default" });

export interface SeiraKit {
  createBot: typeof createBot;
  bases: object;
  stickers: object;
}

async function assetUrl(file: string): Promise<string> {
  const load = assetUrls[ASSETS + file];
  if (!load) throw new Error(`Missing character asset ${file}`);
  return load();
}

async function build(): Promise<SeiraKit> {
  const [runtime, views, hands, fx] = await Promise.all([
    import("../../../brand/mascot/runtime/bot.js"),
    Promise.all(Object.entries(kit.views).map(async ([name, view]) => {
      const [file, hair, visor] = await Promise.all([assetUrl(view.file), assetUrl(view.hair), assetUrl(view.visor)]);
      return [name, { ...view, file, hair, visor }] as const;
    })),
    Promise.all(Object.entries(kit.hands).map(async ([name, hand]) => [name, { ...hand, side: "right", file: await assetUrl(hand.file) }] as const)),
    Promise.all(Object.entries(kit.fx).map(async ([name, sprite]) => [name, { ...sprite, frames: await Promise.all(sprite.frames.map(assetUrl)) }] as const)),
  ]);
  return {
    createBot: runtime.createBot,
    bases: {
      version: 2,
      size: [768, 768],
      styles: { seira: { label: "Seira", gender: "f", recolor: false, views: Object.fromEntries(views) } },
    },
    stickers: { version: 2, hands: Object.fromEntries(hands), accessories: {}, fx: Object.fromEntries(fx) },
  };
}

let pending: Promise<SeiraKit> | undefined;

/** Loads the runtime and the frames once. A failed load can be tried again. */
export function loadSeiraKit(): Promise<SeiraKit> {
  pending ??= build().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}
