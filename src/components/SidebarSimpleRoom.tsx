import { Users } from "lucide-react";

import type { Bot } from "@/state/store";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

import { BotAvatar } from "./Avatar";
import { RowStatusText } from "./SidebarRowMarkers";

export function SimpleRoomStack({ members }: { members: Bot[] }) {
  const shown = members.slice(0, 2);
  return (
    <div data-room-stack="" className="flex w-[46px] shrink-0 items-center">
      {shown.length === 0 && <Users size={20} aria-hidden="true" className="ms-1 text-ink-secondary" />}
      {shown.map((member, index) => (
        <span key={member.id} className={index > 0 ? "-ms-2.5 flex rounded-full ring-2 ring-[var(--row)]" : "flex rounded-full ring-2 ring-[var(--row)]"}>
          <BotAvatar bot={member} state="happy" size={28} animated={false} />
        </span>
      ))}
    </div>
  );
}

/** A Simple room row's text: 13px title, 12px time, one-line preview, an accent dot and bold title while unread. */
export function SimpleRoomText({ name, unread, time, preview, expanded }: { name: string; unread: boolean; time?: string; preview: string; expanded: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2 pr-7">
        <span className={cn("truncate text-ink text-[13px] leading-5", unread ? "font-semibold" : "font-medium")}>{name}</span>
        {time && <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{time}</span>}
      </div>
      {!expanded && (
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-[12px] leading-4", unread ? "text-ink-secondary" : "text-ink-tertiary")}>{preview}</span>
          {unread && <span data-testid="unread-dot" title={t("task.unread")} className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      )}
      <RowStatusText unread={unread} />
    </div>
  );
}
