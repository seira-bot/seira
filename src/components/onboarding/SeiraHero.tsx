import { BotAvatar } from "@/components/Avatar";
import { SeiraCharacter, type SeiraState } from "@/components/seira-character";
import type { MausColor } from "@/lib/mascot";
import type { Bot } from "@/state/store";

const GREY_HAIR: readonly MausColor[] = ["silver", "chrome"];

/** Seira keeps her own silver hair for the grey bot colors. */
export const seiraHair = (color: MausColor): MausColor | undefined => (GREY_HAIR.includes(color) ? undefined : color);

/**
 * The large character of a first-run step. The landing animation copies its element, and a copied canvas is blank,
 * so a flat stand-in lies under the character and shows only in that copy (`takeOff`).
 */
export function SeiraHero({ bot, state, size, label }: { bot: Bot; state: SeiraState; size: number; label?: string }) {
  return (
    <span className="relative flex shrink-0" style={{ width: size, height: size }}>
      <SeiraCharacter state={state} size={size} hairColor={seiraHair(bot.color)} label={label} />
      <span aria-hidden="true" data-flight-stand-in="" className="pointer-events-none absolute inset-0 opacity-0">
        <BotAvatar bot={bot} size={size} animated={false} trackPointer={false} />
      </span>
    </span>
  );
}

/** Call right before the landing animation copies `from`. */
export function takeOff(from: HTMLElement | null): void {
  const standIn = from?.querySelector<HTMLElement>("[data-flight-stand-in]");
  if (standIn) standIn.style.opacity = "1";
}
