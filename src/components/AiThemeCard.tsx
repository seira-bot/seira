import { Image as ImageIcon, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { pictureColours } from "@/lib/theme/picture-colours";
import type { AiThemeRequest } from "./ai-theme-request";
import { FIELD_EDGE, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

const IDEAS = [
  { id: "easy", label: () => t("settings.aiTheme.ideaEasy") },
  { id: "night", label: () => t("settings.aiTheme.ideaNight") },
  { id: "logo", label: () => t("settings.aiTheme.ideaLogo") },
  { id: "ocean", label: () => t("settings.aiTheme.ideaOcean") },
  { id: "matcha", label: () => t("settings.aiTheme.ideaMatcha") },
  { id: "contrast", label: () => t("settings.aiTheme.ideaContrast") },
] as const;

const DEFAULT_BRAND = "#1084fe";

/** The top of Settings → Appearance's gallery: a sentence, a picture or a brand colour in, three themes out. */
export function AiThemeCard({ onMake }: { onMake: (request: AiThemeRequest) => void }) {
  const [words, setWords] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  const [picture, setPicture] = useState<NonNullable<AiThemeRequest["picture"]> | null>(null);
  const [problem, setProblem] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const handedOver = useRef(false);
  const pictureUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (!handedOver.current && pictureUrl.current) URL.revokeObjectURL(pictureUrl.current);
  }, []);

  const dropPicture = () => {
    if (pictureUrl.current) URL.revokeObjectURL(pictureUrl.current);
    pictureUrl.current = null;
    setPicture(null);
  };

  const pick = async (chosen: File | undefined) => {
    if (!chosen) return;
    setProblem(false);
    try {
      const colours = await pictureColours(chosen);
      dropPicture();
      const url = URL.createObjectURL(chosen);
      pictureUrl.current = url;
      setPicture({ url, colours });
    } catch {
      setProblem(true);
    }
  };

  const ready = Boolean(words.trim() || brand || picture);
  const make = () => {
    if (!ready) return;
    handedOver.current = true;
    onMake({ ...(words.trim() ? { words: words.trim() } : {}), ...(brand ? { brandColour: brand } : {}), ...(picture ? { picture } : {}) });
  };

  const idea = (id: (typeof IDEAS)[number]["id"], label: string) => {
    setWords(label);
    if (id === "logo") file.current?.click();
  };

  return (
    <SettingsGroup label={t("settings.aiTheme.title")} block="ai-theme" description={t("settings.aiTheme.hint")}>
      <SettingsRows>
        <div className="flex flex-col gap-3 p-4">
          <textarea data-ai-theme-words="" rows={3} maxLength={600} value={words} placeholder={t("settings.aiTheme.placeholder")} aria-label={t("settings.aiTheme.placeholder")}
            onChange={(event) => setWords(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) make(); }}
            className={cn("min-h-[72px] w-full resize-none rounded-lg bg-app px-2 py-2 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus", FIELD_EDGE)} />
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept="image/*" hidden data-ai-theme-file="" onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = ""; }} />
            {picture ? (
              <span data-ai-theme-picture="" className="inline-flex h-8 items-center gap-2 rounded-full bg-raised pl-1 pr-2 ring-1 ring-hairline/60">
                <img src={picture.url} alt="" className="size-6 rounded-full object-cover" />
                <button type="button" aria-label={t("settings.aiTheme.removePicture")} title={t("settings.aiTheme.removePicture")} onClick={dropPicture}
                  className="flex size-5 cursor-pointer items-center justify-center rounded-full text-ink-secondary hover:text-ink"><X size={12} strokeWidth={2} /></button>
              </span>
            ) : (
              <button type="button" className="ui-button ui-button-sm" onClick={() => file.current?.click()}><ImageIcon size={14} strokeWidth={1.75} />{t("settings.aiTheme.fromPicture")}</button>
            )}
            <label data-ai-theme-brand="" className="ui-button ui-button-sm relative cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
              <span aria-hidden="true" className="size-3.5 rounded-full ring-1 ring-hairline" style={{ background: brand ?? DEFAULT_BRAND }} />
              {brand ? `${t("settings.aiTheme.brandColour")} ${brand}` : t("settings.aiTheme.brandColour")}
              <input type="color" className="sr-only" value={brand ?? DEFAULT_BRAND} onChange={(event) => setBrand(event.target.value)} />
            </label>
            {brand && (
              <button type="button" aria-label={t("settings.aiTheme.removeBrandColour")} title={t("settings.aiTheme.removeBrandColour")} onClick={() => setBrand(null)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-full text-ink-secondary hover:text-ink"><X size={12} strokeWidth={2} /></button>
            )}
            {problem && <span role="status" className="text-[12px] leading-4 text-ink-secondary">{t("settings.aiTheme.pictureError")}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label={t("settings.aiTheme.ideas")} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {IDEAS.map((entry) => <button key={entry.id} type="button" className="ui-pill cursor-pointer" data-ai-theme-idea={entry.id} onClick={() => idea(entry.id, entry.label())}>{entry.label()}</button>)}
            </div>
            <button type="button" data-ai-theme-make="" className="ui-button ui-button-primary ui-button-pill" disabled={!ready} onClick={make}>
              <Sparkles size={14} strokeWidth={1.75} />{t("settings.aiTheme.make")}
            </button>
          </div>
        </div>
      </SettingsRows>
    </SettingsGroup>
  );
}
