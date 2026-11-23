import { formatTime } from "@/lib/clock-time";
import { t } from "@/lib/i18n";

/** The line under the keep-awake switch while this computer is held awake for a known automation; null otherwise. */
export function routineWakeLine(
  wake: { keepAwake: boolean; hold: boolean; reason: string; at: number | null; routineId: string | null },
  automations: readonly { id: string; name: string }[],
): string | null {
  if (!wake.keepAwake || !wake.hold || !wake.routineId) return null;
  const name = automations.find((automation) => automation.id === wake.routineId)?.name;
  if (!name) return null;
  if (wake.reason === "running") return t("automations.wakeRunning", { name });
  if (wake.reason === "due" && wake.at != null) return t("automations.wakeUntil", { name, time: formatTime(wake.at) });
  return null;
}
