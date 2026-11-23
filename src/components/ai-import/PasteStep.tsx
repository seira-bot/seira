import { Check, Copy } from "lucide-react";

import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ImportDestination, PasteSource } from "../../../shared/ai-import/api";
import { AI_IMPORT_LIMITS } from "../../../shared/ai-import/limits";
import { checkPaste, parsePaste, pastePrompt, PASTE_SOURCES } from "../../../shared/ai-import/paste";
import { Select } from "../Select";
import { sourceName } from "./copy";
import { DestinationSelect, type BotChoice } from "./Review";

export function pasteName(ai: PasteSource): string {
  if (ai === "chatgpt" || ai === "claude-ai") return sourceName(ai);
  if (ai === "other") return sourceName("paste");
  return t(`aiImport.paste.ai.${ai}` as LocaleKey);
}

export interface PasteStepProps {
  ai: PasteSource;
  text: string;
  destination: ImportDestination;
  bots: readonly BotChoice[];
  copied?: boolean;
  busy?: boolean;
  onAi: (ai: PasteSource) => void;
  onText: (text: string) => void;
  onDestination: (destination: ImportDestination) => void;
  onCopy: () => void;
  onImport: () => void;
  onBack: () => void;
}

export function PasteStep({ ai, text, destination, bots, copied = false, busy = false, onAi, onText, onDestination, onCopy, onImport, onBack }: PasteStepProps) {
  const check = checkPaste(text);
  const parsed = parsePaste(text);
  const lines = parsed.aboutYou.length + parsed.howToReply.length;
  const ready = check.ok && lines > 0;
  const reason = check.ok ? (lines === 0 ? t("aiImport.paste.empty") : null) : check.reason === "empty" ? t("aiImport.paste.empty") : t("aiImport.paste.tooLong", { chars: AI_IMPORT_LIMITS.pasteChars.toLocaleString() });
  const counted = ready;
  return (
    <div data-ai-import-screen="paste" className="flex flex-col gap-4">
      <h3 className="text-[14px] font-medium text-ink">{t("aiImport.paste.title")}</h3>
      <label className="flex items-center gap-3 text-[13px] leading-5 text-ink-secondary">
        <span className="shrink-0">{t("aiImport.paste.which")}</span>
        <Select data-ai-import-paste-ai="" value={ai} onChange={(event) => onAi(event.target.value as PasteSource)} className="min-w-0 flex-1">
          {PASTE_SOURCES.map((source) => <option key={source} value={source}>{pasteName(source)}</option>)}
        </Select>
      </label>
      <section className="flex flex-col gap-2">
        <p className="text-[13px] leading-[18px] text-ink">{t("aiImport.paste.step1", { ai: pasteName(ai) })}</p>
        <pre data-ai-import-prompt="" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink/[0.04] p-3 text-[12px] leading-4 text-ink-secondary">{pastePrompt(ai)}</pre>
        <div>
          <button type="button" data-ai-import-copy="" className="ui-button gap-1.5" onClick={onCopy}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? t("aiImport.paste.copied") : t("common.copy")}
          </button>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <label htmlFor="ai-import-paste-text" className="text-[13px] leading-[18px] text-ink">{t("aiImport.paste.step2")}</label>
        <textarea id="ai-import-paste-text" data-ai-import-paste-text="" value={text} rows={6} placeholder={t("aiImport.paste.placeholder")} onChange={(event) => onText(event.target.value)}
          className="w-full resize-y rounded-lg border-0 bg-app p-2 text-[13px] leading-5 text-ink shadow-[inset_0_0_0_0.5px_var(--settings-edge,var(--color-hairline))] outline-none placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-focus" />
        {counted && <p data-ai-import-paste-counts="" className="text-[12px] leading-4 text-ink-secondary">{t("aiImport.paste.counts", { about: parsed.aboutYou.length, reply: parsed.howToReply.length })}</p>}
      </section>
      <DestinationSelect label={t("aiImport.review.sendsTo")} value={destination} bots={bots} onChange={onDestination} />
      <div className="flex items-center gap-3">
        <button type="button" data-ai-import-paste-import="" className="ui-button ui-button-primary" disabled={busy || !ready} onClick={onImport}>{t("aiImport.import")}</button>
        <button type="button" data-ai-import-back="" className="ui-button" disabled={busy} onClick={onBack}>{t("aiImport.back")}</button>
        {reason && <span data-ai-import-paste-reason="" className="text-[12px] leading-4 text-ink-secondary">{reason}</span>}
      </div>
    </div>
  );
}
