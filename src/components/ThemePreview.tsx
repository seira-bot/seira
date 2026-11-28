import type { CSSProperties } from "react";

import { THEME_COLOR_ROLES } from "../../shared/theme";
import type { SkinId } from "@/lib/skins";
import type { Mode } from "@/lib/theme/palette";
import { themeColors, themeMode, themeSkin, type ThemeLook } from "@/lib/theme/tokens";

/** The skin's tokens come from `skin`; a theme's come from `style`. Either way the app's own utility classes colour it. */
export function Miniature({ skin, style }: { skin?: SkinId; style?: CSSProperties }) {
  return (
    <div
      data-skin={skin}
      data-skin-preview=""
      aria-hidden="true"
      style={style}
      className="flex h-[78px] w-full overflow-hidden rounded-lg bg-app ring-1 ring-hairline/60"
    >
      <div className="flex w-[11px] shrink-0 flex-col items-center gap-[3px] bg-panel pt-[5px]">
        <span className="size-[5px] rounded-full bg-accent" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
      </div>
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] rounded-sm bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-full bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        <span className="h-[13px] w-[62%] self-end rounded-md bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] rounded-md bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-full bg-inset ring-1 ring-hairline" />
          <span className="flex size-[11px] items-center justify-center rounded-full bg-accent">
            <span
              className="h-[1.5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-ink)" }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

/** A theme's colour roles as inline custom properties, so the picture wears the theme without touching the window. */
export function themeTokens(theme: ThemeLook, mode: Mode): CSSProperties {
  const colors = themeColors(theme, mode);
  const tokens: Record<string, string> = {};
  for (const role of THEME_COLOR_ROLES) {
    const value = colors[role];
    if (value) tokens[`--color-${role}`] = value;
  }
  return tokens as CSSProperties;
}

/** A small picture of the app in a theme. `mode` is the person's Light or dark choice; a theme with both variants wears the matching one. */
export function ThemePreview({ theme, mode }: { theme: ThemeLook; mode: Mode }) {
  return <Miniature skin={themeSkin(theme)} style={themeTokens(theme, themeMode(theme, mode))} />;
}
