export const CONNECT_SERVER_CHANNEL = "workspaces:connect-server";

/** Shows the Connect sheet on this computer's own page; without such a page, `fallback` opens Settings. */
export function openConnectSheet({ window, isLocal, fallback }) {
  const win = window();
  if (win && !win.isDestroyed() && !win.webContents.isLoadingMainFrame() && isLocal(win.webContents)) {
    win.webContents.send(CONNECT_SERVER_CHANNEL);
    return true;
  }
  fallback();
  return false;
}
