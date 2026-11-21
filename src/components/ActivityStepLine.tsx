import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { toolStepLabel } from "@/lib/tool-step-label";
import { BotAvatar } from "./Avatar";

export function ActivityStepLine({ message, botId, children }: { message: Message; botId?: string; children?: ReactNode }) {
  const { state } = useStore();
  const bot = state.bots.find((one) => one.id === (message.comm?.withBotId ?? botId)) ?? state.bots.find((one) => one.id === botId);
  const failed = message.tool?.ok === false;
  return (
    <div data-activity-step className="flex min-h-8 min-w-0 items-center gap-2.5 text-[13px]">
      {bot && <BotAvatar bot={bot} size={20} />}
      {bot && <span className="max-w-[40%] shrink-0 truncate font-medium text-ink">{bot.name}</span>}
      <span className="min-w-0 flex-1 truncate text-ink-secondary">{message.tool ? toolStepLabel(message.tool) : children}</span>
      {failed
        ? <X size={14} role="img" aria-label={t("toolDetail.failed")} data-step-mark="failed" className="shrink-0 text-danger" />
        : <Check size={14} aria-hidden="true" data-step-mark="done" className="shrink-0 text-ink-tertiary" />}
    </div>
  );
}
