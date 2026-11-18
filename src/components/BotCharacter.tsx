import type { ReactNode } from "react";

import { botAvatarProfile } from "../../shared/bot-avatar";
import { botBodyId, isBrandBody } from "../../shared/bot-body";
import { mascotAccessories, type MascotAccessoryId } from "../../shared/mascot-accessories";
import { BotAvatar, resolveBotAvatarOutcome, type BotAvatarProps } from "./Avatar";
import { hairTint } from "./CarvedAvatar";
import { SeiraCharacter, type SeiraState } from "./seira-character";

type CharacterBot = BotAvatarProps["bot"] & { mascotAccessories?: readonly MascotAccessoryId[] | null };

/** True when the bot's face is Seira herself: any Seira hair style, with no uploaded picture. */
export function useWearsSeira(bot: BotAvatarProps["bot"]): boolean {
  const profile = botAvatarProfile(bot);
  const outcome = resolveBotAvatarOutcome({ avatarCrop: profile.avatarCrop, hasUrl: Boolean(profile.avatarUrl), imageFailed: false });
  return outcome === "gradientMascot" && isBrandBody(botBodyId(bot.mascotBody));
}

/** The bot's live face for one moment: Seira's character, with the bot's hair style, hair colour and accessories, when the
 * bot wears her. A bot with its own picture keeps `fallback`, so the picture a person chose never turns into someone else's face. */
export function BotCharacter({ bot, state, size, fallback }: {
  bot: CharacterBot;
  state: SeiraState;
  size: number;
  fallback: ReactNode;
}) {
  const seira = useWearsSeira(bot);
  if (!seira) return <>{fallback}</>;
  return (
    <SeiraCharacter
      state={state}
      size={size}
      hairStyle={botBodyId(bot.mascotBody)}
      hairColor={hairTint(bot.color) ? bot.color : undefined}
      accessories={mascotAccessories(bot.mascotAccessories)}
    />
  );
}

/** The face beside a turn's status line: the character working or thinking, or the bot's own avatar at `size`. */
export function TurnFace({ bot, working, size }: { bot: CharacterBot; working: boolean; size: number }) {
  const state = working ? "working" : "thinking";
  return (
    <BotCharacter
      bot={bot}
      state={state}
      size={32}
      fallback={<BotAvatar bot={bot} state={state} size={size} forward={false} lookAround={1} trackPointer={false} />}
    />
  );
}
