import { z } from "zod";

import { BRAND_BODY_IDS } from "./carved-bodies.ts";
import { CAST_CHARACTERS } from "./cast-characters.ts";
import { mascotAccessoriesSchema, type MascotAccessoryId } from "./mascot-accessories.ts";
import { SEIRA_COLOR_NAMES, type SeiraColor } from "./wire.ts";
import type { BrandBodyId } from "./carved-bodies.ts";

/** The picture a person wears until they choose a photo: the parts a bot's avatar is made of. */
export const personLookSchema = z.object({
  mascotBody: z.enum(BRAND_BODY_IDS),
  mascotAccessories: mascotAccessoriesSchema,
  color: z.enum(SEIRA_COLOR_NAMES),
});

export interface PersonLook {
  mascotBody: BrandBodyId;
  mascotAccessories: MascotAccessoryId[];
  color: SeiraColor;
}

const key = (look: PersonLook) => `${look.mascotBody}|${look.color}|${[...look.mascotAccessories].sort().join(",")}`;

/** A cast character's look, chosen with `random` (a value from 0 up to, not including, 1). Never `not`, when others exist. */
export function randomPersonLook(random: () => number = Math.random, not?: PersonLook | null): PersonLook {
  const looks: PersonLook[] = CAST_CHARACTERS.map(({ mascotBody, mascotAccessories, color }) => ({ mascotBody, mascotAccessories: [...mascotAccessories], color }));
  const others = not ? looks.filter((look) => key(look) !== key(not)) : looks;
  const pool = others.length ? others : looks;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}
