import type { BrandBodyId } from "../shared/carved-bodies.ts";
import type { MascotAccessoryId } from "../shared/mascot-accessories.ts";
import { MAUS_COLOR_NAMES, type MausColor } from "../shared/wire.ts";

export const STARTER_COLORS: readonly MausColor[] = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome");
const ROTATION: readonly MausColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];

/** The colour of the bot made `index`-th when nothing else picks one. */
export const rotationColor = (index: number): MausColor => ROTATION[index % ROTATION.length]!;

export interface StarterCharacter {
  mascotBody: BrandBodyId;
  mascotAccessories: MascotAccessoryId[];
}

/** The cast of brand/mascot/cast/cast.json without Seira: a hair style and its accessories. The first fifteen each wear
 * their own hair style. Seira's own hair stays hers. */
export const STARTER_CHARACTERS: readonly StarterCharacter[] = [
  { mascotBody: "long-straight", mascotAccessories: ["hairpin"] },
  { mascotBody: "bob", mascotAccessories: ["headset-mic"] },
  { mascotBody: "ponytail", mascotAccessories: ["glasses", "earring"] },
  { mascotBody: "long-wavy", mascotAccessories: ["earring", "hairpin"] },
  { mascotBody: "seira-long", mascotAccessories: ["ribbon"] },
  { mascotBody: "twin-tails", mascotAccessories: ["ribbon"] },
  { mascotBody: "bun", mascotAccessories: ["tiara"] },
  { mascotBody: "center-part", mascotAccessories: ["earring"] },
  { mascotBody: "long-loose", mascotAccessories: ["glasses", "bowtie"] },
  { mascotBody: "slick-back", mascotAccessories: ["bowtie"] },
  { mascotBody: "messy", mascotAccessories: ["headset-mic"] },
  { mascotBody: "short-neat", mascotAccessories: ["headphones", "glasses"] },
  { mascotBody: "long-tied", mascotAccessories: ["scarf"] },
  { mascotBody: "spiky", mascotAccessories: ["headphones"] },
  { mascotBody: "buzz", mascotAccessories: ["glasses", "antenna"] },
  { mascotBody: "long-straight", mascotAccessories: ["earring"] },
  { mascotBody: "short-neat", mascotAccessories: ["bowtie"] },
  { mascotBody: "slick-back", mascotAccessories: [] },
  { mascotBody: "long-loose", mascotAccessories: [] },
  { mascotBody: "long-tied", mascotAccessories: ["sunglasses", "earring"] },
  { mascotBody: "messy", mascotAccessories: ["earring"] },
  { mascotBody: "long-loose", mascotAccessories: ["earring"] },
  { mascotBody: "spiky", mascotAccessories: [] },
  { mascotBody: "slick-back", mascotAccessories: ["glasses"] },
  { mascotBody: "center-part", mascotAccessories: ["glasses", "bowtie"] },
];

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

/** A new bot's first look: a cast character and a colour, each at random. It prefers a hair style and a colour that no
 * bot here wears yet, then a character no bot here wears yet. */
export function freshLook(bots: readonly WornLook[], random: () => number = Math.random): FreshLook {
  const unworn = STARTER_COLORS.filter((color) => !bots.some((bot) => bot.color === color));
  const color = pick(unworn.length ? unworn : STARTER_COLORS, random);
  const bodies = new Set(bots.map((bot) => bot.mascotBody));
  const characters = new Set(bots.map((bot) => characterKey(bot.mascotBody, bot.mascotAccessories)));
  const newHair = STARTER_CHARACTERS.filter((character) => !bodies.has(character.mascotBody));
  const newCharacter = STARTER_CHARACTERS.filter((character) => !characters.has(characterKey(character.mascotBody, character.mascotAccessories)));
  const character = pick(newHair.length ? newHair : newCharacter.length ? newCharacter : STARTER_CHARACTERS, random);
  return { color, mascotBody: character.mascotBody, mascotAccessories: [...character.mascotAccessories] };
}

/** Hair styles that older builds gave a new bot by default: no style, the old triangle, and Seira's own. */
const PLAIN_BODIES: ReadonlySet<string | null | undefined> = new Set([undefined, null, "", "cursor", "seira"]);

/** A bot that still wears the look older builds gave every new bot: not the MausBot, no hair style of its own, no
 * accessories, and no picture. */
export function wearsPlainLook(bot: WornLook & { defaultBot?: object; avatarUrl?: string | null }): boolean {
  return !bot.defaultBot && !bot.avatarUrl && PLAIN_BODIES.has(bot.mascotBody) && !bot.mascotAccessories?.length;
}
