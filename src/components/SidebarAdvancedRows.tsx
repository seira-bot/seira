import { Users } from "lucide-react";

import type { Bot } from "@/state/store";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

import { BotAvatar } from "./Avatar";
import { RowStatusText } from "./SidebarRowMarkers";

/** A group chat's two avatars, 22px each, on the corners of a 32px box. */
export function AdvancedRoomStack({ members }: { members: Bot[] }) {
  const shown = members.slice(0, 2);
  return (
    <div data-room-stack="" className="relative size-8 shrink-0">
      {shown.length === 0 && <Users size={20} aria-hidden="true" className="absolute inset-1.5 text-ink-secondary" />}
      {shown.map((member, index) => (
        <span key={member.id} className={cn("absolute flex rounded-full ring-2 ring-[var(--row)]", index === 0 ? "start-0 top-0" : "bottom-0 end-0")}>
          <BotAvatar bot={member} state="happy" size={22} animated={false} />
        </span>
      ))}
    </div>
  );
}

/** A group chat row's text: 14px title, 12px time, a one-line 13px preview and an accent dot while unread. */
export function AdvancedRoomText({ name, unread, time, preview, expanded }: { name: string; unread: boolean; time?: string; preview: string; expanded: boolean }) {
  return (
    <div className={cn("min-w-0 flex-1", ADV_ACTIONS_PAD_1)}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("truncate text-[14px] leading-[18px] text-ink", unread ? "font-semibold" : "font-medium")}>{name}</span>
        {time && <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0">{time}</span>}
        {expanded && unread && <span className="size-[7px] shrink-0 rounded-full bg-accent" aria-label={t("task.unreadMany")} />}
      </div>
      {!expanded && (
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-[13px] leading-4", unread ? "text-ink-secondary" : "text-ink-tertiary")}>{preview}</span>
          {unread && <span data-testid="unread-dot" title={t("task.unread")} className="size-[7px] shrink-0 rounded-full bg-accent" />}
        </div>
      )}
      <RowStatusText unread={unread} />
    </div>
  );
}

/** A bot thread's row: 20px avatar, 13px title, the bot's name and the time. */
export function AdvancedThreadText({ bot, name, unread, time }: { bot?: Bot; name: string; unread: boolean; time?: string }) {
  return (
    <>
      <span className="flex w-8 shrink-0 items-center justify-center">
        {bot ? <BotAvatar bot={bot} state="happy" size={20} animated={false} /> : <Users size={16} aria-hidden="true" className="text-ink-secondary" />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", unread ? "font-semibold text-ink" : "font-medium text-ink-secondary group-hover:text-ink")}>{name}</span>
      {bot && <span className="shrink-0 text-[12px] text-ink-tertiary">{bot.name}</span>}
      {time && <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{time}</span>}
      {unread && <span data-testid="unread-dot" title={t("task.unread")} className="size-[7px] shrink-0 rounded-full bg-accent" />}
      <RowStatusText unread={unread} />
    </>
  );
}

/** Inline-end room for a row's hover actions, so text ends before them: the ⋯ alone, or the + and folder with it. */
export const ADV_ACTIONS_PAD_1 = "md:group-hover:pe-7 md:group-focus-within:pe-7 md:touch:pe-7";
export const ADV_ACTIONS_PAD_3 = "md:group-hover:pe-[5.25rem] md:group-focus-within:pe-[5.25rem] md:touch:pe-[5.25rem]";
