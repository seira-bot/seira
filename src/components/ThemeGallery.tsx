import { Check } from "lucide-react";
import { useSyncExternalStore } from "react";

import { POPULAR_THEMES, type PopularTheme } from "../../shared/popular-themes";
import { cn } from "@/lib/cn";
import { useColorScheme } from "@/lib/color-scheme";
import { t } from "@/lib/i18n";
import { subscribeTheme, wearPopularTheme, wornTheme } from "@/lib/theme/runtime";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { SkinPicker } from "./SkinPicker";
import { ThemePreview } from "./ThemePreview";

const variantLabel = (name: string, variant: string) => (variant.startsWith(`${name} `) ? variant.slice(name.length + 1) : variant);

function PopularCard({ entry, selected, mode }: { entry: PopularTheme; selected: boolean; mode: "light" | "dark" }) {
  const { dark, light } = entry.theme;
  return (
    <button type="button" role="radio" aria-checked={selected} data-popular-theme={entry.id} onClick={() => void wearPopularTheme(entry.id)}
      className="group flex cursor-pointer flex-col gap-2 rounded-lg text-left focus-visible:outline-none">
      <span className={cn("relative block rounded-lg ring-offset-2 ring-offset-(--color-menu) [&>[data-skin-preview]]:h-[88px] [&>[data-skin-preview]]:ring-0",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_var(--settings-edge)] after:content-['']",
        selected ? "ring-2 ring-ink" : "group-hover:ring-[0.5px] group-hover:ring-ink/25 group-focus-visible:ring-2 group-focus-visible:ring-focus")}>
        <ThemePreview theme={entry.theme} mode={mode} />
        {selected && <span aria-hidden="true" data-skin-check="" className="absolute -right-2 -top-2 flex size-4 items-center justify-center rounded-full bg-ink text-app"><Check size={12} strokeWidth={2.5} /></span>}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] leading-[18px] text-ink">{entry.name}</span>
        <span className="flex items-center gap-1.5 text-[11px] leading-4 text-ink-tertiary">
          <span className="truncate">{`${variantLabel(entry.name, entry.variants.dark)} · ${variantLabel(entry.name, entry.variants.light)}`}</span>
          <span aria-hidden="true" className="ml-auto flex shrink-0 gap-1">
            <span className="size-2 rounded-full ring-1 ring-hairline" style={{ background: dark?.canvas }} />
            <span className="size-2 rounded-full ring-1 ring-hairline" style={{ background: light?.canvas }} />
          </span>
        </span>
      </span>
    </button>
  );
}

/** Settings → Appearance: the popular themes and Seira's own skins as cards; one tap wears it in every window. */
export function ThemeGallery() {
  const mode = useColorScheme();
  const wornId = useSyncExternalStore(subscribeTheme, () => wornTheme()?.id ?? null, () => null);
  return (
    <>
      <SettingsGroup label={t("settings.gallery.popular")} block="themes" description={t("settings.gallery.popularHint")}>
        <SettingsRows>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-5 p-4" role="radiogroup" aria-label={t("settings.gallery.popular")}>
            {POPULAR_THEMES.map((entry) => <PopularCard key={entry.id} entry={entry} selected={wornId === entry.id} mode={mode} />)}
          </div>
        </SettingsRows>
      </SettingsGroup>
      <SettingsGroup label={t("settings.gallery.seira")} block="skins">
        <SettingsRows>
          <div className="p-4"><SkinPicker /></div>
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}
