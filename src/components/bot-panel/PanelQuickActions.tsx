import { Calendar, Laptop, MessageSquare, Settings, type LucideIcon } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type QuickAction = "message" | "computer" | "routines" | "settings";

const LOOK: Record<QuickAction, { Icon: LucideIcon; label: LocaleKey }> = {
  message: { Icon: MessageSquare, label: "botPanel.quick.message" },
  computer: { Icon: Laptop, label: "botPanel.tab.computer" },
  routines: { Icon: Calendar, label: "botPanel.quick.routines" },
  settings: { Icon: Settings, label: "botPanel.quick.settings" },
};

export function PanelQuickActions({ onAction, canMessage = true }: { onAction: (action: QuickAction) => void; canMessage?: boolean }) {
  return (
    <div data-panel-quick className="mt-4 grid w-full grid-cols-4 gap-1.5">
      {(Object.keys(LOOK) as QuickAction[]).filter((action) => canMessage || action !== "message").map((action) => {
        const { Icon, label } = LOOK[action];
        return (
          <button
            key={action}
            type="button"
            data-panel-quick-action={action}
            onClick={() => onAction(action)}
            className="flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl bg-ink/[0.04] px-1 text-[12px] leading-4 text-ink-secondary transition-colors hover:bg-ink/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon size={16} aria-hidden="true" className="shrink-0 text-ink" />
            <span className="max-w-full truncate">{t(label)}</span>
          </button>
        );
      })}
    </div>
  );
}
