import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import nativeText from "./native-text.cjs";
import { createStartupScreen, fitScript, startupScreenHtml } from "./startup-screen.mjs";
import { FINISH_MS, STEP_AT, createLine } from "./splash/line.js";
import { createSystemTray } from "./system-tray.mjs";

const iconPath = fileURLToPath(new URL("./resources/app-icon.png", import.meta.url));
class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.visible = false;
    this.webContents = new EventEmitter();
    this.webContents.executeJavaScript = async () => {};
    this.webContents.sent = [];
    this.webContents.send = (channel, payload) => { this.webContents.sent.push([channel, payload]); };
  }
  setMenu() {}
  getBounds() { return this.bounds ?? { x: 0, y: 0, width: 440, height: 300 }; }
  loadURL() { queueMicrotask(() => this.emit("ready-to-show")); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  show() { this.visible = true; this.emit("show"); }
  showInactive() { this.show(); }
  hide() { this.visible = false; }
  focus() { this.focused = true; }
  isMinimized() { return this.minimized ?? false; }
  minimize() { this.minimized = true; }
  restore() { this.minimized = false; }
  maximize() { this.maximized = true; }
  setSkipTaskbar(value) { this.skipTaskbar = value; }
}
function fixture(options = {}) {
  const calls = [];
  let trayInstance;
  class Tray extends EventEmitter {
    constructor(_icon, guid) { super(); this.guid = guid; trayInstance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return this.destroyed ?? false; }
    destroy() { this.destroyed = true; calls.push("destroy-tray"); }
  }
  let active;
  const tray = createSystemTray({ Tray, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath,
    getWindow: () => active, onQuit: () => calls.push("quit") });
  const splash = createStartupScreen({ BrowserWindow: Window, iconPath, platform: "win32",
    isQuitting: () => false, onQuit: () => calls.push("quit"), onHide: win => tray.hide(win),
    isHidden: () => tray.isHidden(), onShow: win => tray.windowShown(win),
    onFinished: () => calls.push("finished"), reducedMotion: () => true, ...options });
  active = splash.window;
  const win = new Window();
  win.on("show", () => tray.windowShown(win));
  return { tray, trayInstance, splash, win, calls, setActive: value => { active = value; } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

class UnreadyWindow extends Window {
  loadURL() { return Promise.resolve(); }
}

test("a loading screen that never becomes ready cannot block server startup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  t.mock.timers.tick(9999); await flush();
  assert.equal(ready, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(ready, true);
  // Still the app's only window: destroying it would quit before the workspace exists.
  assert.equal(splash.window.destroyed, false);
  assert.deepEqual(calls, []);
  splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("a loading renderer crash unblocks startup before ready-to-show", async () => {
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  splash.window.webContents.emit("render-process-gone");
  await flush();
  assert.equal(ready, true);
  assert.equal(splash.window.destroyed, false);
  assert.deepEqual(calls, []);
});

test("a loaded page shows without ready-to-show, as on COSMIC Wayland", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, calls } = fixture({ BrowserWindow: UnreadyWindow });
  let ready = false;
  void splash.ready.then(() => { ready = true; });
  splash.window.webContents.emit("did-finish-load");
  t.mock.timers.tick(499); await flush();
  assert.equal(splash.window.visible, false); assert.equal(ready, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(splash.window.visible, true); assert.equal(ready, true);
  assert.deepEqual(calls, []);
});

test("ready-to-show and a loaded page show the splash once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let shows = 0;
  const { splash } = fixture({ onShow: () => { shows += 1; } });
  await splash.ready;
  splash.window.webContents.emit("did-finish-load");
  t.mock.timers.tick(500); await flush();
  assert.equal(shows, 1);
});

test("loading screen waits for mounted content before revealing the restored workspace", async () => {
  const { splash, win, calls } = fixture();
  await splash.ready;
  assert.equal(splash.window.visible, true);
  let mounted;
  win.webContents.executeJavaScript = () => new Promise(resolve => { mounted = resolve; });
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load");
  assert.equal(win.visible, false);
  mounted(); await flush();
  assert.equal(win.visible, true); assert.equal(win.maximized, true);
  assert.equal(win.focused, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("closing during startup keeps the eventual workspace hidden until tray restore", async () => {
  const { splash, win, tray, calls, setActive } = fixture();
  await splash.ready;
  let prevented = false;
  splash.window.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(tray.isHidden(), true);
  splash.attach(win, { maximized: true });
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(win.skipTaskbar, true);
  setActive(win); assert.equal(tray.show(), true);
  assert.equal(win.visible, true); assert.equal(win.skipTaskbar, false);
  assert.equal(win.maximized, true); assert.equal(tray.isHidden(), false);
  assert.deepEqual(calls, ["finished"]);
});

test("the tray's menu and the startup screen speak the app's language, and the tray says it again when it changes", () => {
  const text = nativeText.createNativeText({ saved: "en" });
  let trayInstance;
  class Tray extends EventEmitter {
    constructor() { super(); trayInstance = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return false; }
  }
  const tray = createSystemTray({ Tray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    iconPath, getWindow: () => null, onQuit: () => {}, t: text.t });
  assert.deepEqual(trayInstance.menu.map(item => item.label), ["Open Seira", undefined, "Quit Seira"]);
  text.set("pt-br");
  tray.relabel();
  assert.deepEqual(trayInstance.menu.map(item => item.label), ["Abrir o Seira", undefined, "Sair do Seira"]);
  assert.equal(trayInstance.tooltip, "Seira");
  const html = startupScreenHtml({ t: text.t, lang: text.intlTag() });
  assert.match(html, /<html lang="pt-BR" data-reduced-motion="false">/);
  assert.match(html, /<button aria-label="Fechar"/);
  assert.match(startupScreenHtml(), /<html lang="en"[^>]*>.*<button aria-label="Close"/s);
  assert.match(startupScreenHtml(), /<img class="still" src="data:image\/webp;base64,[A-Za-z0-9+/=]+" alt="">/);
});

test("tray restores minimized windows, supports explicit quit, and disposes once", async () => {
  const { splash, win, tray, trayInstance, setActive, calls } = fixture();
  await splash.ready; splash.dispose(); setActive(win);
  win.minimize(); tray.hide(win); trayInstance.emit("click");
  assert.equal(win.minimized, false); assert.equal(win.focused, true);
  assert.equal(win.skipTaskbar, false);
  trayInstance.menu[2].click();
  tray.destroy(); tray.destroy();
  assert.deepEqual(calls, ["finished", "quit", "destroy-tray"]);
  win.destroy(); assert.equal(tray.show(), false);
});

test("renderer crash reveals the workspace recovery surface", async () => {
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  win.webContents.emit("render-process-gone");
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
});

test("a renderer that never mounts has a bounded fallback", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture(); await splash.ready; splash.attach(win);
  t.mock.timers.tick(9999); assert.equal(win.visible, false);
  t.mock.timers.tick(1); assert.equal(win.visible, true);
  assert.equal(splash.window.destroyed, true);
});

test("quit never reveals a waiting workspace", async () => {
  let quitting = false;
  const { splash, win } = fixture({ isQuitting: () => quitting });
  await splash.ready; splash.attach(win); quitting = true; splash.dispose();
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false); assert.equal(splash.window.destroyed, true);
});

test("without a Windows tray or on another platform splash close quits", async () => {
  for (const options of [{ platform: "darwin" }, { onHide: undefined }]) {
    const { splash, calls } = fixture(options); await splash.ready;
    splash.window.emit("close", { preventDefault() {} });
    assert.deepEqual(calls, ["quit"]); splash.dispose();
  }
});

test("the loading screen says what the app waits on, before its page has loaded and after", async () => {
  const ran = [];
  class Said extends Window {
    constructor(options) { super(options); this.webContents.executeJavaScript = async (code) => { ran.push(code); }; }
  }
  const { splash } = fixture({ BrowserWindow: Said });
  splash.status("Waking My Cloud…");
  splash.window.webContents.emit("did-finish-load");
  assert.equal(ran.length, 2);
  for (const code of ran) { assert.match(code, /document\.querySelector\('\.status'\)/); assert.ok(code.includes(JSON.stringify("Waking My Cloud…"))); }
  splash.dispose();
  splash.status("Opening My Cloud…");
  assert.equal(ran.length, 2, "nothing after it is gone");
});

const progressOf = (splash) => splash.window.webContents.sent.filter(([channel]) => channel === "startup-screen:progress").map(([, state]) => state);

test("startup steps reach the page in order and never go back", async () => {
  const { splash } = fixture({ reducedMotion: () => false });
  await splash.ready;
  await flush();
  splash.progress("engine"); splash.progress("shown"); splash.progress("engine"); splash.progress("nonsense");
  splash.progress("loaded");
  assert.deepEqual(progressOf(splash).map(state => state.step), ["shown", "engine", "loaded"]);
  assert.ok(progressOf(splash).every(state => state.finished === false));
  splash.window.webContents.emit("did-finish-load");
  assert.deepEqual(progressOf(splash).at(-1), { step: "loaded", finished: false });
});

test("the line follows the steps forward and never back", () => {
  for (const reduced of [false, true]) {
    const line = createLine({ reduced });
    let last = 0;
    for (const step of [null, "shown", "engine", "window", "loaded"]) {
      if (step) line.reach(step);
      for (let i = 0; i < 40; i += 1) { const p = line.tick(16); assert.ok(p >= last); last = p; }
    }
    assert.ok(last >= STEP_AT.loaded - 0.001 && last < 1);
    assert.equal(line.reach("shown"), false);
    assert.ok(line.tick(16) >= last);
    line.finish();
    for (let i = 0; i < 40; i += 1) line.tick(16);
    assert.equal(line.position, 1);
  }
});

test("the finish beat adds at most 240 ms before the workspace shows", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.ok(FINISH_MS <= 240);
  const { splash, win, calls } = fixture({ reducedMotion: () => false });
  await splash.ready; splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, false);
  assert.deepEqual(progressOf(splash).map(state => [state.step, state.finished]).slice(-2), [["loaded", false], ["loaded", true]]);
  t.mock.timers.tick(FINISH_MS - 1);
  assert.equal(win.visible, false);
  t.mock.timers.tick(1);
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
});

test("a root that renders before the beat ends shows the workspace when the beat ends", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ reducedMotion: () => false });
  await splash.ready; splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  t.mock.timers.tick(FINISH_MS - 1);
  assert.equal(win.visible, false);
  t.mock.timers.tick(1);
  assert.equal(win.visible, true);
});

test("a root that renders after the beat ended shows the workspace at once", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ reducedMotion: () => false });
  await splash.ready; splash.attach(win);
  let mounted;
  win.webContents.executeJavaScript = () => new Promise(resolve => { mounted = resolve; });
  win.webContents.emit("did-finish-load"); await flush();
  t.mock.timers.tick(FINISH_MS + 500);
  assert.equal(win.visible, false);
  mounted(); await flush();
  assert.equal(win.visible, true); assert.equal(splash.window.destroyed, true);
});

test("a second page load does not start a second finish beat", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ reducedMotion: () => false });
  await splash.ready; splash.attach(win);
  let mounted;
  win.webContents.executeJavaScript = () => new Promise(resolve => { mounted = resolve; });
  win.webContents.emit("did-finish-load"); await flush();
  t.mock.timers.tick(FINISH_MS - 10);
  win.webContents.emit("did-finish-load"); await flush();
  t.mock.timers.tick(10);
  mounted(); await flush();
  assert.equal(win.visible, true);
});

class RejectingWindow extends Window {
  loadURL() { return Promise.reject(new Error("load failed")); }
}

test("a startup screen that fails to load still resolves ready, and the workspace shows", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ BrowserWindow: RejectingWindow, reducedMotion: () => false });
  await splash.ready;
  splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  t.mock.timers.tick(FINISH_MS);
  assert.equal(win.visible, true);
});

test("a workspace revealed before the startup screen was ready never lets it show late", async () => {
  const { splash, win, calls } = fixture({ BrowserWindow: UnreadyWindow });
  splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, true);
  assert.equal(splash.window.destroyed, true);
  assert.deepEqual(calls, ["finished"]);
  splash.window.emit("ready-to-show");
  assert.equal(splash.window.visible, false);
});

test("with reduced motion the workspace shows with no finish delay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ reducedMotion: () => true });
  await splash.ready; splash.attach(win);
  win.webContents.emit("did-finish-load"); await flush();
  assert.equal(win.visible, true);
});

test("the ten second fallback still shows the workspace", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { splash, win } = fixture({ reducedMotion: () => false });
  await splash.ready; splash.attach(win);
  win.webContents.executeJavaScript = () => new Promise(() => {});
  win.webContents.emit("did-finish-load");
  t.mock.timers.tick(10_000);
  assert.equal(win.visible, true);
});

test("the startup page keeps its tight CSP and carries the glow line and the still", () => {
  const html = startupScreenHtml({ reducedMotion: true });
  assert.ok(html.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`));
  assert.match(html, /data-reduced-motion="true"/);
  assert.match(html, /<div class="line" aria-hidden="true"><div class="fill"><\/div><span class="head"><\/span><\/div>/);
  assert.match(html, /<script>window\.__SEIRA_KIT=\{/);
  assert.ok(!/<(script|link|iframe)[^>]+(src|href)=/.test(html), "no external loads");
  assert.equal(html.split("</script>").length, 4, "three inline scripts, none closed early");
});

test("without the character kit the page still has the still image and the line", () => {
  const readFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    if (/splash-(kit\.json|page\.js)$/.test(String(file))) throw new Error("missing");
    return readFileSync(file, ...rest);
  };
  try {
    const html = startupScreenHtml();
    assert.ok(!html.includes("__SEIRA_KIT"));
    assert.match(html, /<img class="still"/);
    assert.match(html, /class="fill"/);
  } finally { fs.readFileSync = readFileSync; }
});

test("the packaged app ships every startup screen asset", () => {
  const config = fs.readFileSync(fileURLToPath(new URL("../electron-builder.yml", import.meta.url)), "utf8");
  const files = config.slice(config.indexOf("\nfiles:"));
  assert.match(files, /^\s+- electron\/\*\*$/m);
  for (const name of ["splash-seira.webp", "splash-kit.json", "splash-page.js"]) {
    assert.ok(fs.existsSync(fileURLToPath(new URL(`./resources/${name}`, import.meta.url))), name);
    assert.ok(!files.includes(`"!electron/resources/${name}"`) && !files.includes('"!electron/resources/**'), `${name} is not excluded`);
  }
});

test("the generated startup page script and kit match their sources", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/build-splash.mjs", import.meta.url)), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the packaged app keeps every module that a main process file imports", () => {
  const config = fs.readFileSync(fileURLToPath(new URL("../electron-builder.yml", import.meta.url)), "utf8");
  const files = config.slice(config.indexOf("\nfiles:"), config.indexOf("\nasar:"));
  const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
  const excluded = [...files.matchAll(/^\s+- "!([^"]+)"$/gm)].map(([, pattern]) => glob(pattern));
  assert.ok(excluded.length > 0);
  const dir = new URL("./", import.meta.url);
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".mjs") && !/\.(node-)?test\./.test(name))) {
    for (const [, spec] of fs.readFileSync(new URL(file, dir), "utf8").matchAll(/^import [^;]*? from ["'](\.\/[^"']+)["']/gm)) {
      const target = `electron/${spec.slice(2)}`;
      assert.ok(!excluded.some((pattern) => pattern.test(target)), `${file} imports ${target}, but electron-builder.yml leaves it out`);
    }
  }
});

const fitPage = (html, devicePixelRatio) => {
  const scale = /data-display-scale="([^"]*)"/.exec(html)?.[1];
  const root = { dataset: scale === undefined ? {} : { displayScale: scale }, style: {}, classes: [], classList: { add(name) { root.classes.push(name); } } };
  assert.ok(html.includes(`<script>${fitScript}</script>`));
  vm.runInNewContext(fitScript, { document: { documentElement: root }, devicePixelRatio });
  return root;
};

test("the loading screen shrinks back to its window when Linux text scaling makes the page larger", () => {
  const scaled = fitPage(startupScreenHtml({ displayScale: 1 }), 1.359375);
  assert.equal(Number(scaled.style.zoom).toFixed(4), (1 / 1.359375).toFixed(4));
  assert.deepEqual(scaled.classes, ["fit"]);
  for (const [displayScale, ratio] of [[1, 1], [2, 2], [1.5, 1.5], [null, 1.359375]]) {
    const page = fitPage(startupScreenHtml({ displayScale }), ratio);
    assert.equal(page.style.zoom, undefined); assert.deepEqual(page.classes, []);
  }
});

test("only Linux tells the loading screen its display scale", () => {
  for (const [platform, expected] of [["linux", true], ["win32", false], ["darwin", false]]) {
    let url = "";
    class Loaded extends Window { loadURL(value) { url = value; return super.loadURL(value); } }
    const { splash } = fixture({ BrowserWindow: Loaded, platform, displayScale: () => 1.25 });
    assert.equal(decodeURIComponent(url).includes('data-display-scale="1.25"'), expected, platform);
    splash.dispose();
  }
});

test("the loading screen uses the scale of the display that matches its window bounds, not the primary display", () => {
  let url = ""; let asked = null;
  class Loaded extends Window {
    bounds = { x: 2560, y: 0, width: 440, height: 300 };
    loadURL(value) { url = value; return super.loadURL(value); }
  }
  const screen = {
    getPrimaryDisplay: () => ({ scaleFactor: 1 }),
    getDisplayMatching: (bounds) => { asked = bounds; return { scaleFactor: bounds.x >= 2560 ? 2 : 1 }; },
  };
  const { splash } = fixture({ BrowserWindow: Loaded, platform: "linux", screen });
  assert.equal(asked.x, 2560);
  assert.ok(decodeURIComponent(url).includes('data-display-scale="2"'));
  splash.dispose();
});
