import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import nativeText from "./native-text.cjs";
import { FINISH_MS, STEP_NAMES } from "./splash/line.js";

const attribute = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const resource = (name) => fileURLToPath(new URL(`./resources/${name}`, import.meta.url));
const readResource = (name, encoding) => { try { return fs.readFileSync(resource(name), encoding); } catch { return null; } };
// Inside an inline script, "<" could close the tag; JSON stays valid with it escaped. The bundle is checked by the build.
const inlineJson = (text) => text.replaceAll("<", "\\u003c");

// Outside Electron, as in the node tests, require("electron") gives a path and there is no preference to read.
function systemReducedMotion() {
  try { return createRequire(import.meta.url)("electron").systemPreferences?.getAnimationSettings().prefersReducedMotion === true; } catch { return false; }
}

export function startupScreenHtml({ t = nativeText.englishText.t, lang = "en", reducedMotion = false } = {}) {
  const still = fs.readFileSync(resource("splash-seira.webp")).toString('base64');
  const kit = readResource("splash-kit.json", "utf8");
  const page = readResource("splash-page.js", "utf8");
  return `<!doctype html><html lang="${attribute(lang)}" data-reduced-motion="${reducedMotion}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Seira</title><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:Segoe UI,system-ui,sans-serif;color:#f5f5f5;background:transparent}
  main{--p:0;height:100%;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid #ffffff16;border-radius:20px;overflow:hidden;isolation:isolate;background:radial-gradient(ellipse at 50% 22%,#242529 0,#161719 54%,#111214 100%);-webkit-app-region:drag}
  main::before{content:"";position:absolute;z-index:-1;left:50%;top:92px;width:300px;height:220px;transform:translate(-50%,-50%);background:radial-gradient(closest-side,#ff2a5733,#ff2a5712 55%,transparent 100%);opacity:calc(.25 + var(--p) * .75);transition:opacity 400ms ease-out}
  .hero{position:relative;width:176px;height:176px;margin:-34px 0 -12px}
  .bot{position:absolute;inset:0;opacity:0;transition:opacity 160ms ease-out}.bot canvas{width:100%;height:100%;display:block}
  .still{position:absolute;left:50%;top:50%;width:99px;height:116px;margin:-58px 0 0 -49px;object-fit:contain;user-select:none;-webkit-user-drag:none}
  .live .bot{opacity:1}.live .still{display:none}
  h1{position:relative;font-size:25px;line-height:1.25;font-weight:600;letter-spacing:-.6px;margin:0 0 18px}
  .line{position:relative;width:184px;height:4px;margin-bottom:12px;border-radius:99px;background:#ffffff12;box-shadow:0 1px 0 #ffffff08}
  .fill{position:absolute;left:0;top:0;bottom:0;width:calc(var(--p) * 100%);border-radius:inherit;overflow:hidden;background:linear-gradient(90deg,#8f1230 0%,#E11D48 38%,#FF2A57 78%,#ff8aa3 100%);box-shadow:0 0 10px -1px #ff2a5799}
  .fill::after{content:"";position:absolute;inset:0;width:46px;left:-46px;background:linear-gradient(90deg,transparent,#ffffff8c,transparent);animation:sweep 1.5s cubic-bezier(.45,0,.25,1) infinite}
  .head{position:absolute;top:50%;left:calc(var(--p) * 100%);width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #ff2a5755,0 0 10px 2px #ff2a57,0 0 26px 6px #ff2a5755;opacity:min(1,calc(var(--p) * 30))}
  .head::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1px solid #ff2a5780;animation:ping 1.2s ease-out infinite}
  .finished .fill{background:linear-gradient(90deg,#E11D48,#FF2A57 60%,#ff9db2);box-shadow:0 0 16px 1px #ff2a57}
  .finished .head{transform:scale(1.35);transition:transform 240ms cubic-bezier(.22,1,.36,1)}
  .finished .head::after,.finished .fill::after{animation:none;opacity:0}
  .status{position:relative;height:18px;min-width:220px;color:#999da5;font-size:12px;line-height:18px;text-align:center}
  button{position:absolute;right:13px;top:13px;width:30px;height:30px;display:grid;place-items:center;padding:0;color:#999da5;border:0;border-radius:7px;background:transparent;cursor:pointer;-webkit-app-region:no-drag}
  button:hover{color:#fff;background:#ffffff10}button:focus-visible{outline:2px solid #1686ff;outline-offset:2px}button svg{pointer-events:none}
  @keyframes sweep{to{left:100%}}@keyframes ping{from{transform:scale(.5);opacity:1}to{transform:scale(1.6);opacity:0}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.fill::after,.head::after{display:none}}
  :root[data-reduced-motion="true"] *,:root[data-reduced-motion="true"] *::before,:root[data-reduced-motion="true"] *::after{animation:none!important;transition:none!important}
  :root[data-reduced-motion="true"] .fill::after,:root[data-reduced-motion="true"] .head::after{display:none}
  </style></head><body><main><button aria-label="${attribute(t("native.common.close"))}" onclick="window.startupScreen.close()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><div class="hero"><img class="still" src="data:image/webp;base64,${still}" alt=""><div class="bot"></div></div><h1>Seira</h1><div class="line" aria-hidden="true"><div class="fill"></div><span class="head"></span></div><div class="status" role="status"><span>Opening your workspace…</span></div>${kit ? `<script>window.__SEIRA_KIT=${inlineJson(kit)};</script>` : ""}${page ? `<script>${page}</script>` : ""}</main></body></html>`;
}

export function createStartupScreen({
  BrowserWindow, iconPath, platform = process.platform, isQuitting, onQuit,
  onHide, isHidden = () => false, onShow, onFinished, t, lang, reducedMotion = systemReducedMotion,
}) {
  let disposed = false, revealed = false, fallback, finishTimer, resolveReady;
  let reached = -1, finished = false;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const splash = new BrowserWindow({
    width: 440, height: 300, resizable: false, maximizable: false,
    fullscreenable: false, frame: false, transparent: true,
    backgroundColor: "#00000000", show: false, icon: iconPath,
    title: "Seira", autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      preload: fileURLToPath(new URL("./startup-screen-preload.cjs", import.meta.url)),
    },
  });
  splash.setMenu(null);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(fallback);
    clearTimeout(finishTimer);
    resolveReady();
    if (!splash.isDestroyed()) splash.destroy();
    onFinished?.();
  };
  splash.on("close", event => {
    if (disposed || isQuitting()) return;
    event.preventDefault();
    if (platform === "win32" && onHide) onHide(splash);
    else onQuit();
  });
  // Renderer window.close() bypasses BrowserWindow's cancellable close path, so the page asks for the native one.
  splash.webContents.on("ipc-message", (_event, channel) => {
    if (channel === "startup-screen:close" && !disposed) splash.close();
  });
  let shown = false;
  const showSplash = () => {
    if (shown || disposed || isQuitting()) return;
    shown = true; splash.show(); resolveReady();
  };
  splash.once("ready-to-show", showSplash);
  // Some Wayland compositors (COSMIC) never paint a hidden window, so ready-to-show never comes.
  splash.webContents.once("did-finish-load", () => {
    const grace = setTimeout(showSplash, 500);
    grace.unref?.();
  });
  splash.on("show", () => onShow?.(splash));
  splash.once("closed", resolveReady);
  // The splash stays until the main window replaces it: as the only window, destroying it would quit the app.
  splash.webContents.once("render-process-gone", resolveReady);
  let said = null;
  const say = () => {
    if (said === null || disposed || splash.isDestroyed()) return;
    void splash.webContents.executeJavaScript(`(() => { const line = document.querySelector('.status'); if (line?.lastChild) line.lastChild.textContent = ${JSON.stringify(said)}; })()`).catch(() => {});
  };
  const sendProgress = () => {
    if (disposed || splash.isDestroyed()) return;
    try { splash.webContents.send("startup-screen:progress", { step: STEP_NAMES[reached] ?? null, finished }); } catch {}
  };
  splash.webContents.on("did-finish-load", () => { say(); sendProgress(); });
  const startupFallback = setTimeout(resolveReady, 10_000);
  startupFallback.unref?.();
  void splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(startupScreenHtml({ t, lang, reducedMotion: reducedMotion() })))
    .catch(resolveReady);
  /** Moves the glow line to a startup step. The line never moves back. */
  const progress = (step) => {
    const at = STEP_NAMES.indexOf(step);
    if (at <= reached || disposed) return;
    reached = at; sendProgress();
  };
  /** Fills the line and shows the happy Seira. Closing the screen is the caller's work. */
  const splashFinish = () => {
    if (finished || disposed) return;
    finished = true; sendProgress();
  };
  void ready.then(() => progress("shown"));
  const attach = (win, { maximized = false } = {}) => {
    const reveal = () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      revealed = true;
      const minimized = !splash.isDestroyed() && splash.isMinimized();
      if (isHidden()) {
        win.setSkipTaskbar(true);
        win.hide();
        if (maximized) win.once("show", () => win.maximize());
      } else {
        if (maximized) win.maximize();
        if (minimized) { win.showInactive(); win.minimize(); }
        else { win.show(); win.focus(); }
      }
      dispose();
    };
    progress("window");
    const finish = () => {
      if (revealed || finishTimer) return;
      splashFinish();
      const wait = reducedMotion() ? 0 : FINISH_MS;
      if (wait === 0) reveal();
      else { finishTimer = setTimeout(reveal, wait); finishTimer.unref?.(); }
    };
    win.webContents.on("did-finish-load", () => {
      if (revealed || win.isDestroyed() || isQuitting()) return;
      progress("loaded");
      void win.webContents.executeJavaScript(`new Promise(resolve => {
        const root = document.getElementById('root');
        if (!root || root.childElementCount) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (root.childElementCount) { observer.disconnect(); resolve(); }
        });
        observer.observe(root, { childList: true });
      })`).then(finish).catch(reveal);
    });
    win.webContents.once("render-process-gone", reveal);
    win.once("show", () => { if (!revealed) { revealed = true; dispose(); } });
    win.once("closed", dispose);
    fallback = setTimeout(reveal, 10_000);
    fallback.unref?.();
  };
  /** The line under the name, in place of "Opening your workspace…". */
  const status = (text) => { said = String(text); say(); };
  return { ready, attach, dispose, status, progress, finish: splashFinish, window: splash };
}
