// Security: only the local main window may ask the app to restart or quit; a remote page never reaches these channels.
export function installPowerIpc({ ipcMain, localOnly, requireMainWindowSender, relaunch, quit }) {
  ipcMain.handle("desktop:relaunch", localOnly("desktop:relaunch", (event) => {
    requireMainWindowSender(event);
    relaunch();
    return true;
  }));
  ipcMain.handle("desktop:quit", localOnly("desktop:quit", (event) => {
    requireMainWindowSender(event);
    quit();
    return true;
  }));
}
