import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SeiraColor } from "@/lib/mascot";
import { CAST_CHARACTERS, castCharacterOf } from "../../shared/cast-characters";
import type { BrandBodyId } from "../../shared/carved-bodies";
import type { MascotAccessoryId } from "../../shared/mascot-accessories";
import { SeiraAvatar } from "./Avatar";

const FIRST_SHOWN = 10;

export interface CastCharacterPatch {
  color: SeiraColor;
  mascotBody: BrandBodyId;
  mascotAccessories: MascotAccessoryId[];
}

/** One button per cast character; a press sends the character's whole look. The first ten show, the rest follow a toggle. */
export function CastCharacterPicker({ look, selectable, disabled, avatarSize = 40, variant = "ring", onPick }: {
  look: { color?: string | null; mascotBody?: string | null; mascotAccessories?: readonly string[] | null };
  selectable: boolean;
  disabled?: boolean;
  avatarSize?: number;
  variant?: "ring" | "control";
  onPick: (patch: CastCharacterPatch) => void;
}) {
  const worn = selectable ? castCharacterOf(look) : null;
  const [open, setOpen] = useState(() => {
    const index = worn ? CAST_CHARACTERS.indexOf(worn) : -1;
    return index >= FIRST_SHOWN;
  });
  const shown = open ? CAST_CHARACTERS : CAST_CHARACTERS.slice(0, FIRST_SHOWN);
  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5" role="group" aria-label={t("botIdentity.characters")}>
        {shown.map((character) => {
          const pressed = worn?.id === character.id;
          return (
            <button
              key={character.id}
              type="button"
              disabled={disabled}
              aria-pressed={pressed}
              aria-label={t("mascot.useCharacter", { name: character.name })}
              title={character.name}
              data-cast-character={character.id}
              onClick={() => onPick({
                color: character.color,
                mascotBody: character.mascotBody,
                mascotAccessories: [...character.mascotAccessories],
              })}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-xl px-0.5 py-1 disabled:opacity-50",
                variant === "ring"
                  ? pressed ? "bg-ink/[0.08] ring-[1.5px] ring-inset ring-ink/25" : "hover:bg-ink/[0.05]"
                  : pressed ? "bg-control text-ink" : "hover:bg-control/60",
              )}
            >
              <SeiraAvatar
                color={character.color}
                bodyId={character.mascotBody}
                accessories={character.mascotAccessories}
                size={avatarSize}
                animated={false}
                trackPointer={false}
              />
              <span className="max-w-full truncate text-[11px] text-ink-secondary">{character.name}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-cast-more
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
        className="mx-auto mt-1.5 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-ink/[0.04] hover:text-ink"
      >
        {open ? t("botIdentity.fewerCharacters") : t("botIdentity.allCharacters", { count: CAST_CHARACTERS.length })}
        <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}
