import { Loader2 } from "lucide-react";

import type { Bot, InstanceInfo, Message } from "@/state/store";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

import { BotEngineMark } from "./BotModelBadge";
import { FadeLine } from "./FadeLine";
import { botPreview, lastLine } from "./sidebar-preview";
import { SidebarWorkingStep } from "./SidebarWorkingStep";

type BotRowPreviewProps = {
  bot: Bot;
  visible: Message[];
  instances: InstanceInfo[];
  last: Message | undefined;
  advanced: boolean;
  advRow: boolean;
  simpleRow: boolean;
  deleting: boolean;
  working: boolean;
  waiting: boolean;
  teammateWait: boolean;
  queued: boolean;
  failed: boolean;
  unread: boolean;
};

/** The second line of a bot row: its status or last message, the engine mark and the unread dot. */
export function BotRowPreview({ bot, visible, instances, last, advanced, advRow, simpleRow, deleting, working, waiting, teammateWait, queued, failed, unread }: BotRowPreviewProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      {deleting ? (
        <span role="status" className="flex min-w-0 items-center gap-1.5 truncate text-[13px] leading-[18px] text-ink-secondary">
          <Loader2 size={12} className="shrink-0 animate-spin" />
          {t("sidebar.bot.deletingRow")}
        </span>
      ) : (
        <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-[13px]", advRow ? "leading-4" : "leading-[18px]",
          advRow ? failed ? "text-danger" : waiting ? "text-warning" : unread || working ? "text-ink-secondary" : "text-ink-tertiary"
            : waiting ? simpleRow ? "text-warning" : "font-semibold text-warning" : "text-ink-secondary")}>
          {working ? (
            <SidebarWorkingStep bot={bot} last={last} />
          ) : (
            <FadeLine>{waiting ? t("sidebar.preview.waiting") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued && !failed ? t("task.queued") : failed ? lastLine(bot, visible, instances, advanced) : botPreview(bot, visible, instances, advanced) || bot.title.trim()}</FadeLine>
          )}
        </span>
      )}
      {simpleRow && <BotEngineMark bot={bot} instances={instances} className="ms-auto" />}
      {!simpleRow && unread && <span className={cn("shrink-0 rounded-full bg-accent", advRow ? "size-[7px]" : "size-2")} aria-label={t("task.unreadMany")} />}
    </div>
  );
}
