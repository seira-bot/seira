import { fileURLToPath } from "node:url";
import { glancePageHtml } from "./glance-page.mjs";

export const GLANCE_WINDOW = Object.freeze({ gap: 8, start: Object.freeze({ width: 380, height: 48 }), maxWidth: 640, maxHeight: 520, fadeMs: 180 });

/** Top centre of the primary display. macOS takes the very top, so the visor grows out of the notch; Windows and X11 keep it under the work area's edge. */
export function glanceBounds(display, platform, size) {
  const width = Math.round(size.width), height = Math.round(size.height);
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: platform === "darwin" ? display.bounds.y : display.workArea.y + GLANCE_WINDOW.gap,
    width,
    height,
  };
}

const inRange = (value, max) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= max;

export function createGlanceWindow({ BrowserWindow, screen, platform = process.platform, preload = fileURLToPath(new URL("./glance-preload.cjs", import.meta.url)), setTimer = setTimeout }) {
  let win = null, loaded = false, shown = false, payload = null, size = GLANCE_WINDOW.start, tracking = null;
  const live = (target) => Boolean(target) && !target.isDestroyed();
  const place = () => { if (live(win)) win.setBounds(glanceBounds(screen.getPrimaryDisplay(), platform, size)); };

  function create() {
    const target = new BrowserWindow({
      // Electron/macOS: a panel does not take focus from the app in front.
      ...(platform === "darwin" ? { type: "panel" } : {}),
      ...glanceBounds(screen.getPrimaryDisplay(), platform, size),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // Electron/macOS: lets a click on an inactive window reach the page.
      acceptFirstMouse: true,
      hiddenInMissionControl: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload },
    });
    target.excludedFromShownWindowsMenu = true;
    target.setAlwaysOnTop(true, "screen-saver");
    // Electron/macOS: skipTransformProcessType keeps the Dock icon.
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    target.webContents.on("will-navigate", (event) => event.preventDefault());
    target.webContents.on("did-finish-load", () => {
      if (win !== target) return;
      loaded = true;
      if (payload) paint();
    });
    target.on("closed", () => { if (win === target) { win = null; loaded = false; shown = false; untrack(); } });
    tracking = () => place();
    screen.on("display-metrics-changed", tracking);
    target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(glancePageHtml())}`).catch(() => {});
    return target;
  }

  function paint() {
    win.webContents.executeJavaScript(`render(${JSON.stringify(payload)})`).catch(() => {});
  }

  function untrack() {
    if (tracking) screen.removeListener("display-metrics-changed", tracking);
    tracking = null;
  }

  return {
    render(next) {
      payload = next;
      if (!live(win)) { win = create(); loaded = false; shown = false; }
      if (loaded) paint();
    },
    /** The visor page asks for the size of what it shows; the window grows or shrinks to it, so no clear area blocks a click. */
    setSize(request) {
      if (!live(win) || !request || !inRange(request.width, GLANCE_WINDOW.maxWidth) || !inRange(request.height, GLANCE_WINDOW.maxHeight)) return false;
      size = { width: request.width, height: request.height };
      place();
      if (!shown) { shown = true; win.showInactive(); }
      return true;
    },
    /** Fades the visor out and keeps its window for the next time a bot works. */
    hide() {
      const target = win;
      payload = null;
      if (!live(target) || !shown) return;
      shown = false;
      if (loaded) target.webContents.executeJavaScript("fadeOut()").catch(() => {});
      setTimer(() => { if (win === target && !shown && live(target)) target.hide(); }, GLANCE_WINDOW.fadeMs);
    },
    close() {
      const target = win;
      win = null; loaded = false; shown = false; payload = null;
      untrack();
      if (live(target)) target.destroy();
    },
    contents: () => (live(win) ? win.webContents : null),
    visible: () => shown,
  };
}
