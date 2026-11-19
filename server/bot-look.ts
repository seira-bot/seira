import { existsSync } from "node:fs";
import { join } from "node:path";

import { CAST_CHARACTERS } from "../shared/cast-characters.ts";
import type { BrandBodyId } from "../shared/carved-bodies.ts";
import type { MascotAccessoryId } from "../shared/mascot-accessories.ts";
import { MAUS_COLOR_NAMES, type MausColor } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";

export const STARTER_COLORS: readonly MausColor[] = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
const ROTATION: readonly MausColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** The colour of the bot made `index`-th when nothing else picks one. */
export const rotationColor = (index: number): MausColor => ROTATION[index % ROTATION.length]!;

export interface StarterCharacter {
  mascotBody: BrandBodyId;
  mascotAccessories: MascotAccessoryId[];
}

/** The cast of `CAST_CHARACTERS` without the colour: a hair style and its accessories. The first fifteen each wear
 * their own hair style. Seira's own hair stays hers. */
export const STARTER_CHARACTERS: readonly StarterCharacter[] = CAST_CHARACTERS.map(({ mascotBody, mascotAccessories }) => ({
  mascotBody,
  mascotAccessories: [...mascotAccessories],
}));

export interface WornLook {
  color: MausColor;
  mascotBody?: string | null;
  mascotAccessories?: readonly string[] | null;
}

export interface FreshLook extends StarterCharacter {
  color: MausColor;
}

const characterKey = (body: string | null | undefined, accessories: readonly string[] | null | undefined) =>
  `${body ?? ""}|${[...accessories ?? []].sort().join(",")}`;

const pick = <T>(pool: readonly T[], random: () => number): T => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;

/** A cast character at random. It prefers a hair style that no bot here wears yet, then a character that no bot here
 * wears yet. */
export function freshCharacter(bots: readonly WornLook[], random: () => number = Math.random): StarterCharacter {
  const bodies = new Set(bots.map((bot) => bot.mascotBody));
  const characters = new Set(bots.map((bot) => characterKey(bot.mascotBody, bot.mascotAccessories)));
  const newHair = STARTER_CHARACTERS.filter((character) => !bodies.has(character.mascotBody));
  const newCharacter = STARTER_CHARACTERS.filter((character) => !characters.has(characterKey(character.mascotBody, character.mascotAccessories)));
  const character = pick(newHair.length ? newHair : newCharacter.length ? newCharacter : STARTER_CHARACTERS, random);
  return { mascotBody: character.mascotBody, mascotAccessories: [...character.mascotAccessories] };
}

/** A new bot's first look: a fresh character, and a colour at random that no bot here wears yet when one is left. */
export function freshLook(bots: readonly WornLook[], random: () => number = Math.random): FreshLook {
  const unworn = STARTER_COLORS.filter((color) => !bots.some((bot) => bot.color === color));
  const color = pick(unworn.length ? unworn : STARTER_COLORS, random);
  return { color, ...freshCharacter(bots, random) };
}

/** Hair styles that older builds gave a new bot by default: no style, the old triangle, and Seira's own. */
const PLAIN_BODIES: ReadonlySet<string | null | undefined> = new Set([undefined, null, "", "cursor", "seira"]);

/** A bot that still wears the look older builds gave every new bot: not the MausBot, no hair style of its own, no
 * accessories, and no picture. */
export function wearsPlainLook(bot: WornLook & { defaultBot?: object; avatarUrl?: string | null }): boolean {
  return !bot.defaultBot && !bot.avatarUrl && PLAIN_BODIES.has(bot.mascotBody) && !bot.mascotAccessories?.length;
}

type StoredBot = WornLook & { home?: object; defaultBot?: object; avatarUrl?: string | null };

/** Gives each bot that still wears the plain look a character of its own, once for each data folder. It calls `save`
 * with true when a bot changed, and marks the folder only after `save` returns. */
export function giveCharactersOnce(bots: readonly StoredBot[], dataDir: string, botsReadable: boolean, save: (changed: boolean) => void): void {
  const marker = join(dataDir, "characters-given");
  if (!botsReadable || existsSync(marker)) {
    save(false);
    return;
  }
  const plain = bots.filter((bot) => !bot.home && wearsPlainLook(bot));
  for (const bot of plain) Object.assign(bot, freshCharacter(bots));
  save(plain.length > 0);
  writeFileAtomic(marker, "Bots in the look older builds gave every new bot each wear a character of their own.\n", { mode: 0o600 });
}
