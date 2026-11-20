import { fileURLToPath } from "node:url";

/** Matches `appId` in electron-builder.yml, which names the Start menu shortcut Windows ties toasts and the taskbar pin to. */
export const WINDOWS_APP_ID = "bot.seira.app";

export const SOURCE_ICON = fileURLToPath(new URL("../build/icon.ico", import.meta.url));

/**
 * From source, no shortcut carries the ID, so Windows 11 shows the electron.exe icon on the taskbar.
 * The window relaunch properties give the button its own icon. Windows reads the relaunch icon
 * only when the relaunch command and display name are also set.
 * The ID stays the same, so toasts keep working. A packaged build embeds the icon and installs the shortcut.
 */
export function sourceTaskbarIcon({ platform, isPackaged, iconPath = SOURCE_ICON, execPath = process.execPath, appPath = "" }) {
  if (platform !== "win32" || isPackaged) return null;
  return {
    appId: WINDOWS_APP_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: `"${execPath}" "${appPath}"`,
    relaunchDisplayName: "Seira",
  };
}

export function applyWindowsAppId({ app, platform = process.platform, iconPath }) {
  if (platform !== "win32") return;
  app.setAppUserModelId(WINDOWS_APP_ID);
  const details = sourceTaskbarIcon({ platform, isPackaged: app.isPackaged, iconPath, appPath: app.isPackaged ? "" : app.getAppPath() });
  if (!details) return;
  app.on("browser-window-created", (_event, win) => {
    win.setAppDetails(details);
    win.setIcon(details.appIconPath);
  });
}
