import type { Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { BotAvatar } from "./Avatar";
import { isPaletteColor, SpeakerName } from "./RoomClusterLabel";

/** Where a bot's turn begins in Simple mode: its face on the start edge, then its name and the time. The face hangs in the
 * indent the turn's own rows leave, so the head and the prose under it share one start edge. */
export function BotTurnHead({ bot, name, color, time, onOpen, children }: {
  bot?: Bot;
  name: string;
  color: string;
  time: string;
  onOpen?: () => void;
  children?: React.ReactNode;
}) {
  const face = (
    <BotAvatar
      bot={bot ?? { name, color: color as Bot["color"] }}
      state={normalizeState(bot?.mascotExpression) ?? "happy"}
      size={32}
      motion="none"
      motionKey={0}
      animated={false}
      readable={isPaletteColor(color)}
    />
  );
  return (
    <div data-turn-head className="relative mb-1 flex min-h-[18px] flex-wrap items-baseline gap-x-2">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("chat.openProfileAria", { name })}
          title={t("chat.openBotPanel")}
          className="absolute -start-[46px] top-0 flex rounded-full transition-transform duration-[120ms] hover:scale-[1.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
        >
          {face}
        </button>
      ) : <span aria-hidden="true" className="absolute -start-[46px] top-0 flex">{face}</span>}
      <SpeakerName name={name} color={color} />
      <span className="text-[12px] tabular-nums text-ink-tertiary">{time}</span>
      {children}
    </div>
  );
}
