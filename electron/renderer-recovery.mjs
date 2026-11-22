// A window whose page ended is a blank window the person can only close. The main window's page loads again, after a
// growing pause, when its renderer ends, or when the page has not answered for HANG_LIMIT_MS (ended by force, so the
// reload runs in a new renderer). A page that keeps ending stops after RELOAD_LIMIT within RELOAD_WINDOW_MS: a reload
// loop only hides the cause. Then the window shows a page with a Reload link, or, when no page can start, a dialog.

import nativeText from "./native-text.cjs";
import { rendererRecoveryPage } from "./error-pages.mjs";

export const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 15_000]);
export const RELOAD_LIMIT = RETRY_DELAYS_MS.length;
export const RELOAD_WINDOW_MS = 60_000;
/** Chromium reports `unresponsive` after about ten seconds without an answer; this is the wait after that report. */
export const HANG_LIMIT_MS = 30_000;

export const exitCodeHex = (code) => (Number.isSafeInteger(code) ? `0x${(code >>> 0).toString(16)}` : "unknown");

const webAddress = (value) => {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
};

/**
 * `onHang(contents)` runs just before the forced end, so a listener can tell that end from a crash.
 * `onStop({ reason, exitCode, next })` runs once each time reloading stops; `next` is "page" or "dialog".
 * `showMessageBox(options)` shows a box with no parent window and resolves `{ response }`.
 * `createWindow()` makes and returns a new main window; `relaunch()` starts the app again and quits this run.
 * @param {{ isShuttingDown?: () => boolean, now?: () => number, log?: (line: string) => void, onHang?: (contents: unknown) => void,
 *   onStop?: (stop: { reason: string, exitCode: unknown, next: "page" | "dialog" }) => void, text?: { t: (key: string) => string },
 *   fallbackUrl?: () => string, showMessageBox?: (options: object) => Promise<{ response: number }>, createWindow?: () => unknown, relaunch?: () => void }} deps
 */
export function createRendererRecovery({ isShuttingDown = () => false, now = Date.now, log = () => {}, onHang = () => {}, onStop = () => {}, text = nativeText.englishText,
  fallbackUrl = () => "", showMessageBox = async () => ({ response: 2 }), createWindow = () => null, relaunch = () => {} } = {}) {
  let dialogOpen = false, relaunched = false;
  return {
    /** Watches one window's page for as long as the window lives. */
    attach(win) {
      const contents = win.webContents;
      let ended = [], stopped = false, hang = null, pending = null, onRecoveryPage = false, lastUrl = null;
      const alive = () => !win.isDestroyed() && !contents.isDestroyed();
      const clearHang = () => { clearTimeout(hang); hang = null; };
      const clearReload = () => { clearTimeout(pending); pending = null; };
      const recent = () => {
        const cutoff = now() - RELOAD_WINDOW_MS;
        ended = ended.filter((at) => at > cutoff);
        return ended.length;
      };
      const exhausted = () => recent() >= RELOAD_LIMIT;

      async function ask() {
        if (dialogOpen) return;
        dialogOpen = true;
        onRecoveryPage = false;
        let response = -1;
        try {
          ({ response } = await showMessageBox({ type: "error", message: text.t("native.rendererRecovery.dialog"), noLink: true, defaultId: 0, cancelId: 2,
            buttons: [text.t("native.rendererRecovery.tryAgain"), text.t("native.rendererRecovery.restart"), text.t("native.common.close")] }));
        } catch {}
        dialogOpen = false;
        if (isShuttingDown()) return;
        if (response === 0) {
          // The last window's destroy() quits the app, so the new window comes first.
          ended = []; stopped = false;
          createWindow();
          if (alive()) win.destroy();
        } else if (response === 1 && !relaunched) {
          relaunched = true;
          relaunch();
        } else if (response === 2 && alive()) {
          win.close();
        }
      }

      function showRecoveryPage() {
        const retry = lastUrl && webAddress(lastUrl) ? lastUrl : fallbackUrl();
        onRecoveryPage = true;
        let loading;
        try { loading = contents.loadURL(rendererRecoveryPage({ retryUrl: retry }, text)); } catch (error) { loading = Promise.reject(error); }
        Promise.resolve(loading).catch(() => { if (alive() && onRecoveryPage) void ask(); });
      }

      function stop(reason, exitCode, next) {
        stopped = true;
        log(`main window: its page ended again (${reason}, exit code ${exitCodeHex(exitCode)}); stop reloading it after ${RELOAD_LIMIT} times in ${RELOAD_WINDOW_MS / 1000} seconds`);
        try { onStop({ reason, exitCode, next }); } catch {}
        if (next === "page") showRecoveryPage(); else void ask();
      }

      contents.on("did-navigate", (_event, url) => {
        if (!webAddress(url)) return;
        lastUrl = url;
        onRecoveryPage = false;
        stopped = false;
      });
      contents.on("render-process-gone", (_event, details) => {
        clearHang();
        const reason = details?.reason ?? "unknown";
        if (reason === "clean-exit" || isShuttingDown() || !alive() || dialogOpen || pending !== null) return;
        const exitCode = details?.exitCode;
        if (onRecoveryPage) return stop(reason, exitCode, "dialog");
        if (exhausted()) {
          if (!stopped) stop(reason, exitCode, reason === "launch-failed" ? "dialog" : "page");
          return;
        }
        stopped = false;
        const delay = RETRY_DELAYS_MS[recent()];
        ended.push(now());
        log(`main window: its page ended (${reason}, exit code ${exitCodeHex(exitCode)}); loading it again in ${delay / 1000} seconds`);
        pending = setTimeout(() => {
          pending = null;
          if (isShuttingDown() || !alive() || dialogOpen) return;
          contents.reload();
        }, delay);
        pending.unref?.();
      });
      contents.on("unresponsive", () => {
        if (hang !== null || isShuttingDown()) return;
        hang = setTimeout(() => {
          hang = null;
          if (isShuttingDown() || !alive() || exhausted() || dialogOpen) return;
          log(`main window: its page did not respond for ${HANG_LIMIT_MS / 1000} seconds; ending it`);
          try { onHang(contents); } catch {}
          contents.forcefullyCrashRenderer();
        }, HANG_LIMIT_MS);
        hang.unref?.();
      });
      contents.on("responsive", clearHang);
      win.once("closed", () => { clearHang(); clearReload(); });
    },
  };
}
