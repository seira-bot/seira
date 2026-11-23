import { fileURLToPath } from "node:url";

/** Matches `appId` in electron-builder.yml, which names the Start menu shortcut Windows ties toasts and the taskbar pin to. */
export const WINDOWS_APP_ID = "bot.seira.app";

/** A run from source must not share the ID of the installed app: Windows keys taskbar pins and relaunch data by this ID. */
export const WINDOWS_SOURCE_APP_ID = "bot.seira.app.dev";

export const SOURCE_ICON = fileURLToPath(new URL("../build/icon.ico", import.meta.url));

/**
 * Windows reads the relaunch icon only when the relaunch command and display name are also set.
 * Windows shows toasts only for an ID that a Start menu shortcut carries, so toasts from source do not show.
 * An MSIX package gets its identity from the package, so it needs no details.
 */
export function windowsTaskbarDetails({ platform, isPackaged, windowsStore = false, iconPath = SOURCE_ICON, execPath = process.execPath, appPath = "" }) {
  if (platform !== "win32" || windowsStore) return null;
  if (isPackaged) {
    return { appId: WINDOWS_APP_ID, appIconPath: execPath, appIconIndex: 0, relaunchCommand: `"${execPath}"`, relaunchDisplayName: "Seira" };
  }
  return { appId: WINDOWS_SOURCE_APP_ID, appIconPath: iconPath, appIconIndex: 0, relaunchCommand: `"${execPath}" "${appPath}"`, relaunchDisplayName: "Seira (dev)" };
}

export function applyWindowsAppId({ app, platform = process.platform, iconPath, windowsStore = process.windowsStore === true }) {
  if (platform !== "win32") return;
  app.setAppUserModelId(app.isPackaged ? WINDOWS_APP_ID : WINDOWS_SOURCE_APP_ID);
  const details = windowsTaskbarDetails({ platform, isPackaged: app.isPackaged, windowsStore, iconPath, appPath: app.isPackaged ? "" : app.getAppPath() });
  if (!details) return;
  app.on("browser-window-created", (_event, win) => {
    win.setAppDetails(details);
    if (!app.isPackaged) win.setIcon(details.appIconPath);
  });
}
