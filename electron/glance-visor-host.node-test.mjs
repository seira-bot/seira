import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HOST_ACT_WAIT_MS, runGlanceVisorHost } from "./glance-visor-host.mjs";
import { createGlanceWindow } from "./glance-window.mjs";

function world({ real = false, argv = ["--seira-glance-visor=/tmp-x/seira-glance-ABC"] } = {}) {
  const handlers = {}, written = [], quits = [], paths = [], timers = [];
  const app = Object.assign(new EventEmitter(), { setPath: (k, v) => paths.push([k, v]), whenReady: () => Promise.resolve(), quit: () => quits.push(1) });
  const input = new EventEmitter(), output = { write: (s) => written.push(s) };
  const frame = {}, contents = { mainFrame: frame };
  const visor = { renders: [], hides: 0, closed: 0, sizes: [], contents: () => contents, render(p) { visor.renders.push(p); }, hide() { visor.hides++; }, close() { visor.closed++; }, setSize(s) { visor.sizes.push(s); return true; } };
  const loads = [], listens = [];
  class FakeWindow extends EventEmitter {
    constructor() { super(); this.webContents = Object.assign(new EventEmitter(), { mainFrame: frame, setWindowOpenHandler() {}, executeJavaScript: async () => {}, loadURL: async (u) => { loads.push(u); } }); }
    isDestroyed() { return false; } setBounds() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} showInactive() {} hide() {} destroy() {}
    loadURL(u) { loads.push(u); return Promise.resolve(); }
  }
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 800 } }) });
  const started = runGlanceVisorHost({
    app, BrowserWindow: FakeWindow, screen, ipcMain: { handle: (c, f) => { handlers[c] = f; }, listen: () => listens.push(1) },
    input, output, createVisor: real ? createGlanceWindow : () => visor,
    argv,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; }, clearTimer: () => {},
  });
  const feedLine = (obj) => input.emit("data", `${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  const lines = () => written.map((s) => JSON.parse(s));
  return { app, input, handlers, written, quits, paths, timers, visor, contents, frame, started, feedLine, lines, loads, listens };
}

test("AC-09 the userData path is the flag folder", async () => {
  const w = world();
  await w.started;
  assert.deepEqual(w.paths, [["userData", "/tmp-x/seira-glance-ABC"]]);
  assert.equal(w.app.listenerCount("will-quit"), 0);
});

test("AC-09 with no flag value, or a relative path, the host quits and makes no window and registers no handler", async () => {
  for (const argv of [[], ["--seira-glance-visor="], ["--seira-glance-visor=rel/dir"]]) {
    const w = world({ argv });
    await w.started;
    assert.deepEqual(w.quits, [1]);
    assert.deepEqual(w.paths, []);
    assert.deepEqual(Object.keys(w.handlers), []);
    assert.equal(w.app.listenerCount("window-all-closed"), 0);
    assert.equal(w.written.length, 0);
  }
});

test("AC-01 the helper reports ready and shows render and hide on its visor", async () => {
  const w = await (async () => { const x = world(); await x.started; return x; })();
  assert.deepEqual(w.lines(), [{ t: "ready" }]);
  w.feedLine({ t: "render", payload: { entries: [] } });
  w.feedLine({ t: "hide" });
  assert.deepEqual(w.visor.renders, [{ entries: [] }]);
  assert.equal(w.visor.hides, 1);
});

test("AC-07 an act from another sender or from a subframe is refused", async () => {
  const w = world();
  await w.started;
  assert.equal(await w.handlers["glance-visor:act"]({ sender: {}, senderFrame: w.frame }, { kind: "open" }), false);
  assert.equal(await w.handlers["glance-visor:act"]({ sender: w.contents, senderFrame: {} }, { kind: "open" }), false);
  assert.equal(await w.handlers["glance-visor:act"]({ sender: w.contents, senderFrame: null }, { kind: "open" }), false);
  assert.equal(w.lines().filter((l) => l.t === "act").length, 0);
  assert.equal(await w.handlers["glance-visor:size"]({ sender: {}, senderFrame: w.frame }, { width: 1, height: 1 }), false);
  assert.equal(await w.handlers["glance-visor:size"]({ sender: w.contents, senderFrame: w.frame }, { width: 1, height: 1 }), true);
});

test("AC-07 an act from the visor is written as one JSON line and settles with the answer of the main process", async () => {
  const w = world();
  await w.started;
  const act = { kind: "approval", botId: "a" };
  const answer = w.handlers["glance-visor:act"]({ sender: w.contents, senderFrame: w.frame }, act);
  const sent = w.lines().find((l) => l.t === "act");
  assert.deepEqual(sent.act, act);
  assert.equal(w.written.at(-1).endsWith("\n"), true);
  w.feedLine({ t: "acted", id: sent.id, ok: true });
  assert.equal(await answer, true);
});

test("AC-07 an act without an answer in time settles false", async () => {
  const w = world();
  await w.started;
  const answer = w.handlers["glance-visor:act"]({ sender: w.contents, senderFrame: w.frame }, {});
  w.timers.find((t) => t.ms === HOST_ACT_WAIT_MS).fn();
  assert.equal(await answer, false);
});

test("AC-06 bad, unknown and oversized input lines are ignored", async () => {
  const w = world();
  await w.started;
  w.feedLine("not json");
  w.feedLine({ t: "boom" });
  w.feedLine("null");
  w.feedLine({ t: "render", payload: "x".repeat(4 * 1024 * 1024 + 1) });
  w.feedLine({ t: "acted", id: 5, ok: true });
  assert.equal(w.visor.renders.length, 0);
  assert.equal(w.visor.hides, 0);
  w.feedLine({ t: "render", payload: 1 });
  assert.equal(w.visor.renders.length, 1);
});

test("AC-08 the end of the input closes the visor and quits", async () => {
  const w = world();
  await w.started;
  w.input.emit("end");
  w.input.emit("close");
  assert.equal(w.visor.closed, 1);
  assert.deepEqual(w.quits, [1]);
});

test("a hidden visor does not quit the helper", async () => {
  const w = world();
  await w.started;
  assert.equal(w.app.listenerCount("window-all-closed"), 1);
  w.app.emit("window-all-closed");
  assert.equal(w.quits.length, 0);
});

test("AC-10 the helper loads only the local visor page and opens no port", async () => {
  const w = world({ real: true });
  await w.started;
  w.feedLine({ t: "render", payload: { entries: [] } });
  assert.equal(w.loads.length, 1);
  assert.match(w.loads[0], /^data:text\/html;charset=utf-8,/);
  assert.equal(w.listens.length, 0);
  const source = readFileSync(new URL("./glance-visor-host.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(listen|createServer|loadURL|loadFile|console\.)/);
});
