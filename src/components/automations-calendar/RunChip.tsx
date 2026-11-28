import type { CSSProperties } from "react";
import { Webhook } from "lucide-react";

import type { CalendarStart } from "@/lib/automation-calendar";
import { cn } from "@/lib/cn";
import { ServiceIcon } from "../ServiceIcon";
import { emphasisClass, RunStatusIcon, type CardLook } from "./OccurrenceCard";
import { clock, occurrenceLabel } from "./phrases";
import type { ShownOccurrence } from "./model";

export const CHIP_HEIGHT = 22;

export function AppMark({ start, size = 14 }: { start: CalendarStart | undefined; size?: number }) {
  if (start?.kind === "app" && start.app) {
    return <ServiceIcon card={{ logo: `https://logos.composio.dev/api/${start.app}`, domain: `${start.app}.com`, label: start.app }} className="shrink-0 !rounded-[3px]" />;
  }
  return <Webhook size={size} aria-hidden="true" className="shrink-0 text-ink-secondary" />;
}

/** A past run that something else started: a small chip with the app's logo at the time it ran. */
export function RunChip({ occurrence, name, start, look, showName, style, onOpen }: {
  occurrence: ShownOccurrence;
  name: string;
  start: CalendarStart | undefined;
  look: CardLook;
  showName: boolean;
  style: CSSProperties;
  onOpen: () => void;
}) {
  const failed = occurrence.runStatus === "failed";
  return (
    <button
      type="button"
      data-occurrence={occurrence.key}
      data-kind={occurrence.kind}
      data-automation-id={occurrence.automationId}
      data-run-status={occurrence.runStatus}
      data-selected={look.selected ? "" : undefined}
      data-sibling={look.sibling ? "" : undefined}
      data-highlight={look.emphasis ?? undefined}
      aria-label={occurrenceLabel(occurrence, name)}
      title={occurrenceLabel(occurrence, name)}
      onClick={onOpen}
      style={style}
      className={cn(
        "absolute z-[2] inline-flex max-w-[calc(100%-6px)] items-center gap-1 overflow-hidden whitespace-nowrap rounded-full border bg-card py-0 pl-1 pr-2 text-[12px] leading-4 tabular-nums text-ink-secondary hover:border-ink-tertiary [&_img]:size-3.5 [&_img]:!rounded-[3px] [&_div]:size-3.5",
        failed ? "border-danger/70 text-danger" : "border-hairline/50",
        look.sibling && "border-accent",
        look.selected && "z-[3] outline outline-2 outline-offset-1 outline-accent",
        emphasisClass(look.emphasis),
      )}
      >
      <AppMark start={start} />
      <RunStatusIcon status={occurrence.runStatus} />
      <span>{clock(occurrence.at)}</span>
      {showName && <span className="min-w-0 truncate text-ink">{name}</span>}
    </button>
  );
}
