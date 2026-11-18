import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

export function PanelStatePill({ bot }: { bot: Pick<Bot, "busy" | "activity"> }) {
  const waiting = bot.activity === "waiting-on-you";
  const working = !waiting && (bot.busy || bot.activity === "working");
  if (!waiting && !working) return null;
  return (
    <span data-panel-state={waiting ? "waiting" : "working"} className="mt-2.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink-secondary">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : "animate-pulse bg-success motion-reduce:animate-none")} />
      <span className="truncate">{t(waiting ? "botPanel.state.waiting" : "botPanel.state.working")}</span>
    </span>
  );
}
