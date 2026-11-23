import { randomUUID } from "node:crypto";

const START_HOSTS = ["composio.dev"];
const PAGE_HOSTS = ["composio.dev", "github.com"];
const CLOSE_DELAY_MS = 1_500;

function parseUrl(raw) {
  try {
    return new URL(String(raw));
  } catch {
    return null;
  }
}

function inHosts(host, roots) {
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

function allowedPage(raw) {
  const url = parseUrl(raw);
  return Boolean(url) && url.protocol === "https:" && !url.username && !url.password && inHosts(url.hostname, PAGE_HOSTS);
}

function hostOf(raw) {
  return parseUrl(raw)?.hostname ?? "";
}

function navigationUrl(event, url) {
  return typeof event?.url === "string" ? event.url : url;
}

function isMainFrame(event, flag) {
  return event?.isMainFrame ?? flag ?? true;
}

/** Security: a sign-in window with no saved sign-ins. It starts only on a composio.dev page, follows only https pages of
 * composio.dev and github.com, has no preload and no permissions, and clears its in-memory session when it closes. */
export function openCleanSignIn({ BrowserWindow, session, randomId = randomUUID, setTimer = setTimeout }, rawUrl) {
  const start = parseUrl(rawUrl);
  if (!start || start.protocol !== "https:" || start.username || start.password || !inHosts(start.hostname, START_HOSTS)) {
    throw new Error("This sign-in page cannot be opened");
  }
  const partition = `clean-sign-in-${randomId()}`;
  const clean = session.fromPartition(partition);
  clean.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  clean.setPermissionCheckHandler(() => false);
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    autoHideMenuBar: true,
    title: start.hostname,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  const contents = win.webContents;
  let inFlight = start.href;
  let reachedGithub = false;
  let timer = null;

  const track = (url) => {
    inFlight = url;
    if (inHosts(hostOf(url), ["github.com"])) reachedGithub = true;
  };
  const finish = () => {
    if (timer) return;
    timer = setTimer(() => { if (!win.isDestroyed?.()) win.close(); }, CLOSE_DELAY_MS);
    timer.unref?.();
  };
  const block = (event, url) => { if (!allowedPage(url)) event.preventDefault(); };

  contents.on("page-title-updated", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => block(event, navigationUrl(event, url)));
  contents.on("will-redirect", (event, url, _inPlace, mainFlag) => {
    if (!isMainFrame(event, mainFlag)) return;
    const target = navigationUrl(event, url);
    if (reachedGithub && inHosts(hostOf(inFlight), ["composio.dev"])) finish();
    block(event, target);
    if (!event.defaultPrevented) track(target);
  });
  contents.on("did-start-navigation", (event, url, _inPlace, mainFlag) => {
    if (isMainFrame(event, mainFlag)) track(navigationUrl(event, url));
  });
  contents.on("did-navigate", (_event, url) => {
    const host = hostOf(url);
    win.setTitle(host);
    if (inHosts(host, ["github.com"])) reachedGithub = true;
    else if (reachedGithub && inHosts(host, ["composio.dev"])) finish();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedPage(url)) void Promise.resolve(contents.loadURL(url)).catch(() => {});
    return { action: "deny" };
  });
  win.on("closed", () => {
    if (timer) clearTimeout(timer);
    void Promise.resolve(clean.clearStorageData()).catch(() => {});
    void Promise.resolve(clean.clearCache()).catch(() => {});
  });
  void Promise.resolve(contents.loadURL(start.href)).catch(() => {});
  return true;
}
