import type { CSSProperties, PointerEvent } from "react";
import { Check, Link2, Loader2, Minus, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { BotAvatar } from "../Avatar";
import { clock, occurrenceLabel } from "./phrases";
import type { ShownOccurrence } from "./model";

export const CARD_HEIGHT = 36;
const MAX_AVATARS = 3;

export type Emphasis = "on" | "dim" | null;

export interface CardLook {
  selected: boolean;
  sibling: boolean;
  emphasis: Emphasis;
  lifted: boolean;
}

export const emphasisClass = (emphasis: Emphasis) => (emphasis === "dim" ? "opacity-40" : "");

export function StepAvatars({ botIds, bots }: { botIds: readonly string[]; bots: readonly Bot[] }) {
  const shown = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []).slice(0, MAX_AVATARS);
  if (!shown.length) return null;
  return (
    <span data-step-avatars="" className="inline-flex shrink-0 items-center">
      {shown.map((bot, index) => (
        <span key={`${bot.id}:${index}`} className={cn("flex rounded-full ring-[1.5px] ring-card", index > 0 && "-ml-1.5")}>
          <BotAvatar bot={bot} size={16} animated={false} />
        </span>
      ))}
    </span>
  );
}

export function RunStatusIcon({ status }: { status: ShownOccurrence["runStatus"] }) {
  if (status === "done") return <Check size={12} aria-hidden="true" data-status-icon="done" className="shrink-0 text-success" />;
  if (status === "failed") return <X size={12} aria-hidden="true" data-status-icon="failed" className="shrink-0 text-danger" />;
  if (status === "running") return <Loader2 size={12} aria-hidden="true" data-status-icon="running" className="shrink-0 animate-spin text-ink-secondary motion-reduce:animate-none" />;
  return <Minus size={12} aria-hidden="true" data-status-icon="skipped" className="shrink-0 text-ink-tertiary" />;
}

function StatusIcon({ occurrence }: { occurrence: ShownOccurrence }) {
  if (occurrence.kind === "missed") return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />;
  if (occurrence.kind !== "past-run") return null;
  return <RunStatusIcon status={occurrence.runStatus} />;
}

/** One time a schedule start runs: fixed height, the name, the steps' bots and the time. */
export function OccurrenceCard({ occurrence, name, stepBotIds, bots, look, oneColumn, style, describedBy, onOpen, onPress }: {
  occurrence: ShownOccurrence;
  name: string;
  stepBotIds: readonly string[];
  bots: readonly Bot[];
  look: CardLook;
  oneColumn: boolean;
  style: CSSProperties;
  describedBy?: string;
  onOpen: () => void;
  onPress?: (event: PointerEvent) => void;
}) {
  const past = occurrence.kind === "past-run" || occurrence.kind === "missed";
  const stepNames = oneColumn ? stepBotIds.flatMap((id) => bots.find((bot) => bot.id === id)?.name ?? []).join(" → ") : "";
  return (
    <button
      type="button"
      data-occurrence={occurrence.key}
      data-kind={occurrence.kind}
      data-automation-id={occurrence.automationId}
      data-run-status={occurrence.runStatus}
      data-paused={occurrence.paused ? "" : undefined}
      data-needs-you={occurrence.needsYou && occurrence.kind === "scheduled" && !occurrence.paused ? "" : undefined}
      data-can-move={occurrence.canMove ? "" : undefined}
      data-selected={look.selected ? "" : undefined}
      data-sibling={look.sibling ? "" : undefined}
      data-highlight={look.emphasis ?? undefined}
      aria-label={occurrenceLabel(occurrence, name)}
      aria-describedby={describedBy}
      onClick={onOpen}
      onPointerDown={onPress}
      style={style}
      className={cn(
        "absolute z-[2] flex flex-col justify-center overflow-hidden rounded-lg border px-2 text-left text-ink",
        occurrence.canMove && "cursor-grab touch-none",
        past ? "border-hairline/50 bg-inset" : "border-accent/40 bg-accent/15 hover:border-accent",
        occurrence.runStatus === "failed" && "border-danger/70",
        occurrence.kind === "missed" && "border-danger/50",
        occurrence.needsYou && occurrence.kind === "scheduled" && "border-warning/60 bg-warning/10",
        occurrence.paused && "border-dashed border-hairline bg-transparent opacity-60",
        look.sibling && "border-accent ring-1 ring-accent",
        look.selected && "z-[3] outline outline-2 outline-offset-1 outline-accent",
        look.lifted && "border-dashed opacity-45",
        emphasisClass(look.emphasis),
      )}
    >
      <span className={cn("block truncate text-[12px] leading-4", past || occurrence.paused ? "font-medium text-ink-secondary" : "font-semibold")} dir="auto">{name}</span>
      <span className={cn("flex items-center whitespace-nowrap text-[12px] leading-4 tabular-nums text-ink-secondary", oneColumn ? "gap-2" : "gap-1")}>
        {oneColumn && <span className="min-w-0 flex-1 truncate">{stepNames}</span>}
        <StepAvatars botIds={stepBotIds} bots={bots} />
        <StatusIcon occurrence={occurrence} />
        {occurrence.multi && <Link2 size={12} data-chain="" aria-label={t("automations.cal.chain")} className="shrink-0" />}
        <span>{occurrence.kind === "missed" ? t("automations.cal.missed") : clock(occurrence.at)}</span>
      </span>
    </button>
  );
}
