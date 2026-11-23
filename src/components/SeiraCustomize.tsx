import type { RefObject } from "react";

import { t } from "@/lib/i18n";
import { PICKABLE_STATES } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { AvatarEditor } from "./avatar/AvatarEditor";
import type { AvatarPatch, useAvatarImage } from "./avatar-editing";

const LABEL = "text-[12px] font-medium uppercase tracking-wide text-ink-secondary";

/** The welcome's own profile edit: a name, then the shared avatar editor. */
export function SeiraCustomize({ preview, name, nameRef, image, onName, onPatch }: {
  preview: Bot;
  name: string;
  nameRef: RefObject<HTMLInputElement | null>;
  image: ReturnType<typeof useAvatarImage>;
  onName(name: string): void;
  onPatch(patch: AvatarPatch): void;
}) {
  return (
    <div className="space-y-3 rounded-2xl bg-ink/[0.03] p-3.5 text-left">
      <label className="block">
        <span className={LABEL}>{t("onboarding.bot.name")}</span>
        <input
          ref={nameRef}
          value={name}
          maxLength={BOT_PROFILE_LIMITS.name}
          placeholder="Seira"
          data-seira-welcome-name=""
          onChange={(event) => onName(event.target.value)}
          className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink focus:outline-none"
        />
      </label>
      <AvatarEditor
        bot={preview}
        activeState={PICKABLE_STATES.find((state) => state === preview.mascotExpression) ?? "idle"}
        image={image}
        variant="welcome"
        nameLabel={name || "Seira"}
        onPatch={onPatch}
      />
    </div>
  );
}
