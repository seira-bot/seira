import { useCallback, useState } from "react";

import { appTriggerApi } from "@/lib/app-triggers";
import type { CalendarAutomation } from "@/lib/automation-calendar";
import type { Automation } from "@/lib/automations";
import { t } from "@/lib/i18n";
import type { RoutineSchedule } from "@/lib/routines";
import { api, useStore } from "@/state/store";

/** What the Calendar changes: the schedule of one start, and the switch of a whole automation. */
export function useCalendarActions(all: readonly Automation[]) {
  const { dispatch } = useStore();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const saveSchedule = useCallback(async (startId: string, schedule: RoutineSchedule) => {
    const response = await api(`/api/routines/${startId}`, { method: "PATCH", body: JSON.stringify({ schedule }) });
    dispatch({ type: "routinePatched", routine: response.routine });
  }, [dispatch]);

  const toggle = useCallback(async (automation: CalendarAutomation) => {
    const target = !automation.enabled;
    const members = all.filter((member) => automation.starts.some((start) => start.id === member.id) && member.enabled !== target);
    setBusyId(automation.id);
    setError("");
    try {
      for (const member of members) {
        if (member.kind === "schedule") {
          const response = await api(`/api/routines/${member.id}`, { method: "PATCH", body: JSON.stringify({ enabled: target }) });
          dispatch({ type: "routinePatched", routine: response.routine });
        } else if (member.kind === "app") {
          await appTriggerApi.update(member.id, { enabled: target });
        } else {
          const response = await api(`/api/webhooks/${member.id}`, { method: "PATCH", body: JSON.stringify({ enabled: target, verificationPending: false }) });
          dispatch({ type: "webhookPatched", webhook: response.webhook });
        }
      }
    } catch {
      setError(t("automations.cal.toggleFailed", { name: automation.name }));
    } finally {
      setBusyId(null);
    }
  }, [all, dispatch]);

  return { saveSchedule, toggle, busyId, error };
}
