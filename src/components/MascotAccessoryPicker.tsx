import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { accessoryName } from "@/lib/mascot-names";
import type { Bot } from "@/state/store";
import { MASCOT_ACCESSORY_IDS, mascotAccessories, toggleMascotAccessory } from "../../shared/mascot-accessories";
import { SeiraAvatar } from "./Avatar";
import type { AvatarPatch } from "./avatar-editing";

export function MascotAccessoryPicker({ bot, disabled, compact = false, onPatch }: {
  bot: Pick<Bot, "color" | "mascotBody" | "mascotFaceColor" | "mascotAccessories">;
  disabled: boolean;
  compact?: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const worn = mascotAccessories(bot.mascotAccessories);
  return (
    <div role="group" aria-label={t("botIdentity.accessories")} data-avatar-accessories className={cn("grid gap-1.5", "grid-cols-6")}>
      {MASCOT_ACCESSORY_IDS.map((id) => {
        const name = accessoryName(id);
        const on = worn.includes(id);
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={t("mascot.useAccessory", { name })}
            title={name}
            data-avatar-accessory={id}
            onClick={() => onPatch({ mascotAccessories: toggleMascotAccessory(worn, id) })}
            className={cn(
              "flex items-center justify-center rounded-lg disabled:opacity-50",
              compact ? "h-10" : "py-1",
              on ? "bg-control text-ink ring-2 ring-accent-border" : "text-ink-secondary hover:bg-control/60",
            )}
          >
            <SeiraAvatar
              color={bot.color}
              bodyId={bot.mascotBody ?? undefined}
              accessories={[id]}
              size={compact ? 32 : 34}
              animated={false}
              trackPointer={false}
            />
          </button>
        );
      })}
    </div>
  );
}
