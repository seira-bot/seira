import { actAllowed, cleanAct, initialState, step, validFeed } from "./glance-model.mjs";
import { createGlanceTray } from "./glance-tray.mjs";
import { validInset } from "./glance-top-inset.mjs";
import { createGlanceWindow } from "./glance-window.mjs";

/** The page answers an act within this time, or the answer counts as not sent. */
export const ACT_WAIT_MS = 10_000;
/** After this many helper failures in one run, Glance stays in the tray. */
const HELPER_FAILURES = 3;
const AVATAR_PX = 64, AVATAR_CACHE = 32, AVATAR_WAIT_MS = 1_500;

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/** Electron/Linux: Wayland gives an app no window position and no always-on-top, so Glance uses a tray icon there. */
export function isWaylandSession({ platform, env, switches = {} }) {
  if (platform !== "linux") return false;
  for (const value of [switches["ozone-platform"], switches["ozone-platform-hint"]]) {
    if (value === "wayland") return true;
    if (value === "x11") return false;
  }
  return env.XDG_SESSION_TYPE === "wayland" || (!env.XDG_SESSION_TYPE && Boolean(env.WAYLAND_DISPLAY));
}

/**
 * Takes the feed the main window's page sends and shows it in the visor, or in the tray on Wayland.
 * `getMainWindow`: the main window, if any. `revealChat({ botId, threadId })`: raises the main window on that chat.
 * `prefs`: glanceHidden() and setGlanceHidden(). `onHiddenChange()`: the View menu follows the choice.
 */
export function installGlance({ ipcMain, screen, BrowserWindow, Tray, Menu, nativeImage, fetch, getMainWindow, prefs, t, revealChat, onHiddenChange = () => {}, platform = process.platform, isWayland = false, x11Available = false, createHelperVisor = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, resolveInset = null, createVisor = createGlanceWindow, createTray = createGlanceTray }) {
  let model = initialState(), feed = null, view = null, pageOrigin = null, hidden = prefs.glanceHidden() === true;
  let visor = null, helper = false, failures = 0, helperOff = false, tray = null, timer = null, openToken = null, nextAct = 1, drawn = null;
  let inset = 0, insetReady = false, hideCount = 0, probing = null;
  const watched = new WeakSet(), waiting = new Map(), avatars = new Map(), loading = new Set();

  const page = () => { const win = getMainWindow(); return win && !win.isDestroyed() ? win : null; };
  const contentsOf = () => page()?.webContents ?? null;
  const fromMainFrame = (event) => {
    const contents = contentsOf(), frame = event.senderFrame;
    return Boolean(contents && frame && event.sender === contents && frame === contents.mainFrame);
  };
  /** The window's own page, in its main frame, on the origin the window shows: never a frame inside it or a page on its way elsewhere. */
  const askingOrigin = (event) => {
    if (!fromMainFrame(event)) return null;
    const contents = event.sender, origin = originOf(event.senderFrame.url);
    return origin && !contents.isLoadingMainFrame() && originOf(contents.getURL()) === origin ? origin : null;
  };
  const fromVisor = (event) => {
    const contents = visor?.contents();
    return Boolean(contents && event.sender === contents && event.senderFrame && event.senderFrame === contents.mainFrame);
  };

  function avatarFor(url) {
    if (!url || !pageOrigin) return null;
    const href = new URL(url, pageOrigin).href;
    if (avatars.has(href)) {
      const found = avatars.get(href);
      avatars.delete(href);
      avatars.set(href, found);
      return found;
    }
    if (!loading.has(href)) {
      loading.add(href);
      const origin = pageOrigin;
      void (async () => {
        let picture = null;
        try {
          const answer = await fetch(href, { signal: AbortSignal.timeout(AVATAR_WAIT_MS) });
          const image = answer.ok ? nativeImage.createFromBuffer(Buffer.from(await answer.arrayBuffer())) : null;
          if (image && !image.isEmpty()) picture = image.resize({ width: AVATAR_PX, height: AVATAR_PX, quality: "best" }).toDataURL();
        } catch { picture = null; }
        loading.delete(href);
        if (origin !== pageOrigin) return;
        avatars.set(href, picture);
        while (avatars.size > AVATAR_CACHE) avatars.delete(avatars.keys().next().value);
        if (picture) draw();
      })();
    }
    return null;
  }

  const payloadOf = () => ({
    entries: view.entries.map((entry) => ({
      key: entry.key, botId: entry.botId, threadId: entry.threadId, name: entry.name, color: entry.color, state: entry.state,
      line: entry.line, ask: entry.ask, avatar: avatarFor(entry.avatarUrl),
    })),
    done: view.done, openOn: openToken ? { key: openToken.key, id: openToken.requestId } : null, labels: view.labels, attached: platform === "darwin",
  });

  function draw() {
    if (!view) return;
    if (hidden) { visor?.close(); visor = null; drawn = null; insetReady = false; hideCount++; tray?.destroy(); tray = null; return; }
    const useHelper = isWayland && x11Available && Boolean(createHelperVisor) && !helperOff;
    if (isWayland && !useHelper) {
      if (!view.active) { tray?.destroy(); return; }
      tray ??= createTray({ Tray, Menu, nativeImage, t, onOpen: (target) => revealChat(target), onHide: () => setHidden(true) });
      tray.update(view);
      return;
    }
    if (!view.active) { visor?.hide(); drawn = null; insetReady = false; hideCount++; return; }
    if (visor && helper !== useHelper) { visor.close(); visor = null; drawn = null; insetReady = false; }
    if (tray && useHelper) { tray.destroy(); tray = null; }
    visor ??= useHelper ? createHelperVisor({ onAct: act, onFail: helperFailed }) : createVisor({ BrowserWindow, screen, platform, topInset: () => inset });
    helper = useHelper;
    if (resolveInset && platform === "linux" && !insetReady) {
      if (probing !== hideCount) {
        const round = hideCount, target = visor;
        probing = round;
        Promise.resolve().then(() => resolveInset()).catch(() => null).then((top) => {
          if (probing === round) probing = null;
          if (round !== hideCount || visor !== target) { draw(); return; }
          inset = validInset(top) ?? inset;
          insetReady = true;
          target.setTopInset?.(inset);
          draw();
        });
      }
      return;
    }
    const next = payloadOf(), mark = JSON.stringify(next);
    if (mark === drawn && visor.visible()) return;
    drawn = mark;
    visor.render(next);
  }

  function run() {
    const win = page();
    const out = step(model, feed, now(), { mainFocused: Boolean(win?.isFocused?.()), hidden });
    model = out.state;
    view = out.view;
    if (view.openOn) openToken = view.openOn;
    else if (openToken && !view.entries.some((entry) => entry.ask?.requestId === openToken.requestId)) openToken = null;
    if (timer) clearTimer(timer);
    timer = view.nextAt === null ? null : setTimer(() => { timer = null; run(); }, Math.max(0, view.nextAt - now()) + 10);
    timer?.unref?.();
    draw();
  }

  function forget() {
    model = initialState();
    feed = null;
    openToken = null;
    run();
  }

  function watch(contents) {
    if (watched.has(contents)) return;
    watched.add(contents);
    const win = page();
    win?.on?.("blur", run);
    contents.on("did-start-navigation", (details) => { if (details?.isMainFrame && !details.isSameDocument) forget(); });
    contents.on("render-process-gone", forget);
    win?.once?.("closed", forget);
  }

  function relay(act) {
    const contents = contentsOf();
    if (!contents || contents.isLoadingMainFrame()) return Promise.resolve(false);
    const id = String(nextAct++);
    return new Promise((resolve) => {
      const wait = setTimer(() => { waiting.delete(id); resolve(false); }, ACT_WAIT_MS);
      wait?.unref?.();
      waiting.set(id, { contents, resolve, wait });
      contents.send("glance:act", { id, act });
    });
  }

  ipcMain.on("glance:feed", (event, raw) => {
    const origin = askingOrigin(event);
    if (!origin) return;
    const clean = validFeed(raw);
    if (!clean) return;
    if (origin !== pageOrigin) { pageOrigin = origin; avatars.clear(); loading.clear(); }
    watch(event.sender);
    feed = clean;
    run();
  });

  ipcMain.on("glance:acted", (event, answer) => {
    if (!askingOrigin(event) || !answer || typeof answer.id !== "string") return;
    const found = waiting.get(answer.id);
    if (!found || found.contents !== event.sender) return;
    waiting.delete(answer.id);
    clearTimer(found.wait);
    found.resolve(answer.ok === true);
  });

  async function act(raw) {
    if (!view) return false;
    const clean = cleanAct(raw);
    if (!clean || !actAllowed({ bots: view.entries }, clean)) return false;
    if (clean.kind === "open") {
      revealChat({ botId: clean.botId, threadId: clean.threadId });
      return true;
    }
    return relay(clean);
  }

  function helperFailed() {
    failures++;
    visor = null;
    insetReady = false;
    drawn = null;
    if (failures >= HELPER_FAILURES) helperOff = true;
    run();
  }

  ipcMain.handle("glance-visor:act", (event, raw) => (fromVisor(event) ? act(raw) : false));

  ipcMain.handle("glance-visor:size", (event, size) => fromVisor(event) && visor?.setSize(size) === true);

  function setHidden(on) {
    hidden = on === true;
    prefs.setGlanceHidden(hidden);
    try { onHiddenChange(hidden); } catch {}
    run();
  }

  return {
    hidden: () => hidden,
    setHidden,
    relabel() { tray?.relabel(); },
    destroy() {
      if (timer) clearTimer(timer);
      visor?.close(); visor = null; tray?.destroy(); tray = null;
    },
  };
}
