import { formatTime, namesLocale } from "@/lib/clock-time";
import { t } from "@/lib/i18n";

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** An Advanced row's last-activity time: the clock today, "Yesterday", the weekday this week, else a short date. */
export function formatRowTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return formatTime(at);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return formatTime(at);
  if (days === 1) return t("chat.day.yesterday");
  const locale = namesLocale();
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
