// A window whose page ended is a blank window the person can only close. The main window's page loads again when its
// renderer ends, or when the page has not answered for HANG_LIMIT_MS (ended by force, so the reload runs in a new
// renderer). A page that keeps ending stops after RELOAD_LIMIT within RELOAD_WINDOW_MS: a reload loop only hides the cause.

export const RELOAD_LIMIT = 3;
export const RELOAD_WINDOW_MS = 60_000;
/** Chromium reports `unresponsive` after about ten seconds without an answer; this is the wait after that report. */
export const HANG_LIMIT_MS = 30_000;

/**
 * `onHang(contents)` runs just before the forced end, so a listener can tell that end from a crash.
 * @param {{ isShuttingDown?: () => boolean, now?: () => number, log?: (line: string) => void, onHang?: (contents: unknown) => void }} deps
 */
export function createRendererRecovery({ isShuttingDown = () => false, now = Date.now, log = () => {}, onHang = () => {} } = {}) {
  return {
    /** Watches one window's page for as long as the window lives. */
    attach(win) {
      const contents = win.webContents;
      let ended = [], stopped = false, hang = null;
      const alive = () => !win.isDestroyed() && !contents.isDestroyed();
      const clearHang = () => { clearTimeout(hang); hang = null; };
      const recent = () => {
        const cutoff = now() - RELOAD_WINDOW_MS;
        ended = ended.filter((at) => at > cutoff);
        return ended.length;
      };
      const exhausted = () => recent() >= RELOAD_LIMIT;
      contents.on("render-process-gone", (_event, details) => {
        clearHang();
        const reason = details?.reason ?? "unknown";
        if (reason === "clean-exit" || isShuttingDown() || !alive()) return;
        if (exhausted()) {
          if (!stopped) { stopped = true; log(`main window: its page ended again (${reason}); stop reloading it after ${RELOAD_LIMIT} times in ${RELOAD_WINDOW_MS / 1000} seconds`); }
          return;
        }
        stopped = false;
        ended.push(now());
        log(`main window: its page ended (${reason}); loading it again`);
        contents.reload();
      });
      contents.on("unresponsive", () => {
        if (hang !== null || isShuttingDown()) return;
        hang = setTimeout(() => {
          hang = null;
          if (isShuttingDown() || !alive() || exhausted()) return;
          log(`main window: its page did not respond for ${HANG_LIMIT_MS / 1000} seconds; ending it`);
          try { onHang(contents); } catch {}
          contents.forcefullyCrashRenderer();
        }, HANG_LIMIT_MS);
        hang.unref?.();
      });
      contents.on("responsive", clearHang);
      win.once("closed", clearHang);
    },
  };
}
