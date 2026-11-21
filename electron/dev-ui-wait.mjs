const POLL_MS = 2000;

const textOf = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function devWaitPage(url) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><html lang="en"><meta name="color-scheme" content="light dark"><title>Seira (dev)</title>
<style>
body{margin:0;display:grid;place-items:center;height:100vh;background:#fcfcfc;color:#121212;font:15px -apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif}
main{max-width:420px;padding:32px;text-align:center}
h2{margin:0 0 10px;font-size:18px;font-weight:600}
p{margin:0 0 10px;line-height:1.5;opacity:.7}
code{font-family:ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){body{background:#121212;color:#fcfcfc}}
</style>
<body><main><h2>Seira (dev) is waiting for the app</h2>
<p>Start <code>pnpm dev:server</code> and <code>pnpm dev</code> in two terminals.</p>
<p>This window opens the app when ${textOf(url)} answers.</p></main></body></html>`)
  );
}

export function loadDevUi({ win, url, fetch, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
  const origin = new URL(url).origin;
  let timer = null;
  let waiting = false;
  const stop = () => {
    waiting = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const gone = () => win.isDestroyed();
  const poll = async () => {
    timer = null;
    if (!waiting || gone()) return stop();
    let answered = false;
    try {
      await fetch(url);
      answered = true;
    } catch {
      answered = false;
    }
    if (!waiting || gone()) return stop();
    if (answered) {
      stop();
      log("dev ui answered, loading it");
      void win.loadURL(url).catch(() => {});
      return;
    }
    timer = setTimer(poll, POLL_MS);
  };
  win.webContents.on("did-fail-load", (_event, code, _description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || gone()) return;
    let failedOrigin = "";
    try {
      failedOrigin = new URL(failedUrl).origin;
    } catch {
      return;
    }
    if (failedOrigin !== origin || waiting) return;
    waiting = true;
    log("dev ui did not answer, showing the wait page");
    void win.loadURL(devWaitPage(url)).catch(() => {});
    timer = setTimer(poll, POLL_MS);
  });
  win.once("closed", stop);
  void win.loadURL(url).catch(() => {});
}
