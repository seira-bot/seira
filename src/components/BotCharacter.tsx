import type { ReactNode } from "react";

import { botAvatarProfile } from "../../shared/bot-avatar";
import { botBodyId } from "../../shared/bot-body";
import { BotAvatar, resolveBotAvatarOutcome, type BotAvatarProps } from "./Avatar";
import { hairTint } from "./CarvedAvatar";
import { SeiraCharacter, type SeiraState } from "./seira-character";

/** True when the bot's face is Seira herself: the shipped body, with no uploaded picture. */
export function useWearsSeira(bot: BotAvatarProps["bot"]): boolean {
  const profile = botAvatarProfile(bot);
  const outcome = resolveBotAvatarOutcome({ avatarCrop: profile.avatarCrop, hasUrl: Boolean(profile.avatarUrl), imageFailed: false });
  return outcome === "gradientMascot" && botBodyId(bot.mascotBody) === "seira";
}

/** The bot's live face for one moment: Seira's character, in the bot's hair colour, when the bot wears her. A bot with its
 * own picture or another body keeps `fallback`, so the face a person chose never turns into someone else's. */
export function BotCharacter({ bot, state, size, fallback }: {
  bot: BotAvatarProps["bot"];
  state: SeiraState;
  size: number;
  fallback: ReactNode;
}) {
  const seira = useWearsSeira(bot);
  if (!seira) return <>{fallback}</>;
  return <SeiraCharacter state={state} size={size} hairColor={hairTint(bot.color) ? bot.color : undefined} />;
}

/** The face beside a turn's status line: the character working or thinking, or the bot's own avatar at `size`. */
export function TurnFace({ bot, working, size }: { bot: BotAvatarProps["bot"]; working: boolean; size: number }) {
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
