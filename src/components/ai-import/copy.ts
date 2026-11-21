// Words for the import screens. No file paths or internal codes ever reach the person.
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { AI_IMPORT_LIMITS } from "../../../shared/ai-import/limits";
import type { ImportCounts, ImportErrorCode } from "../../../shared/ai-import/api";
import type { ImportItemKind, ImportLeftoverReason, ImportSourceKind } from "../../../shared/ai-import/bundle";

export const SUPPORTED_SOURCES = ["chatgpt", "claude-ai", "hermes", "openclaw", "claude-code"] as const;

export function sourceName(kind: ImportSourceKind | "grok-bot"): string {
  return t(`aiImport.source.${kind}` as LocaleKey);
}

const GB = 1024 * 1024 * 1024;

export function limitMessage(code: ImportErrorCode): string {
  switch (code) {
    case "upload-too-large": return t("aiImport.error.tooLarge", { gb: String(AI_IMPORT_LIMITS.uploadBytes / GB) });
    case "too-much-data": return t("aiImport.error.tooMuchData", { gb: String(AI_IMPORT_LIMITS.extractedBytes / GB) });
    case "too-many-files": return t("aiImport.error.tooManyFiles", { count: AI_IMPORT_LIMITS.entries.toLocaleString() });
    case "unsafe-archive": return t("aiImport.error.unsafe");
    case "unknown-source": return t("aiImport.error.unknown");
    default: return t("aiImport.error.failed");
  }
}

export const reasonText = (reason: ImportLeftoverReason) => t(`aiImport.reason.${reason}` as LocaleKey);
export const kindText = (kind: ImportItemKind) => t(`aiImport.kind.${kind}` as LocaleKey);

export const COUNT_ORDER: ReadonlyArray<keyof ImportCounts> = ["conversations", "messages", "memories", "topics", "skills", "tools", "routines", "channels", "attachments"];

/** Kinds with something in them, in a fixed order. */
export function shownCounts(counts: ImportCounts): Array<{ key: keyof ImportCounts; label: string; value: number }> {
  return COUNT_ORDER.filter((key) => counts[key] > 0).map((key) => ({ key, label: t(`aiImport.count.${key}` as LocaleKey), value: counts[key] }));
}
