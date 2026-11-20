import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import type { BotSettingsSection } from "@/state/store";
import type { MemoryDoc } from "@/lib/memory";
import { panelMemoryNotes } from "./memory-notes";

export const ADVANCED_GROUPS: ReadonlyArray<{ id: string; label: LocaleKey; sections: readonly BotSettingsSection[] }> = [
  { id: "profile", label: "botPanel.advanced.group.profile", sections: ["overview", "identity", "soul"] },
  { id: "knowledge", label: "botPanel.advanced.group.knowledge", sections: ["skills", "memory", "library"] },
  { id: "work", label: "botPanel.advanced.group.work", sections: ["routines", "model", "permissions", "access"] },
  { id: "channels", label: "botPanel.advanced.group.channels", sections: ["slack", "voice"] },
  { id: "admin", label: "botPanel.advanced.group.admin", sections: ["visibility", "history", "usage"] },
];

/** The note count shown beside Memory: undefined while the notes are still being read. */
export function memoryValue(bot: { memoryEnabled?: boolean }, docs: MemoryDoc[] | null, error: boolean): string | undefined {
  if (bot.memoryEnabled === false) return t("botPanel.memory.off");
  const notes = docs ? panelMemoryNotes(docs).length : null;
  if (notes === null) return error ? t("botPanel.memory.nothingYet") : undefined;
  if (notes === 0) return t("botPanel.memory.nothingYet");
  return notes === 1 ? t("botPanel.memory.note") : t("botPanel.memory.notes", { count: notes });
}
