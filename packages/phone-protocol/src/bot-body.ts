/** Every body id a stored bot may carry. Only the Seira looks are drawn; botBodyId reads the rest as the default. */

import { z } from "zod";

import { MASCOT_BODY_IDS } from "./mascot-bodies.ts";
import { BRAND_BODY_IDS, CARVED_BODY_IDS, type CarvedBodyId } from "./carved-bodies.ts";

/** The Halloween and Diwali bodies. Nothing draws them now, but stored bots and old backups still carry these ids. */
export const RETIRED_BODY_IDS = [
  "pumpkin", "ghost", "witch", "bat", "cat", "skull", "monster", "mummy", "vampire", "spider",
  "rocket", "anaar", "chakri", "sparkler", "bomb", "laddu", "chakli", "jalebi", "katli", "karanji",
] as const;

export const BOT_BODY_IDS = [...MASCOT_BODY_IDS, ...CARVED_BODY_IDS, ...RETIRED_BODY_IDS] as const;

export type BotBodyId = (typeof BOT_BODY_IDS)[number];

export const botBodySchema = z.enum(BOT_BODY_IDS);

/** The shipped mascot: a new bot's body, and the fallback for any unrecognised value. */
export const DEFAULT_BOT_BODY: BotBodyId = "seira";

/** The Seira looks a picker shows, in order. */
export const PICKER_BODY_IDS = BRAND_BODY_IDS;

/** Runtime-safe read of an untrusted persisted or streamed body id. A body that no picker offers reads as the default. */
export function botBodyId(value: unknown): BotBodyId {
  return isBrandBody(value) ? value : DEFAULT_BOT_BODY;
}

export function isCarvedBody(value: unknown): value is CarvedBodyId {
  return (CARVED_BODY_IDS as readonly unknown[]).includes(value);
}

export function isBrandBody(value: unknown): value is (typeof BRAND_BODY_IDS)[number] {
  return (BRAND_BODY_IDS as readonly unknown[]).includes(value);
}
