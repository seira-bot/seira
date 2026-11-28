/** A theme a bot offers in the chat (app_settings show_theme): colours only, never CSS. `id` is the id it is saved under if
 * the person keeps it. The row's `text` is the English line for a client that does not know this field. */
export interface ThemeCardVariant {
  canvas?: string;
  accent?: string;
  colors?: Record<string, string>;
}
export interface ThemeCardData {
  id: string;
  name: string;
  description?: string;
  theme: ThemeCardVariant & { skin?: string; light?: ThemeCardVariant; dark?: ThemeCardVariant };
}
export interface ThemeCardField {
  themeCard?: ThemeCardData;
}
