import { z } from "zod";

/** The accessories a Seira look can wear, each in one slot. The ids match the sticker art in brand/mascot/art/stickers. */
export const MASCOT_ACCESSORIES = {
  glasses: "face",
  sunglasses: "face",
  earring: "ear",
  headphones: "ear",
  "headset-mic": "ear",
  ribbon: "hair",
  hairpin: "hair",
  tiara: "hair",
  cap: "top",
  antenna: "top",
  scarf: "neck",
  bowtie: "neck",
} as const;

export type MascotAccessoryId = keyof typeof MASCOT_ACCESSORIES;
export type MascotAccessorySlot = (typeof MASCOT_ACCESSORIES)[MascotAccessoryId];

export const MASCOT_ACCESSORY_IDS = Object.keys(MASCOT_ACCESSORIES) as [MascotAccessoryId, ...MascotAccessoryId[]];

/** A look wears at most this many accessories, and at most one in each slot. */
export const MAX_MASCOT_ACCESSORIES = 3;

export const mascotAccessoryIdSchema = z.enum(MASCOT_ACCESSORY_IDS);

const isAccessory = (value: unknown): value is MascotAccessoryId => typeof value === "string" && Object.hasOwn(MASCOT_ACCESSORIES, value);

/** A valid list from an untrusted value: known ids only, the first one in each slot, at most MAX_MASCOT_ACCESSORIES. */
export function mascotAccessories(value: unknown): MascotAccessoryId[] {
  if (!Array.isArray(value)) return [];
  const slots = new Set<MascotAccessorySlot>();
  const list: MascotAccessoryId[] = [];
  for (const id of value) {
    if (!isAccessory(id) || slots.has(MASCOT_ACCESSORIES[id]) || list.length === MAX_MASCOT_ACCESSORIES) continue;
    slots.add(MASCOT_ACCESSORIES[id]);
    list.push(id);
  }
  return list;
}

export const mascotAccessoriesSchema = z
  .array(mascotAccessoryIdSchema)
  .max(MAX_MASCOT_ACCESSORIES)
  .refine((list) => mascotAccessories(list).length === list.length, "at most one accessory in each slot");

/** Puts `id` on, or takes it off when it is on. Putting one on replaces the accessory in the same slot, then the oldest one past the limit. */
export function toggleMascotAccessory(list: readonly MascotAccessoryId[], id: MascotAccessoryId): MascotAccessoryId[] {
  if (list.includes(id)) return list.filter((worn) => worn !== id);
  const kept = list.filter((worn) => MASCOT_ACCESSORIES[worn] !== MASCOT_ACCESSORIES[id]);
  return [...kept, id].slice(-MAX_MASCOT_ACCESSORIES);
}
