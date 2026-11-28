// The popular themes Seira ships, as theme files. Each has a dark and a light variant that follows the person's Light or
// dark choice. Backgrounds and accents are the upstream palettes; text, surfaces and lines derive from them, and the
// status colours are the upstream ones moved only as far as needed to stay legible on every surface (third_party/).
import type { ThemeFile } from "./theme.ts";

export interface PopularTheme {
  /** `popular-<slug>`: a saved theme with the same id wins over it. */
  id: string;
  name: string;
  /** What the theme's dark and light variants are called upstream. */
  variants: { dark: string; light: string };
  theme: ThemeFile;
}

export const POPULAR_THEMES: readonly PopularTheme[] = [
  {
    id: "popular-catppuccin",
    name: "Catppuccin",
    variants: { dark: "Catppuccin Mocha", light: "Catppuccin Latte" },
    theme: {
      name: "Catppuccin",
      skin: "system",
      dark: { canvas: "#1e1e2e", accent: "#cba6f7", colors: { success: "#a6e3a1", "success-ink": "#111111", danger: "#f38ba8", "danger-ink": "#111111", warning: "#f9e2af" } },
      light: { canvas: "#eff1f5", accent: "#8839ef", colors: { success: "#327c21", "success-ink": "#ffffff", danger: "#d20f39", "danger-ink": "#ffffff", warning: "#976014" } },
    },
  },
  {
    id: "popular-tokyo-night",
    name: "Tokyo Night",
    variants: { dark: "Tokyo Night Night", light: "Tokyo Night Day" },
    theme: {
      name: "Tokyo Night",
      skin: "system",
      dark: { canvas: "#1a1b26", accent: "#7aa2f7", colors: { success: "#9ece6a", "success-ink": "#111111", danger: "#f7768e", "danger-ink": "#111111", warning: "#e0af68" } },
      light: { canvas: "#e1e2e7", accent: "#2e7de9", colors: { success: "#516c35", "success-ink": "#ffffff", danger: "#be214e", "danger-ink": "#ffffff", warning: "#7b5f36" } },
    },
  },
  {
    id: "popular-dracula",
    name: "Dracula",
    variants: { dark: "Dracula Dracula", light: "Dracula Alucard" },
    theme: {
      name: "Dracula",
      skin: "system",
      dark: { canvas: "#282a36", accent: "#bd93f9", colors: { success: "#50fa7b", "success-ink": "#111111", danger: "#ff8080", "danger-ink": "#111111", warning: "#f1fa8c" } },
      light: { canvas: "#fffbeb", accent: "#644ac9", colors: { success: "#14710a", "success-ink": "#ffffff", danger: "#cb3a2a", "danger-ink": "#ffffff", warning: "#846e15" } },
    },
  },
  {
    id: "popular-one-dark",
    name: "One Dark",
    variants: { dark: "One Dark One Dark", light: "One Dark One Light" },
    theme: {
      name: "One Dark",
      skin: "system",
      dark: { canvas: "#282c34", accent: "#61afef", colors: { success: "#98c379", "success-ink": "#111111", danger: "#e89198", "danger-ink": "#111111", warning: "#e5c07b" } },
      light: { canvas: "#fafafa", accent: "#4078f2", colors: { success: "#40813f", "success-ink": "#ffffff", danger: "#c2493e", "danger-ink": "#ffffff", warning: "#9a6a01" } },
    },
  },
  {
    id: "popular-nord",
    name: "Nord",
    variants: { dark: "Nord Polar Night", light: "Nord Snow Storm" },
    theme: {
      name: "Nord",
      skin: "system",
      dark: { canvas: "#2e3440", accent: "#88c0d0", colors: { success: "#a3be8c", "success-ink": "#111111", danger: "#daa4a9", "danger-ink": "#111111", warning: "#ebcb8b" } },
      light: { canvas: "#eceff4", accent: "#5e81ac", colors: { success: "#4e753f", "success-ink": "#ffffff", danger: "#a2525a", "danger-ink": "#ffffff", warning: "#916327" } },
    },
  },
  {
    id: "popular-gruvbox",
    name: "Gruvbox",
    variants: { dark: "Gruvbox Dark", light: "Gruvbox Light" },
    theme: {
      name: "Gruvbox",
      skin: "system",
      dark: { canvas: "#282828", accent: "#fabd2f", colors: { success: "#b8bb26", "success-ink": "#111111", danger: "#fc7b6c", "danger-ink": "#111111", warning: "#fe8019" } },
      light: { canvas: "#fbf1c7", accent: "#af3a03", colors: { success: "#736e0d", "success-ink": "#ffffff", danger: "#9d0006", "danger-ink": "#ffffff", warning: "#956111" } },
    },
  },
  {
    id: "popular-rose-pine",
    name: "Rosé Pine",
    variants: { dark: "Rosé Pine Main", light: "Rosé Pine Dawn" },
    theme: {
      name: "Rosé Pine",
      skin: "system",
      dark: { canvas: "#191724", accent: "#ebbcba", colors: { success: "#9ccfd8", "success-ink": "#111111", danger: "#eb6f92", "danger-ink": "#111111", warning: "#f6c177" } },
      light: { canvas: "#faf4ed", accent: "#d7827e", colors: { success: "#286983", "success-ink": "#ffffff", danger: "#a2596e", "danger-ink": "#ffffff", warning: "#986622" } },
    },
  },
  {
    id: "popular-solarized",
    name: "Solarized",
    variants: { dark: "Solarized Dark", light: "Solarized Light" },
    theme: {
      name: "Solarized",
      skin: "system",
      dark: { canvas: "#002b36", accent: "#268bd2", colors: { success: "#97a826", "success-ink": "#111111", danger: "#ea8482", "danger-ink": "#111111", warning: "#c09b26", "accent-text": "#54a4dc", focus: "#54a4dc" } },
      light: { canvas: "#fdf6e3", accent: "#268bd2", colors: { success: "#677700", "success-ink": "#ffffff", danger: "#d1302d", "danger-ink": "#ffffff", warning: "#8c6a00" } },
    },
  },
  {
    id: "popular-ayu",
    name: "Ayu",
    variants: { dark: "Ayu Mirage", light: "Ayu Light" },
    theme: {
      name: "Ayu",
      skin: "system",
      dark: { canvas: "#1f2430", accent: "#ffcc66", colors: { success: "#d5ff80", "success-ink": "#111111", danger: "#f28779", "danger-ink": "#111111", warning: "#ffad66" } },
      light: { canvas: "#fcfcfc", accent: "#ffaa33", colors: { success: "#5e7d00", "success-ink": "#ffffff", danger: "#b45555", "danger-ink": "#ffffff", warning: "#a95f2a" } },
    },
  },
  {
    id: "popular-night-owl",
    name: "Night Owl",
    variants: { dark: "Night Owl Night Owl", light: "Night Owl Light Owl" },
    theme: {
      name: "Night Owl",
      skin: "system",
      dark: { canvas: "#011627", accent: "#82aaff", colors: { success: "#addb67", "success-ink": "#111111", danger: "#f05c59", "danger-ink": "#111111", warning: "#ecc48d" } },
      light: { canvas: "#fbfbfb", accent: "#4876d6", colors: { success: "#07835f", "success-ink": "#ffffff", danger: "#d33a38", "danger-ink": "#ffffff", warning: "#b05a58" } },
    },
  },
];

export const POPULAR_THEME_PREFIX = "popular-";

export const popularTheme = (id: string): PopularTheme | undefined => POPULAR_THEMES.find((entry) => entry.id === id);
