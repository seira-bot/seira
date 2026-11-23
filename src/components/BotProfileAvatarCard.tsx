import type { Bot } from "@/state/store";
import type { SeiraMotion, MascotState } from "@/lib/mascot";
import { BotAvatar } from "./Avatar";
import { AvatarEditor } from "./avatar/AvatarEditor";
import { useAvatarImage, type AvatarPatch } from "./avatar-editing";

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: MascotState;
  mascotMotion: { kind: Exclude<SeiraMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const image = useAvatarImage(bot, onPatch);
  const showsImage = image.crop !== "mascot" && Boolean(bot.avatarUrl);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card p-3">
      {!showsImage && (
        <div className="flex justify-center pb-3">
          <BotAvatar
            bot={bot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>
      )}
      <AvatarEditor bot={bot} activeState={activeState} image={image} variant="card" onPatch={onPatch} />
    </div>
  );
}
