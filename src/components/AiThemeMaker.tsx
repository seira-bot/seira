import { Check, ChevronLeft, SendHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { THEME_IDEAS_PATH, type ThemeIdeasReply, type ThemeRecipe } from "../../shared/theme-ideas";
import type { ThemeFile } from "../../shared/theme";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { recipeThemeFile } from "@/lib/theme/recipe";
import { previewingTheme, previewTheme, subscribeTheme, wearThemeFile } from "@/lib/theme/runtime";
import { api, ApiError } from "@/state/api";
import { useStore } from "@/state/store";
import { requestBody, type AiThemeRequest } from "./ai-theme-request";
import { FIELD_EDGE, SettingsRows } from "./SettingsPrimitives";
import { ThemePreview } from "./ThemePreview";

interface Entry {
  key: string;
  recipe: ThemeRecipe;
  file: ThemeFile;
}

type Phase = { kind: "making"; keep: boolean } | { kind: "done" } | { kind: "failed"; reason: "failed" | "no-writer" };

const MORE_LIMIT = 12;

const REFINES = [
  { id: "darker", label: () => t("settings.aiTheme.refineDarker"), ask: "Make it darker." },
  { id: "lighter", label: () => t("settings.aiTheme.refineLighter"), ask: "Make it lighter." },
  { id: "calmer", label: () => t("settings.aiTheme.refineCalmer"), ask: "Make the accent calmer and less saturated." },
  { id: "colour", label: () => t("settings.aiTheme.refineColour"), ask: "Add more colour." },
  { id: "warmer", label: () => t("settings.aiTheme.refineWarmer"), ask: "Make it warmer." },
  { id: "cooler", label: () => t("settings.aiTheme.refineCooler"), ask: "Make it cooler." },
  { id: "contrast", label: () => t("settings.aiTheme.refineContrast"), ask: "Raise the contrast." },
] as const;

const entryOf = (recipe: ThemeRecipe): Entry => ({
  key: `${recipe.name.toLowerCase()}|${recipe.light.canvas}${recipe.light.accent}${recipe.dark.canvas}${recipe.dark.accent}`,
  recipe,
  file: recipeThemeFile(recipe),
});

function merge(kept: Entry[], made: ThemeRecipe[]): Entry[] {
  const out = [...kept];
  for (const recipe of made) {
    const next = entryOf(recipe);
    if (!out.some((entry) => entry.key === next.key || entry.recipe.name.toLowerCase() === next.recipe.name.toLowerCase())) out.push(next);
  }
  return out.slice(0, MORE_LIMIT);
}

function Swatches({ colours }: { colours: readonly string[] }) {
  return (
    <span aria-hidden="true" className="flex gap-1">
      {colours.map((colour, index) => <span key={`${colour}${index}`} className="size-4 rounded-full ring-1 ring-hairline" style={{ background: colour }} />)}
    </span>
  );
}

function RequestSummary({ request }: { request: AiThemeRequest }) {
  return (
    <div data-ai-theme-request="" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.aiTheme.yourRequest")}</h3>
      {request.words && <p className="text-[13px] leading-[18px] text-ink-secondary">{request.words}</p>}
      {request.picture && (
        <div className="flex items-center gap-3">
          <img src={request.picture.url} alt="" className="size-12 shrink-0 rounded-lg object-cover ring-1 ring-hairline/60" />
          <Swatches colours={request.picture.colours} />
        </div>
      )}
      {request.brandColour && (
        <p className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
          <span aria-hidden="true" className="size-4 rounded-full ring-1 ring-hairline" style={{ background: request.brandColour }} />
          {t("settings.aiTheme.brandColour")} {request.brandColour}
        </p>
      )}
    </div>
  );
}

function VariantCard({ entry, saved, saving, onTry, onSave }: { entry: Entry; saved: boolean; saving: boolean; onTry: () => void; onSave: () => void }) {
  return (
    <div data-ai-theme-variant={entry.recipe.name} className="flex flex-col gap-3 rounded-xl bg-menu p-3 ring-1 ring-hairline/60">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium leading-[18px] text-ink">{entry.recipe.name}</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] leading-4 text-ink-tertiary"><Check size={12} strokeWidth={2} aria-hidden="true" />{t("settings.aiTheme.readable")}</span>
        </div>
        {entry.recipe.description && <span className="text-[12px] leading-4 text-ink-secondary">{entry.recipe.description}</span>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(["light", "dark"] as const).map((mode) => (
          <div key={mode} className="flex flex-col gap-1 [&>[data-skin-preview]]:h-[88px]">
            <ThemePreview theme={entry.file} mode={mode} />
            <span className="text-[11px] leading-4 text-ink-tertiary">{t(mode === "light" ? "settings.aiTheme.light" : "settings.aiTheme.dark")}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" data-ai-theme-try="" className="ui-button ui-button-sm" onClick={onTry}>{t("settings.aiTheme.tryOn")}</button>
        <button type="button" data-ai-theme-save="" className="ui-button ui-button-sm" disabled={saved || saving} onClick={onSave}>
          {saved && <Check size={12} strokeWidth={2} aria-hidden="true" />}{saved ? t("settings.aiTheme.saved") : t("settings.aiTheme.save")}
        </button>
      </div>
    </div>
  );
}

function Skeletons() {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <div key={index} data-ai-theme-skeleton="" aria-hidden="true" className="flex animate-pulse flex-col gap-3 rounded-xl bg-menu p-3 ring-1 ring-hairline/60">
          <span className="h-4 w-1/2 rounded-full bg-ink/[0.08]" />
          <span className="h-3 w-4/5 rounded-full bg-ink/[0.06]" />
          <div className="grid grid-cols-2 gap-2"><span className="h-[88px] rounded-lg bg-ink/[0.06]" /><span className="h-[88px] rounded-lg bg-ink/[0.06]" /></div>
        </div>
      ))}
    </>
  );
}

/** Settings → Appearance → Make a theme with AI: the bot's three themes for a request, each tried on in this window before it is kept. */
export function AiThemeMaker({ request, onBack }: { request: AiThemeRequest; onBack: () => void }) {
  const { state } = useStore();
  const botId = state.bots.some((bot) => bot.id === state.selectedId) ? state.selectedId : undefined;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "making", keep: false });
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [trying, setTrying] = useState<string | null>(null);
  const [baseKey, setBaseKey] = useState<string | null>(null);
  const [free, setFree] = useState("");
  const running = useRef<AbortController | null>(null);
  const lastBody = useRef<{ body: Record<string, unknown>; append: boolean } | null>(null);
  const previewed = useSyncExternalStore(subscribeTheme, previewingTheme, () => null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const ask = useCallback(async (extra: Record<string, unknown>, append: boolean) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const body = { ...(botId ? { botId } : {}), ...requestBody(request), ...extra };
    lastBody.current = { body, append };
    setPhase({ kind: "making", keep: append });
    try {
      const reply = await api<ThemeIdeasReply>(THEME_IDEAS_PATH, { method: "POST", body: JSON.stringify(body), signal: controller.signal, timeoutMs: 100_000 });
      if (controller.signal.aborted) return;
      const made = Array.isArray(reply?.recipes) ? reply.recipes : [];
      if (!made.length) throw new Error("empty");
      setEntries((kept) => merge(append ? kept : [], made));
      setPhase({ kind: "done" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase({ kind: "failed", reason: error instanceof ApiError && error.body?.reason === "no-writer" ? "no-writer" : "failed" });
    }
  }, [botId, request]);

  useEffect(() => {
    void ask({}, false);
    return () => {
      running.current?.abort();
      previewTheme(null);
      if (request.picture) URL.revokeObjectURL(request.picture.url);
    };
  }, []);

  const tryingEntry = entries.find((entry) => entry.key === trying && entry.file === previewed) ?? null;
  const base = entries.find((entry) => entry.key === baseKey) ?? entries[0] ?? null;

  const tryOn = (entry: Entry) => {
    previewTheme(entry.file);
    setTrying(entry.key);
    setBaseKey(entry.key);
  };

  const ensureSaved = async (entry: Entry): Promise<string | null> => {
    const known = savedIds[entry.key];
    if (known) return known;
    setSaving(entry.key);
    setSaveFailed(false);
    try {
      const made = await api<{ id: string }>("/api/themes/import", { method: "POST", body: JSON.stringify({ seiraTheme: 1, theme: entry.file }) });
      setSavedIds((ids) => ({ ...ids, [entry.key]: made.id }));
      return made.id;
    } catch {
      setSaveFailed(true);
      return null;
    } finally {
      setSaving(null);
    }
  };

  const keep = async (entry: Entry) => {
    const id = await ensureSaved(entry);
    if (!id) return;
    if (!(await wearThemeFile(id, entry.file))) setSaveFailed(true);
  };

  const refine = (text: string) => {
    const said = text.trim();
    if (!said || !base || phase.kind === "making") return;
    previewTheme(null);
    void ask({ refine: said, base: base.recipe }, false);
  };

  const sendFree = (event: FormEvent) => {
    event.preventDefault();
    refine(free);
    setFree("");
  };

  const cancel = () => {
    running.current?.abort();
    if (entries.length) setPhase({ kind: "done" });
    else onBack();
  };

  const making = phase.kind === "making";

  return (
    <div data-ai-theme-maker="" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 px-1">
        <button type="button" data-ai-theme-back="" onClick={onBack} className="flex w-fit cursor-pointer items-center gap-1 text-[13px] leading-[18px] text-accent-text hover:underline">
          <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />{t("settings.aiTheme.back")}
        </button>
        <h2 className="text-[20px] font-semibold leading-7 text-ink">{t("settings.aiTheme.title")}</h2>
      </div>
      {tryingEntry && (
        <div role="status" data-ai-theme-bar="" className="sticky top-2 z-10 flex items-center gap-3 rounded-xl bg-raised px-4 py-2 ring-1 ring-hairline">
          <span className="mr-auto min-w-0 truncate text-[13px] leading-5 text-ink">{t("settings.aiTheme.trying", { name: tryingEntry.recipe.name })}</span>
          <button type="button" data-ai-theme-undo="" className="ui-button ui-button-sm" onClick={() => previewTheme(null)}>{t("common.undo")}</button>
          <button type="button" data-ai-theme-keep="" className="ui-button ui-button-sm ui-button-primary" disabled={saving !== null} onClick={() => void keep(tryingEntry)}>{t("settings.aiTheme.keep")}</button>
        </div>
      )}
      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        <div className="flex flex-col gap-4 md:w-[264px] md:shrink-0">
          <RequestSummary request={request} />
          {entries.length > 0 && !making && phase.kind === "done" && <p data-ai-theme-note="" className="text-[13px] leading-[18px] text-ink">{t("settings.aiTheme.note")}</p>}
          {entries.length > 0 && (
            <SettingsRows>
              <div data-ai-theme-change="" className="flex flex-col gap-3 p-3">
                <h3 className="text-[13px] font-medium leading-[18px] text-ink">{t("settings.aiTheme.changeTitle")}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {REFINES.map((chip) => <button key={chip.id} type="button" className="ui-pill cursor-pointer" data-ai-theme-refine={chip.id} disabled={making} onClick={() => refine(chip.ask)}>{chip.label()}</button>)}
                </div>
                <form onSubmit={sendFree} className="flex items-center gap-1.5">
                  <input value={free} maxLength={300} disabled={making} placeholder={t("settings.aiTheme.sayItPlaceholder")} aria-label={t("settings.aiTheme.sayItPlaceholder")} onChange={(event) => setFree(event.target.value)}
                    className={cn("h-8 min-w-0 flex-1 rounded-lg bg-app px-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus disabled:opacity-40", FIELD_EDGE)} />
                  <button type="submit" className="ui-icon-button" aria-label={t("settings.aiTheme.send")} title={t("settings.aiTheme.send")} disabled={making || !free.trim()}><SendHorizontal size={14} strokeWidth={1.75} /></button>
                </form>
                {base && <p className="text-[12px] leading-4 text-ink-tertiary">{t("settings.aiTheme.startingFrom", { name: base.recipe.name })}</p>}
              </div>
            </SettingsRows>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {phase.kind === "failed" && (
            <div role="alert" data-ai-theme-failed={phase.reason} className="flex flex-col items-start gap-1 rounded-xl bg-menu p-4 ring-1 ring-hairline/60">
              <p className="text-[13px] font-medium leading-[18px] text-ink">{t(phase.reason === "no-writer" ? "settings.aiTheme.noWriterTitle" : "settings.aiTheme.failedTitle")}</p>
              <p className="text-[13px] leading-[18px] text-ink-secondary">{t(phase.reason === "no-writer" ? "settings.aiTheme.noWriterBody" : "settings.aiTheme.failedBody")}</p>
              {phase.reason === "failed" && <button type="button" data-ai-theme-retry="" className="ui-button ui-button-sm mt-2" onClick={() => { const last = lastBody.current; if (last) void ask(Object.fromEntries(Object.entries(last.body).filter(([key]) => key !== "botId")), last.append); }}>{t("settings.aiTheme.tryAgain")}</button>}
            </div>
          )}
          {making && (
            <div role="status" data-ai-theme-making="" className="flex items-center justify-between gap-3 text-[13px] leading-[18px] text-ink-secondary">
              <span>{t("settings.aiTheme.making")}</span>
              <button type="button" data-ai-theme-cancel="" className="ui-button ui-button-sm" onClick={cancel}>{t("common.cancel")}</button>
            </div>
          )}
          {saveFailed && <p role="alert" className="text-[12px] leading-4 text-ink-secondary">{t("settings.aiTheme.saveFailed")}</p>}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-1 2xl:grid-cols-1">
            {(phase.kind !== "making" || phase.keep) && entries.map((entry) => (
              <VariantCard key={entry.key} entry={entry} saved={Boolean(savedIds[entry.key])} saving={saving === entry.key} onTry={() => tryOn(entry)} onSave={() => void ensureSaved(entry)} />
            ))}
            {making && <Skeletons />}
          </div>
          {phase.kind === "done" && entries.length < MORE_LIMIT && (
            <button type="button" data-ai-theme-more="" className="ui-button w-fit" onClick={() => void ask({}, true)}>{t("settings.aiTheme.more")}</button>
          )}
        </div>
      </div>
    </div>
  );
}
