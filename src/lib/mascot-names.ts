import { CARVED_BODIES } from "../../shared/carved-bodies";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import type { BotBodyId } from "../../shared/bot-body";
import type { MascotAccessoryId } from "../../shared/mascot-accessories";
import type { SeiraColor } from "../../shared/wire";
import { t } from "@/lib/i18n";
import { en, type LocaleKey } from "@/locales";

const BODIES = [...Object.values(MASCOT_BODIES), ...Object.values(CARVED_BODIES)];

const named = (key: string, fallback: string): string => Object.hasOwn(en, key) ? t(key as LocaleKey) : fallback;

export const bodyName = (id: BotBodyId): string =>
  named(`mascot.body.${id}`, BODIES.find((body) => body.id === id)?.name ?? id);
export const accessoryName = (id: MascotAccessoryId): string =>
  named(`mascot.accessory.${id}`, id.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase()));
export const colorName = (color: SeiraColor): string => named(`mascot.color.${color}`, color);
export const expressionName = (state: string): string => named(`mascot.expression.${state}`, state);
