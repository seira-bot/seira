import { useEffect, useId, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import type { Message } from "@/state/store";
import { describeRun, runHeadline, runStatus, stepCountLabel, type RunStatus } from "@/lib/activity-runs";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { toolStepLabel } from "@/lib/tool-step-label";
import { BOT_TURN_INDENT } from "./chat-bubble";
import { StepRowContext } from "./step-row";
import { TraceDialog } from "./usage/TraceView";
import { WorkingDots } from "./WorkingIndicator";

export function ActivityRun({
  messages,
  label,
  forceOpen = false,
  status,
  trace,
  children,
}: {
  messages: Message[];
  /** A turn's own headline ("Worked for 29s") in place of the sum of its steps. */
  label?: string;
  forceOpen?: boolean;
  /** Advanced mode: "working" while the turn runs; otherwise the card says "failed" when a step did. */
  status?: RunStatus;
  /** Advanced mode: the recorded trace of this turn, reached from the foot of the open card. */
  trace?: { id: string; at: number; durationMs?: number };
  children: React.ReactNode;
}) {
  const advanced = useAdvancedMode();
  const [open, setOpen] = useState(forceOpen || advanced);
  const [tracing, setTracing] = useState(false);
  const bodyId = useId();
  const state = status ?? runStatus(messages);
  const summary = advanced ? runHeadline(messages, state, label, trace?.durationMs) : label ?? describeRun(messages, toolStepLabel);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div data-activity-run data-run-status={advanced ? state : undefined} className={cn("flex min-w-0 justify-start", BOT_TURN_INDENT)}>
      <div className="min-w-0 max-w-[44rem] flex-1 overflow-hidden rounded-xl border border-hairline">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          title={open ? undefined : t("chat.run.showSteps")}
          className="flex h-10 w-full items-center gap-2.5 ps-3 pe-2.5 text-start text-[13px] text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-reduce:transition-none"
        >
          {advanced && state === "working" ? <WorkingDots size={3.5} className="shrink-0 text-accent" />
            : advanced && state === "failed" ? <X size={16} aria-hidden="true" className="shrink-0 text-danger" />
              : <Check size={16} aria-hidden="true" className="shrink-0 text-success" />}
          <span className={cn("min-w-0 truncate font-medium", advanced ? (state === "failed" ? "text-danger" : "text-ink") : "flex-1")}>{summary}</span>
          {advanced && <span data-run-steps className="ms-auto shrink-0 text-[12px] tabular-nums text-ink-tertiary">{stepCountLabel(messages.length)}</span>}
          <ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-ink-tertiary transition-transform duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        {open && (
          <div id={bodyId} className="animate-msg-in motion-reduce:animate-none">
            {advanced ? (
              <StepRowContext value>
                <div data-step-timeline className="relative mx-3 mb-2 mt-0.5 flex flex-col">
                  <span aria-hidden="true" className="absolute bottom-4 start-2.5 top-4 w-px bg-hairline" />
                  {children}
                </div>
              </StepRowContext>
            ) : (
              <div className="mx-3 mb-3 mt-0.5 flex flex-col items-start gap-1 border-s border-hairline ps-3">{children}</div>
            )}
            {advanced && trace && (
              <div className="px-3 pb-2.5">
                <button type="button" onClick={() => setTracing(true)} data-testid="view-trace" className="text-[12px] text-ink-tertiary hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {t("trace.view")}
                </button>
              </div>
            )}
          </div>
        )}
        {tracing && trace && <TraceDialog id={trace.id} at={trace.at} onClose={() => setTracing(false)} />}
      </div>
    </div>
  );
}
