import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun } from "@/lib/activity-runs";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { toolStepLabel } from "@/lib/tool-step-label";
import { BOT_TURN_INDENT } from "./chat-bubble";

export function ActivityRun({
  messages,
  label,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** A turn's own headline ("Worked for 29s") in place of the sum of its steps. */
  label?: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  const bodyId = useId();
  const advanced = useAdvancedMode();
  const summary = label ?? (advanced ? describeRun(messages) : describeRun(messages, toolStepLabel));
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (advanced) {
    if (open) {
      return (
        <div className="flex flex-col gap-1">
          <div className="flex min-w-0 justify-start">
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-expanded
              className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
            >
              <ChevronRight size={13} className="shrink-0 rotate-90" />
              <span className="min-w-0 truncate font-medium leading-5">{summary}</span>
            </button>
          </div>
          {children}
        </div>
      );
    }
    return (
      <div className="flex min-w-0 justify-start">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          title={t("chat.run.showSteps")}
          className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
        >
          <Check size={13} className="shrink-0 text-success" />
          <span className="min-w-0 max-w-[480px] truncate font-medium leading-5">{summary}</span>
          <ChevronRight size={13} className="shrink-0" />
        </button>
      </div>
    );
  }
  return (
    <div data-activity-run className={cn("flex min-w-0 justify-start", BOT_TURN_INDENT)}>
      <div className="min-w-0 max-w-[44rem] flex-1 overflow-hidden rounded-xl border border-hairline">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          title={open ? undefined : t("chat.run.showSteps")}
          className="flex h-10 w-full items-center gap-2.5 ps-3 pe-2.5 text-start text-[13px] text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none"
        >
          <Check size={16} aria-hidden="true" className="shrink-0 text-success" />
          <span className="min-w-0 flex-1 truncate font-medium">{summary}</span>
          <ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        {open && (
          <div id={bodyId} className="animate-msg-in motion-reduce:animate-none">
            <div className="mx-3 mb-3 mt-0.5 flex flex-col items-start gap-1 border-s border-hairline ps-3">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}
