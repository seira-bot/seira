import { AlertTriangle, Calendar, Webhook } from "lucide-react";

import type { CalendarAutomation } from "@/lib/automation-calendar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Switch } from "../SettingsPrimitives";
import { AppMark } from "./RunChip";

function railMark(automation: CalendarAutomation) {
  if (automation.needsYou) return <AlertTriangle size={12} aria-hidden="true" className="mt-px shrink-0" />;
  const eventStart = automation.starts.find((start) => start.kind !== "schedule");
  if (!eventStart || automation.starts.some((start) => start.kind === "schedule")) return <Calendar size={12} aria-hidden="true" className="mt-px shrink-0" />;
  return eventStart.kind === "app" ? <span className="mt-px flex"><AppMark start={eventStart} /></span> : <Webhook size={12} aria-hidden="true" className="mt-px shrink-0" />;
}

/** Every automation in the List's order, with its sentence and switch. Resting on a row lights its cards. */
export function CalendarRail({ automations, selectedId, busyId, onHover, onOpen, onToggle }: {
  automations: readonly CalendarAutomation[];
  selectedId: string | null;
  busyId?: string | null;
  onHover: (id: string | null) => void;
  onOpen: (automation: CalendarAutomation) => void;
  onToggle: (automation: CalendarAutomation) => void;
}) {
  return (
    <aside aria-label={t("automations.cal.rail")} className="hidden w-[268px] shrink-0 flex-col border-r border-hairline/50 bg-panel md:flex">
      <h2 className="px-[18px] pb-1.5 pt-3.5 text-[12px] font-medium leading-4 text-ink-tertiary">{t("automations.cal.rail")}</h2>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {automations.map((automation) => {
          return (
            <li key={automation.id} data-rail-row={automation.id} data-draft={automation.draft ? "" : undefined}
              onMouseEnter={() => onHover(automation.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(automation.id)} onBlur={() => onHover(null)}
              className={cn("flex items-start gap-2 rounded-[10px] py-2 pl-2.5 pr-2 hover:bg-raised", selectedId === automation.id && "bg-raised")}>
              <button type="button" onClick={() => onOpen(automation)} className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-medium leading-[18px] text-ink" dir="auto">{automation.name}</span>
                <span className={cn("mt-0.5 flex items-start gap-1 text-[12px] leading-4", automation.needsYou ? "text-warning" : "text-ink-secondary")}>
                  {railMark(automation)}
                  <span>{automation.draft ? t("automations.cal.draft") : automation.statusLine}</span>
                </span>
              </button>
              {!automation.draft && <Switch checked={automation.enabled} disabled={busyId === automation.id} aria-label={t("automations.toggle", { name: automation.name })} onClick={() => onToggle(automation)} className="mt-0.5" />}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 border-t border-hairline/50 px-[18px] pb-3.5 pt-3 text-[12px] leading-4 text-ink-secondary">
        <div className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 shrink-0 rounded border border-accent/40 bg-accent/15" />{t("automations.cal.key.schedule")}</div>
        <div className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 shrink-0 rounded-full border border-hairline/50 bg-card" />{t("automations.cal.key.event")}</div>
      </div>
    </aside>
  );
}
