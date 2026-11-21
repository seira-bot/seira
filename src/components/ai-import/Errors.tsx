import { t } from "@/lib/i18n";
import type { ImportErrorCode } from "../../../shared/ai-import/api";
import { limitMessage, SUPPORTED_SOURCES, sourceName } from "./copy";

/** A read that stopped. `code` is null when the request itself failed. */
export function ImportError({ code, onBack }: { code: ImportErrorCode | null; onBack: () => void }) {
  return (
    <div data-ai-import-error={code ?? "request"} role="alert" className="flex flex-col gap-3">
      <h3 className="text-[14px] font-medium text-ink">{t("aiImport.error.title")}</h3>
      <p className="text-[13px] leading-[18px] text-ink-secondary">{code === null ? t("aiImport.error.generic") : limitMessage(code)}</p>
      {code === "unknown-source" && (
        <ul className="flex flex-col gap-1 text-[13px] leading-[18px] text-ink">
          {SUPPORTED_SOURCES.map((kind) => <li key={kind}>{sourceName(kind)}</li>)}
        </ul>
      )}
      <div><button type="button" data-ai-import-back="" className="ui-button" onClick={onBack}>{t("aiImport.error.another")}</button></div>
    </div>
  );
}
