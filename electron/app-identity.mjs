/** Matches `appId` in electron-builder.yml, which names the Start menu shortcut Windows ties toasts and the taskbar pin to. */
export const WINDOWS_APP_ID = "bot.seira.app";

export function applyWindowsAppId({ app, platform = process.platform }) {
  if (platform === "win32") app.setAppUserModelId(WINDOWS_APP_ID);
}
