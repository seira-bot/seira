import type { BrandBodyId } from "./carved-bodies.ts";
import type { MascotAccessoryId } from "./mascot-accessories.ts";
import type { SeiraColor } from "./wire.ts";

export interface CastCharacter {
  id: string;
  name: string;
  mascotBody: BrandBodyId;
  mascotAccessories: readonly MascotAccessoryId[];
  color: SeiraColor;
}

/** The cast of brand/mascot/cast/cast.json without Seira, as a look a bot can wear. Ids, names, hair styles and
 * accessories must match that file; the colour is the app colour nearest to the character's hair. */
export const CAST_CHARACTERS: readonly CastCharacter[] = [
  { id: "mira", name: "Mira", mascotBody: "long-straight", mascotAccessories: ["hairpin"], color: "orange" },
  { id: "lumi", name: "Lumi", mascotBody: "bob", mascotAccessories: ["headset-mic"], color: "cyan" },
  { id: "rhea", name: "Rhea", mascotBody: "ponytail", mascotAccessories: ["glasses", "earring"], color: "red" },
  { id: "kiri", name: "Kiri", mascotBody: "long-wavy", mascotAccessories: ["earring", "hairpin"], color: "red" },
  { id: "iris", name: "Iris", mascotBody: "seira-long", mascotAccessories: ["ribbon"], color: "purple" },
  { id: "pippa", name: "Pippa", mascotBody: "twin-tails", mascotAccessories: ["ribbon"], color: "coral" },
  { id: "maren", name: "Maren", mascotBody: "bun", mascotAccessories: ["tiara"], color: "pink" },
  { id: "corvin", name: "Corvin", mascotBody: "center-part", mascotAccessories: ["earring"], color: "red" },
  { id: "felix", name: "Felix", mascotBody: "long-loose", mascotAccessories: ["glasses", "bowtie"], color: "yellow" },
  { id: "silas", name: "Silas", mascotBody: "slick-back", mascotAccessories: ["bowtie"], color: "silver" },
  { id: "flint", name: "Flint", mascotBody: "messy", mascotAccessories: ["headset-mic"], color: "silver" },
  { id: "bix", name: "Bix", mascotBody: "short-neat", mascotAccessories: ["headphones", "glasses"], color: "teal" },
  { id: "theo", name: "Theo", mascotBody: "long-tied", mascotAccessories: ["scarf"], color: "purple" },
  { id: "rocco", name: "Rocco", mascotBody: "spiky", mascotAccessories: ["headphones"], color: "red" },
  { id: "milo", name: "Milo", mascotBody: "buzz", mascotAccessories: ["glasses", "antenna"], color: "orange" },
  { id: "vera", name: "Vera", mascotBody: "long-straight", mascotAccessories: ["earring"], color: "orange" },
  { id: "leo", name: "Leo", mascotBody: "short-neat", mascotAccessories: ["bowtie"], color: "yellow" },
  { id: "aldo", name: "Aldo", mascotBody: "slick-back", mascotAccessories: [], color: "chrome" },
  { id: "orin", name: "Orin", mascotBody: "long-loose", mascotAccessories: [], color: "silver" },
  { id: "rico", name: "Rico", mascotBody: "long-tied", mascotAccessories: ["sunglasses", "earring"], color: "yellow" },
  { id: "rook", name: "Rook", mascotBody: "messy", mascotAccessories: ["earring"], color: "orange" },
  { id: "ronan", name: "Ronan", mascotBody: "long-loose", mascotAccessories: ["earring"], color: "coral" },
  { id: "bruno", name: "Bruno", mascotBody: "spiky", mascotAccessories: [], color: "silver" },
  { id: "ansel", name: "Ansel", mascotBody: "slick-back", mascotAccessories: ["glasses"], color: "silver" },
  { id: "ellis", name: "Ellis", mascotBody: "center-part", mascotAccessories: ["glasses", "bowtie"], color: "yellow" },
];

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** The character whose hair style, colour and accessories (in any order) equal the look, or null. */
export function castCharacterOf(look: {
  color?: string | null;
  mascotBody?: string | null;
  mascotAccessories?: readonly string[] | null;
}): CastCharacter | null {
  const worn = look.mascotAccessories ?? [];
  return CAST_CHARACTERS.find((character) => character.color === look.color
    && character.mascotBody === look.mascotBody
    && sameSet(character.mascotAccessories, worn)) ?? null;
}
