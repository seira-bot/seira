// A theme a bot offers in the chat (app_settings show_theme): a light and a dark picture of it, and Wear it, Save and Try
// another. Wearing and saving go through the person's own theme routes, so the card works after a reload and in every window.
import { Check, Palette, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { ThemeCardData } from "../../packages/phone-protocol/src/theme-card";
import { themeFileSchema, type ThemeFile, type ThemeList } from "../../shared/theme";
import { contrastRatio } from "@/lib/color-contrast";
import { randomUuid } from "@/lib/random-uuid";
import { t } from "@/lib/i18n";
import { applySkinChoice, readSkinChoice, THEME_SKINS } from "@/lib/skins";
import { loadTheme, subscribeTheme, wearTheme, wornTheme } from "@/lib/theme/runtime";
import { themeColors, themeMode, type ThemeLook } from "@/lib/theme/tokens";
import { api, ApiError, type Message } from "@/state/store";
import { askPrimary, ASK_BUTTON_SHAPE, ASK_SECONDARY_BUTTON } from "./AskCard";
import { ThemePreview } from "./ThemePreview";

const READABLE_RATIO = 4.5;
const HEX = /^#[0-9a-f]{6}$/i;
const PAIRS = [["ink", "app"], ["accent-ink", "accent"], ["bubble-user-ink", "bubble-user"]] as const;

type Busy = "wear" | "save" | "undo" | "more" | null;

/** The card's theme as the file the server saves; null when it does not fit the theme format. */
function fileOf(card: ThemeCardData): ThemeFile | null {
  const parsed = themeFileSchema.safeParse({ ...card.theme, name: card.name });
  return parsed.success ? parsed.data : null;
}

/** True only when every text pair that can be measured in both pictures reads at 4.5 to 1 or better. */
function easyToRead(theme: ThemeLook): boolean {
  let measured = 0;
  for (const mode of ["light", "dark"] as const) {
    const colors = themeColors(theme, themeMode(theme, mode));
    for (const [ink, ground] of PAIRS) {
      const a = colors[ink];
      const b = colors[ground];
      if (!a || !b || !HEX.test(a) || !HEX.test(b)) continue;
      measured++;
      if (contrastRatio(a, b) < READABLE_RATIO) return false;
    }
  }
  return measured > 0;
}

const problem = (cause: unknown) => (cause instanceof ApiError && cause.message ? cause.message : t("chat.themeCard.failed"));

export function ThemeCard({ botId, threadId, message, viewOnly }: { botId: string; threadId?: string; message: Message; viewOnly?: boolean }) {
  const card = message.themeCard;
  const wornId = useSyncExternalStore(subscribeTheme, () => wornTheme()?.id ?? null, () => null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [wore, setWore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = card?.id;

  const refresh = useCallback(() => {
    if (!id) return;
    api<ThemeList>("/api/themes", { background: true }).then((list) => setSaved(list.themes.some((theme) => theme.id === id)), () => undefined);
  }, [id]);
  useEffect(refresh, [refresh]);

  if (!card) return null;
  const file = fileOf(card);
  if (!file) return <p dir="auto" className="max-w-[600px] text-[15px] leading-relaxed text-ink">{message.text}</p>;
  const worn = wornId === card.id;
  const kept = saved || worn;
  const readable = easyToRead(file);
  const disabled = busy !== null || viewOnly === true;

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    if (disabled) return;
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(problem(cause));
    } finally {
      setBusy(null);
    }
  };

  const wear = () => run("wear", async () => {
    const choice = readSkinChoice();
    const plain = choice === "system" || choice === THEME_SKINS.light || choice === THEME_SKINS.dark;
    await api("/api/themes/active", { method: "PUT", body: JSON.stringify({ id: card.id, theme: file, ...(plain ? {} : { skin: "system" }) }) });
    if (!plain) applySkinChoice("system");
    wearTheme({ id: card.id, theme: file });
    await loadTheme();
    setSaved(true);
    setWore(true);
  });
  const save = () => run("save", async () => {
    await api(`/api/themes/${card.id}`, { method: "PUT", body: JSON.stringify({ theme: file }) });
    setSaved(true);
  });
  const undo = () => run("undo", async () => {
    await api("/api/themes/history", { method: "POST", body: JSON.stringify({ steps: 1 }) });
    setWore(false);
    await loadTheme();
    refresh();
  });
  const another = () => run("more", async () => {
    if (!threadId) return;
    await api(`/api/bots/${encodeURIComponent(botId)}/messages`, { method: "POST", body: JSON.stringify({ threadId, sendId: randomUuid(), text: t("chat.themeCard.anotherAsk", { name: card.name }) }) });
  });

  const primary = askPrimary(undefined);
  return (
    <div data-theme-card={card.id} role="group" aria-label={t("chat.themeCard.aria", { name: card.name })} className="flex w-full max-w-[540px] flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-[0.5px] ring-ink/[0.14]">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Palette aria-hidden="true" size={18} className="shrink-0 text-ink-secondary" />
            <span dir="auto" className="min-w-0 break-words text-[17px] font-semibold leading-6 text-ink">{card.name}</span>
            {readable && (
              <span data-theme-readable="" className="inline-flex items-center gap-1 text-[13px] leading-5 text-ink-secondary">
                <Check aria-hidden="true" size={13} className="text-success" />{t("chat.themeCard.readable")}
              </span>
            )}
          </div>
          {card.description && <p dir="auto" className="m-0 text-[14px] leading-5 text-ink-secondary">{card.description}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
          {(["light", "dark"] as const).map((mode) => (
            <figure key={mode} data-theme-preview={mode} className="m-0 flex flex-col gap-1.5">
              <div className="[&>[data-skin-preview]]:h-[120px]"><ThemePreview theme={file} mode={mode} /></div>
              <figcaption className="text-[13px] leading-5 text-ink-secondary">{t(mode === "light" ? "chat.themeCard.light" : "chat.themeCard.dark")}</figcaption>
            </figure>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-theme-wear="" disabled={disabled || worn} onClick={() => void wear()} className={primary.className} style={primary.style}>
            {worn && <Check aria-hidden="true" size={15} />}{t(worn ? "chat.themeCard.wearing" : "chat.themeCard.wear")}
          </button>
          <button type="button" data-theme-save="" disabled={disabled || kept} onClick={() => void save()} className={ASK_SECONDARY_BUTTON}>
            {kept && <Check aria-hidden="true" size={15} />}{t(kept ? "chat.themeCard.saved" : "chat.themeCard.save")}
          </button>
          {threadId && !viewOnly && (
            <button type="button" data-theme-another="" disabled={disabled} onClick={() => void another()} className={`${ASK_BUTTON_SHAPE} text-ink-secondary enabled:hover:bg-ink/[0.06] enabled:hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}>
              <RefreshCw aria-hidden="true" size={15} />{t("chat.themeCard.another")}
            </button>
          )}
        </div>
        {error && <p role="alert" data-theme-error="" className="m-0 text-[13px] leading-5 text-danger">{error}</p>}
      </div>
      {wore && worn && (
        <div data-theme-status="" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-ink-tertiary">
          <Check aria-hidden="true" size={13} className="shrink-0 text-success/80" />
          <span className="min-w-0 break-words">{t("chat.themeCard.status", { name: card.name })}</span>
          <button type="button" data-theme-undo="" disabled={disabled} onClick={() => void undo()} className="inline-flex items-center gap-1 rounded text-ink-secondary underline-offset-2 hover:text-ink hover:underline disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <Undo2 aria-hidden="true" size={13} />{t("chat.themeCard.undo")}
          </button>
        </div>
      )}
    </div>
  );
}
