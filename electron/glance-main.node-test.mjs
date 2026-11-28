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

function world({ wayland = false, hidden = false, focused = false, x11 = false, resolveInset = null } = {}) {
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
  const reveals = [], helpers = [], order = [], visorOptions = [];
  const glance = installGlance({
    ipcMain: { on: (c, f) => { handlers.on[c] = f; }, handle: (c, f) => { handlers.handle[c] = f; } },
    screen: {}, BrowserWindow: class {}, Tray: class {}, Menu: {}, nativeImage: {}, fetch: async () => ({ ok: false }),
    getMainWindow: () => win, prefs, t: (k) => k, revealChat: (target) => reveals.push(target), isWayland: wayland, platform: "linux",
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {},
    createVisor: (options) => { visorOptions.push(options); visors.push(fakeVisor); return fakeVisor; }, createTray: () => { trays.push(fakeTray); return fakeTray; },
    x11Available: x11, resolveInset, createHelperVisor: (hooks) => { const h = { ...fakeVisor, hooks, closed: 0, renders: [], hides: 0, shown: false, contents: () => null, visible: () => h.shown, setTopInset(n) { order.push(["inset", n]); }, render(p) { order.push(["render"]); h.renders.push(p); h.shown = true; }, hide() { h.hides++; h.shown = false; }, close() { h.closed++; } }; helpers.push(h); return h; },
  });
  const page = { sender: contents, senderFrame: mainFrame };
  const send = (raw, event = page) => handlers.on["glance:feed"](event, raw);
  return { visorOptions, order, helpers, glance, handlers, log, timers, fakeVisor, fakeTray, visors, trays, saved, reveals, page, contents, mainFrame, win, send, visorEvent: { sender: visorContents, senderFrame: visorContents.mainFrame } };
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

test("AC-01 on Wayland with an X11 display the visor shows from the helper and the tray stays away", () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a")));
  assert.equal(w.helpers.length, 1);
  assert.equal(w.helpers[0].renders.at(-1).entries[0].botId, "a");
  assert.equal(w.trays.length, 0);
  assert.equal(w.visors.length, 0);
});

test("AC-03 on Wayland without an X11 display the tray shows and the helper never starts", () => {
  const w = world({ wayland: true, x11: false });
  w.send(feed(bot("a")));
  assert.equal(w.helpers.length, 0);
  assert.equal(w.trays.length, 1);
});

test("AC-04 after three helper failures the tray shows for the rest of the run", () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a")));
  w.helpers[0].hooks.onFail();
  assert.equal(w.helpers.length, 2);
  assert.equal(w.trays.length, 0);
  w.helpers[1].hooks.onFail();
  assert.equal(w.helpers.length, 3);
  w.helpers[2].hooks.onFail();
  assert.equal(w.helpers.length, 3);
  assert.equal(w.trays.length, 1);
  assert.equal(w.fakeTray.updates.length >= 1, true);
});

test("AC-05 an act from the helper gets the same checks as an act from the local visor", async () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a", { state: "needs", ask: { ...approval, detail: "" } })));
  const act = w.helpers[0].hooks.onAct;
  const once = { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1", choice: "once" };
  assert.equal(await act(once), false);
  assert.equal(await act({ ...once, choice: "always" }), false);
  assert.equal(await act({ ...once, requestId: "old", choice: "deny" }), false);
  assert.equal(await act("junk"), false);
  assert.equal(w.log.filter((e) => e.channel === "glance:act").length, 0);
  const w2 = world({ wayland: true, x11: true });
  w2.send(feed(bot("a", { state: "needs", ask: approval })));
  const answer = w2.helpers[0].hooks.onAct(once);
  const sent = w2.log.find((e) => e.channel === "glance:act");
  assert.deepEqual(sent.payload.act, once);
  w2.handlers.on["glance:acted"](w2.page, { id: sent.payload.id, ok: true });
  assert.equal(await answer, true);
  assert.equal(await w2.helpers[0].hooks.onAct({ kind: "open", botId: "a", threadId: "t-a" }), true);
  assert.deepEqual(w2.reveals, [{ botId: "a", threadId: "t-a" }]);
});

test("a page that stands in for the helper through the visor channel is refused", async () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a")));
  assert.equal(await w.handlers.handle["glance-visor:act"](w.visorEvent, { kind: "open", botId: "a", threadId: "t-a" }), false);
  assert.equal(await w.handlers.handle["glance-visor:size"](w.visorEvent, { width: 10, height: 10 }), false);
});

test("AC-08 turning Glance off or leaving closes the helper", () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a")));
  w.glance.setHidden(true);
  assert.equal(w.helpers[0].closed, 1);
  const w2 = world({ wayland: true, x11: true });
  w2.send(feed(bot("a")));
  w2.glance.destroy();
  assert.equal(w2.helpers[0].closed, 1);
});

test("glanceBounds honours a top inset when the work area is wrong, and never double-counts a real one", () => {
  const size = { width: 200, height: 40 };
  const wrong = { bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  assert.equal(glanceBounds(wrong, "linux", size, 35).y, 43);
  assert.equal(glanceBounds(wrong, "linux", size, 0).y, 8);
  assert.equal(glanceBounds(wrong, "linux", size).y, 8);
  const real = { bounds: wrong.bounds, workArea: { x: 0, y: 30, width: 1920, height: 1170 } };
  assert.equal(glanceBounds(real, "linux", size, 35).y, 43);
  assert.equal(glanceBounds(real, "linux", size, 10).y, 38);
  assert.equal(glanceBounds(wrong, "darwin", size, 35).y, 0);
});

test("setTopInset re-places a live visor, and a getter is read on every placement", () => {
  const sets = [];
  class Fake extends EventEmitter {
    constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, executeJavaScript: async () => {}, loadURL() {} }); }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; } setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} showInactive() {} destroy() {}
    setBounds(b) { sets.push(b); }
  }
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display });
  const visor = createGlanceWindow({ BrowserWindow: Fake, screen, platform: "linux", preload: "p.cjs" });
  visor.render({ entries: [] });
  visor.setSize({ width: 200, height: 40 });
  assert.equal(sets.at(-1).y, 8);
  visor.setTopInset(35);
  assert.equal(sets.at(-1).y, 43);
  visor.close();
  let inset = 20;
  const dynamic = createGlanceWindow({ BrowserWindow: Fake, screen, platform: "linux", preload: "p.cjs", topInset: () => inset });
  dynamic.render({ entries: [] });
  dynamic.setSize({ width: 200, height: 40 });
  assert.equal(sets.at(-1).y, 28);
  inset = 40;
  dynamic.setSize({ width: 210, height: 40 });
  assert.equal(sets.at(-1).y, 48);
  dynamic.close();
});

const settle = () => new Promise((r) => setImmediate(r));

test("on Wayland with the helper the inset is resolved first and sent before the render, and again after hide then show", async () => {
  let calls = 0, answer = 35;
  const w = world({ wayland: true, x11: true, resolveInset: async () => { calls++; return answer; } });
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.equal(w.helpers.length, 1);
  assert.equal(w.helpers[0].renders.length, 0);
  await settle();
  assert.deepEqual(w.order, [["inset", 35], ["render"]]);
  assert.equal(calls, 1);
  w.send(feed(bot("a", { state: "needs", ask: approval, line: "More" })));
  await settle();
  assert.equal(calls, 1);
  w.send(feed());
  assert.equal(w.helpers[0].hides, 1);
  const before = w.order.length;
  answer = 50;
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(w.order.slice(before), [["inset", 50], ["render"]]);
});

test("without a resolver the visor draws at once", () => {
  const w = world({ wayland: true, x11: true });
  w.send(feed(bot("a")));
  assert.equal(w.helpers[0].renders.length, 1);
});

test("a resolver that rejects still draws, keeps the last good inset, and probes again on the next show", async () => {
  const answers = [35, "reject"];
  let calls = 0;
  const w = world({ wayland: true, x11: true, resolveInset: async () => { calls++; const next = answers.shift(); if (next === "reject") throw new Error("x"); return next ?? 35; } });
  const shown = () => feed(bot("a", { state: "needs", ask: approval }));
  w.send(shown());
  await settle();
  w.send(feed());
  w.order.length = 0;
  w.send(shown());
  await settle();
  assert.deepEqual(w.order, [["inset", 35], ["render"]]);
  w.send(feed());
  w.order.length = 0;
  w.send(shown());
  await settle();
  assert.equal(calls, 3);
  assert.deepEqual(w.order, [["inset", 35], ["render"]]);
});

test("in the X11-only path the visor reads the resolved inset through its getter", async () => {
  const w = world({ resolveInset: async () => 35 });
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  assert.equal(w.visors.length, 1);
  await settle();
  assert.equal(w.visorOptions[0].topInset(), 35);
  assert.equal(w.fakeVisor.renders.length, 1);
});

test("a probe that was started before a hide is discarded, and the next show probes again", async () => {
  const pending = [];
  const w = world({ wayland: true, x11: true, resolveInset: () => new Promise((resolve) => pending.push(resolve)) });
  const shown = () => feed(bot("a", { state: "needs", ask: approval }));
  w.send(shown());
  await settle();
  assert.equal(pending.length, 1);
  w.send(feed());
  w.send(shown());
  await settle();
  assert.equal(pending.length, 2);
  pending[0](10);
  await settle();
  assert.deepEqual(w.order, []);
  assert.equal(pending.length, 2);
  pending[1](50);
  await settle();
  assert.deepEqual(w.order, [["inset", 50], ["render"]]);
});

test("a failed probe draws with the last good value, keeps the last good value and probes again on the next show", async () => {
  const answers = [null, 35, null];
  let calls = 0;
  const w = world({ wayland: true, x11: true, resolveInset: async () => { calls++; return answers.shift(); } });
  const shown = () => feed(bot("a", { state: "needs", ask: approval }));
  w.send(shown());
  await settle();
  assert.deepEqual(w.order, [["inset", 0], ["render"]]);
  w.send(feed());
  w.order.length = 0;
  w.send(shown());
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(w.order, [["inset", 35], ["render"]]);
  w.send(feed());
  w.order.length = 0;
  w.send(shown());
  await settle();
  assert.equal(calls, 3);
  assert.deepEqual(w.order, [["inset", 35], ["render"]]);
});

test("a failed probe does not probe again while the visor stays up", async () => {
  let calls = 0;
  const w = world({ wayland: true, x11: true, resolveInset: async () => { calls++; return null; } });
  w.send(feed(bot("a", { state: "needs", ask: approval })));
  await settle();
  w.send(feed(bot("a", { state: "needs", ask: approval, line: "More" })));
  await settle();
  assert.equal(calls, 1);
  assert.equal(w.helpers[0].renders.length, 2);
});

function linuxWindow(options = {}) {
  const sets = [];
  class Fake extends EventEmitter {
    constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, executeJavaScript: async () => {}, loadURL() {} }); }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return false; } setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} showInactive() {} destroy() {}
    setBounds(b) { sets.push(b); }
  }
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display });
  const visor = createGlanceWindow({ BrowserWindow: Fake, screen, platform: "linux", preload: "p.cjs", ...options });
  visor.render({ entries: [] });
  return { sets, screen, visor };
}

test("a grown visor sits at y 43 under a 35 px inset, given as a number or a getter", () => {
  for (const topInset of [35, () => 35]) {
    const { sets, visor } = linuxWindow({ topInset });
    visor.setSize({ width: 380, height: 160 });
    assert.deepEqual(sets.at(-1), { x: 770, y: 43, width: 380, height: 160 });
    visor.close();
  }
});

test("growing first and setting the inset after keeps the height and moves to y 43", () => {
  const { sets, visor } = linuxWindow();
  visor.setSize({ width: 380, height: 160 });
  assert.equal(sets.at(-1).y, 8);
  visor.setTopInset(35);
  assert.deepEqual(sets.at(-1), { x: 770, y: 43, width: 380, height: 160 });
  visor.close();
});

test("a display change after growing keeps y 43", () => {
  const { sets, screen, visor } = linuxWindow({ topInset: 35 });
  visor.setSize({ width: 380, height: 160 });
  screen.emit("display-metrics-changed");
  assert.deepEqual(sets.at(-1), { x: 770, y: 43, width: 380, height: 160 });
  visor.close();
});
