import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { POPULAR_THEMES } from "../../shared/popular-themes";
import { SKINS } from "@/lib/skins";
import { SettingsLook } from "./SettingsPrimitives";
import { ThemeGallery } from "./ThemeGallery";
import { ThemePreview } from "./ThemePreview";

const render = () => renderToStaticMarkup(createElement(SettingsLook.Provider, { value: true }, createElement(ThemeGallery)));

describe("ThemeGallery", () => {
  it("shows the popular themes and Seira's skins as cards, each in its own group", () => {
    const html = render();
    expect(html).toContain(">Popular<");
    expect(html).toContain(">Seira<");
    expect(html.indexOf(">Popular<")).toBeLessThan(html.indexOf(">Seira<"));
    expect(html.match(/data-popular-theme="/g)).toHaveLength(10);
    for (const entry of POPULAR_THEMES) {
      expect(html).toContain(`data-popular-theme="${entry.id}"`);
      expect(html).toContain(`${entry.variants.dark} · ${entry.variants.light}`);
    }
    for (const skin of SKINS) expect(html).toContain(`>${skin.name}<`);
    expect(html.match(/Light only|Dark only/g)).toHaveLength(SKINS.length);
    expect(html).toContain('data-settings-block="themes"');
  });

  it("marks no popular card as chosen while no theme is worn, and the skin in use as chosen", () => {
    const html = render();
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map(([radio]) => radio);
    expect(radios).toHaveLength(22);
    expect(radios.filter((radio) => radio.includes('aria-checked="true"'))).toHaveLength(1);
    expect(radios.filter((radio) => radio.includes("data-popular-theme") && radio.includes('aria-checked="true"'))).toEqual([]);
  });

  it("paints each preview from the theme's own colours in the person's mode", () => {
    const catppuccin = POPULAR_THEMES[0]!;
    const dark = renderToStaticMarkup(createElement(ThemePreview, { theme: catppuccin.theme, mode: "dark" }));
    const light = renderToStaticMarkup(createElement(ThemePreview, { theme: catppuccin.theme, mode: "light" }));
    expect(dark).toContain("--color-app:#1e1e2e");
    expect(light).toContain("--color-app:#eff1f5");
    expect(dark).not.toContain("data-skin=");
  });
});
