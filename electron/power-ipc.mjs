// Security: only the local main window may ask the app to quit; a remote page never reaches this channel.
export function installPowerIpc({ ipcMain, localOnly, requireMainWindowSender, quit }) {
  ipcMain.handle("desktop:quit", localOnly("desktop:quit", (event) => {
    requireMainWindowSender(event);
    quit();
    return true;
  }));
}
