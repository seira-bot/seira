import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { lastLine } from "../sidebar-preview";
import { sidebarBotStatus } from "../SidebarBotActivity";
import { SidebarWorkingStep } from "../SidebarWorkingStep";

type Kind = "working" | "waiting" | "failed";

const DOT: Record<Kind, string> = {
  working: "animate-pulse bg-success motion-reduce:animate-none",
  waiting: "bg-warning",
  failed: "bg-danger",
};

/** The hero's one status line, in the words the sidebar row says: nothing while the bot is idle. */
export function AdvancedStatePill({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const visible = visibleMessages(bot);
  const status = sidebarBotStatus(bot, {}, visible);
  const kind: Kind | null = status.waiting ? "waiting" : status.working ? "working" : status.failed ? "failed" : null;
  if (!kind) return null;
  return (
    <span data-panel-state={kind} className="mt-1.5 inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-ink/[0.05] px-2.5 text-[12px] text-ink-secondary">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[kind])} />
      <span className="min-w-0 truncate">
        {kind === "working" ? <SidebarWorkingStep bot={bot} last={visible.at(-1)} />
          : kind === "waiting" ? t("sidebar.preview.waiting")
            : lastLine(bot, visible, state.instances, true) || t("sidebar.preview.failed")}
      </span>
    </span>
  );
}
