// Works because styles.css keys skins on [data-skin], not :root[data-skin], so any element opens a skin context for its
// subtree.
import { Check } from "lucide-react";
import { SKINS, SKIN_MODE, applySkin, resolveSkin } from "@/lib/skins";
import { subscribeTheme, takeOffTheme, wornTheme } from "@/lib/theme/runtime";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import { useContext, useSyncExternalStore } from "react";
import { SettingsLook } from "./SettingsPrimitives";
import { Miniature } from "./ThemePreview";
import { useSkinChoice } from "./ThemeRow";

export function SkinPicker() {
  const active = resolveSkin(useSkinChoice());
  const wearing = useSyncExternalStore(subscribeTheme, () => wornTheme() !== null, () => false);
  const settings = useContext(SettingsLook);
  if (settings) {
    // Settings: no tile borders; a 56 px preview, the name under it, and the chosen one ringed in ink.
    return (
      <>
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4" role="radiogroup" aria-label={t("settings.theme.title")}>
          {SKINS.map((skin) => {
            const selected = skin.id === active && !wearing;
            const only = t(SKIN_MODE[skin.id] === "light" ? "settings.gallery.lightOnly" : "settings.gallery.darkOnly");
            return (
              <button key={skin.id} type="button" role="radio" aria-checked={selected} onClick={() => { applySkin(skin.id); takeOffTheme(); }}
                title={tFromServer(`skins.tagline.${skin.id}`, skin.tagline)}
                className="group flex cursor-pointer flex-col gap-2 rounded-lg text-left focus-visible:outline-none">
                {/* Every preview: a 0.5 px frame. The chosen one adds the 2 px ink ring and a 16 px check at its top right. */}
                <span className={cn("relative block rounded-lg ring-offset-2 ring-offset-(--color-menu) [&>[data-skin-preview]]:h-14 [&>[data-skin-preview]]:ring-0",
                  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_var(--settings-edge)] after:content-['']",
                  selected ? "ring-2 ring-ink" : "group-hover:ring-[0.5px] group-hover:ring-ink/25 group-focus-visible:ring-2 group-focus-visible:ring-focus")}>
                  <Miniature skin={skin.id} />
                  {selected && <span aria-hidden="true" data-skin-check="" className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-ink text-app"><Check size={12} strokeWidth={2.5} /></span>}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] leading-[18px] text-ink">{skin.name}</span>
                  <span className="truncate text-[11px] leading-4 text-ink-tertiary">{only}</span>
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SKINS.map((skin) => {
          const selected = skin.id === active;
          return (
            <button
              key={skin.id}
              type="button"
              onClick={() => {
                applySkin(skin.id);
                takeOffTheme();
              }}
              aria-pressed={selected}
              className={cn(
                "cursor-pointer flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                selected
                  ? "border-accent-border bg-control"
                  : "border-hairline/60 hover:border-hairline hover:bg-control/50",
              )}
            >
              <Miniature skin={skin.id} />
              <div className="flex items-start gap-1.5 px-0.5 pb-0.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{skin.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-secondary">
                    {tFromServer(`skins.tagline.${skin.id}`, skin.tagline)}
                  </div>
                </div>
                {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
