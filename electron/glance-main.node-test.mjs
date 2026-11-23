import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ACT_WAIT_MS, installGlance, isWaylandSession } from "./glance-main.mjs";
import { createGlanceWindow, glanceBounds } from "./glance-window.mjs";

const ORIGIN = "https://studio.example.com";
const LABELS = Object.fromEntries(["glance", "working", "needsYou", "question", "failed", "finished", "failedLine", "openChat", "deny", "allowOnce", "alwaysAllow", "couldNotSend", "close"].map((k) => [k, k]));
const bot = (id, extra = {}) => ({ botId: id, threadId: `t-${id}`, name: id, avatarUrl: null, color: null, state: "working", line: "Working", startedAt: 1, ask: null, ...extra });
const approval = { kind: "approval", requestId: "r1", title: "Run", detail: "ls", choices: [], canAlways: true };
const feed = (...bots) => ({ version: 1, lang: "en", bots, labels: LABELS });

function world({ wayland = false, hidden = false, focused = false } = {}) {
  const log = [], timers = [], handlers = { on: {}, handle: {} };
  const mainFrame = { url: `${ORIGIN}/` };
  const contents = Object.assign(new EventEmitter(), { mainFrame, isLoadingMainFrame: () => false, getURL: () => `${ORIGIN}/x`, send: (channel, payload) => log.push({ channel, payload }) });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => focused, webContents: contents });
  const visors = [], trays = [], saved = [];
  const visorContents = { mainFrame: { url: "data:text/html" } };
  const fakeVisor = { renders: [], hides: 0, closed: 0, shown: false, sizes: [], contents: () => visorContents, visible: () => fakeVisor.shown,
    render(p) { fakeVisor.renders.push(p); fakeVisor.shown = true; }, hide() { fakeVisor.hides++; fakeVisor.shown = false; }, close() { fakeVisor.closed++; }, setSize(s) { fakeVisor.sizes.push(s); return true; } };
  const fakeTray = { updates: [], destroyed: 0, update(v) { fakeTray.updates.push(v); }, destroy() { fakeTray.destroyed++; }, relabel() {} };
  const prefs = { glanceHidden: () => hidden, setGlanceHidden: (v) => { hidden = v; saved.push(v); } };
  const reveals = [];
  const glance = installGlance({
    ipcMain: { on: (c, f) => { handlers.on[c] = f; }, handle: (c, f) => { handlers.handle[c] = f; } },
    screen: {}, BrowserWindow: class {}, Tray: class {}, Menu: {}, nativeImage: {}, fetch: async () => ({ ok: false }),
    getMainWindow: () => win, prefs, t: (k) => k, revealChat: (target) => reveals.push(target), isWayland: wayland, platform: "linux",
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {},
    createVisor: () => { visors.push(fakeVisor); return fakeVisor; }, createTray: () => { trays.push(fakeTray); return fakeTray; },
  });
  const page = { sender: contents, senderFrame: mainFrame };
  const send = (raw, event = page) => handlers.on["glance:feed"](event, raw);
  return { glance, handlers, log, timers, fakeVisor, fakeTray, visors, trays, saved, reveals, page, contents, mainFrame, win, send, visorEvent: { sender: visorContents, senderFrame: visorContents.mainFrame } };
}

test("AC-15 a feed from a subframe, another page or the wrong origin is ignored", () => {
  const w = world();
  w.send(feed(bot("a")), { sender: w.contents, senderFrame: { url: `${ORIGIN}/` } });
  w.send(feed(bot("a")), { sender: {}, senderFrame: w.mainFrame });
  w.send(feed(bot("a")), { sender: w.contents, senderFrame: null });
  const other = { ...w.mainFrame, url: "https://evil.example/" };
  w.send(feed(bot("a")), { sender: w.contents, senderFrame: other });
  assert.equal(w.visors.length, 0);
  w.send({ ...feed(bot("a")), version: 9 });
  assert.equal(w.visors.length, 0);
  w.send(feed(bot("a")));
  assert.equal(w.visors.length, 1);
  assert.equal(w.fakeVisor.renders.at(-1).entries[0].botId, "a");
});

test("a feed from the page draws the visor, and an empty feed hides it", () => {
  const w = world();
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.equal(w.fakeVisor.shown, true);
  w.send(feed());
  assert.ok(w.fakeVisor.hides >= 1);
});

test("AC-06 a visor act is relayed to the page and its answer comes back", async () => {
  const w = world();
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  const act = { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1", choice: "once" };
  const answer = w.handlers.handle["glance-visor:act"](w.visorEvent, act);
  const sent = w.log.find((e) => e.channel === "glance:act");
  assert.deepEqual(sent.payload.act, act);
  w.handlers.on["glance:acted"](w.page, { id: sent.payload.id, ok: true });
  assert.equal(await answer, true);
  const second = w.handlers.handle["glance-visor:act"](w.visorEvent, act);
  const next = w.log.filter((e) => e.channel === "glance:act").at(-1);
  w.handlers.on["glance:acted"](w.page, { id: next.payload.id, ok: false });
  assert.equal(await second, false);
});

test("an answer from another sender does not settle an act", async () => {
  const w = world();
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  const answer = w.handlers.handle["glance-visor:act"](w.visorEvent, { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1", choice: "deny" });
  const sent = w.log.find((e) => e.channel === "glance:act");
  w.handlers.on["glance:acted"]({ sender: {}, senderFrame: w.mainFrame }, { id: sent.payload.id, ok: true });
  w.timers.find((t) => t.ms === ACT_WAIT_MS).fn();
  assert.equal(await answer, false);
});

test("AC-07 a timeout counts as not sent", async () => {
  const w = world();
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  const answer = w.handlers.handle["glance-visor:act"](w.visorEvent, { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1", choice: "deny" });
  w.timers.find((t) => t.ms === ACT_WAIT_MS).fn();
  assert.equal(await answer, false);
});

test("an act from outside the visor, or for something Glance does not show, is refused", async () => {
  const w = world();
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  const act = { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1", choice: "once" };
  assert.equal(await w.handlers.handle["glance-visor:act"](w.page, act), false);
  assert.equal(await w.handlers.handle["glance-visor:act"](w.visorEvent, { ...act, requestId: "old" }), false);
  assert.equal(await w.handlers.handle["glance-visor:act"](w.visorEvent, { ...act, botId: "zzz" }), false);
  assert.equal(w.log.filter((e) => e.channel === "glance:act").length, 0);
});

test("AC-08 open raises the main window on that chat", async () => {
  const w = world();
  w.send(feed(bot("a")));
  const ok = await w.handlers.handle["glance-visor:act"](w.visorEvent, { kind: "open", botId: "a", threadId: "t-a" });
  assert.equal(ok, true);
  assert.deepEqual(w.reveals, [{ botId: "a", threadId: "t-a" }]);
  assert.equal(w.log.filter((e) => e.channel === "glance:act").length, 0);
});

test("a visor size request comes only from the visor", async () => {
  const w = world();
  w.send(feed(bot("a")));
  assert.equal(await w.handlers.handle["glance-visor:size"](w.page, { width: 10, height: 10 }), false);
  assert.equal(await w.handlers.handle["glance-visor:size"](w.visorEvent, { width: 10, height: 10 }), true);
});

test("AC-17 an ask does not open the visor while the main window has focus", () => {
  const focused = world({ focused: true });
  focused.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.equal(focused.fakeVisor.renders.at(-1).openOn, null);
  const away = world();
  away.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.deepEqual(away.fakeVisor.renders.at(-1).openOn, { key: "a\nt-a", id: "r1" });
});

test("AC-12 hiding Glance closes it, saves the choice and keeps reading feeds", () => {
  const w = world();
  w.send(feed(bot("a")));
  w.glance.setHidden(true);
  assert.deepEqual(w.saved, [true]);
  assert.equal(w.fakeVisor.closed, 1);
  w.send(feed(bot("a"), bot("b")));
  assert.equal(w.visors.length, 1);
  assert.equal(w.glance.hidden(), true);
  const restarted = world({ hidden: true });
  restarted.send(feed(bot("a")));
  assert.equal(restarted.visors.length, 0);
});

test("AC-11 on Wayland the tray shows and the visor never does", () => {
  const w = world({ wayland: true });
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.equal(w.visors.length, 0);
  assert.equal(w.trays.length, 1);
  assert.equal(w.fakeTray.updates.at(-1).entries[0].botId, "a");
  w.send(feed());
  assert.ok(w.fakeTray.destroyed >= 1);
});

test("isWaylandSession reads the session and the ozone switches", () => {
  assert.equal(isWaylandSession({ platform: "darwin", env: { XDG_SESSION_TYPE: "wayland" } }), false);
  assert.equal(isWaylandSession({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } }), true);
  assert.equal(isWaylandSession({ platform: "linux", env: { XDG_SESSION_TYPE: "x11" } }), false);
  assert.equal(isWaylandSession({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" }, switches: { "ozone-platform": "x11" } }), false);
  assert.equal(isWaylandSession({ platform: "linux", env: {}, switches: { "ozone-platform-hint": "wayland" } }), true);
});

test("AC-01 AC-05 the visor window is a frameless panel that never takes focus and sits at the top centre", () => {
  const made = [], calls = [];
  class Fake extends EventEmitter {
    constructor(options) { super(); made.push(options); this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, executeJavaScript: async () => {}, loadURL() {} }); this.bounds = []; }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; }
    setAlwaysOnTop(...a) { calls.push(["top", ...a]); }
    setVisibleOnAllWorkspaces(...a) { calls.push(["all", ...a]); }
    setBounds(b) { this.bounds.push(b); }
    showInactive() { calls.push(["showInactive"]); }
    show() { calls.push(["show"]); }
    focus() { calls.push(["focus"]); }
    destroy() {}
  }
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 30, width: 1920, height: 1050 } };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display });
  for (const platform of ["linux", "win32", "darwin"]) {
    made.length = 0; calls.length = 0;
    const visor = createGlanceWindow({ BrowserWindow: Fake, screen, platform, preload: "p.cjs" });
    visor.render({ entries: [] });
    const options = made[0];
    assert.equal(options.focusable, false);
    assert.equal(options.transparent, true);
    assert.equal(options.frame, false);
    assert.equal(options.skipTaskbar, true);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.type, platform === "darwin" ? "panel" : undefined);
    assert.deepEqual(calls.find((c) => c[0] === "top"), ["top", true, "screen-saver"]);
    assert.equal(visor.setSize({ width: 200, height: 40 }), true);
    assert.ok(calls.some((c) => c[0] === "showInactive"));
    assert.ok(!calls.some((c) => c[0] === "focus" || c[0] === "show"));
    assert.equal(visor.setSize({ width: 0, height: 40 }), false);
    assert.equal(visor.setSize({ width: 9999, height: 40 }), false);
    visor.close();
  }
  assert.deepEqual(glanceBounds(display, "darwin", { width: 200, height: 40 }), { x: 860, y: 0, width: 200, height: 40 });
  assert.deepEqual(glanceBounds(display, "win32", { width: 200, height: 40 }), { x: 860, y: 38, width: 200, height: 40 });
});
