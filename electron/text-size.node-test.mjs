import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopPrefs } from "./desktop-prefs.mjs";
import { createMainTextSize, createTextSize, normalizeTextSize, stepTextSize, TEXT_SIZE_STEPS, textSizeMinimum } from "./text-size.mjs";

const memory = (record) => {
  let saved = record;
  return { read: () => { if (saved === undefined) throw Object.assign(new Error("none"), { code: "ENOENT" }); return saved; }, write: (value) => { saved = value; }, get saved() { return saved; } };
};
const page = (zoom = 1) => ({ zoom, isDestroyed: () => false, getZoomFactor() { return this.zoom; }, setZoomFactor(value) { this.zoom = value; } });

test("AC-08 a stored value that is not a step reads as 100 %", () => {
  for (const bad of [0, 1.2, "1.5", null, NaN, 3, -1]) assert.equal(normalizeTextSize(bad), 1);
  for (const bad of [0, 1.2, "1.5", null, 3]) assert.equal(createDesktopPrefs(memory({ seen: [], textSize: bad })).textSize(), 1);
  for (const step of TEXT_SIZE_STEPS) assert.equal(createDesktopPrefs(memory({ seen: [], textSize: step })).textSize(), step);
});

test("the step is kept for the device and refuses a value that is not a step", () => {
  const file = memory(undefined);
  const prefs = createDesktopPrefs(file);
  assert.equal(prefs.textSize(), 1);
  assert.equal(prefs.setTextSize(1.5), true);
  assert.equal(file.saved.textSize, 1.5);
  assert.equal(prefs.setTextSize(1.3), false);
  assert.equal(prefs.textSize(), 1.5);
});

test("AC-05 zoom in and zoom out move one step and stop at the ends", () => {
  assert.equal(stepTextSize(1, 1), 1.1);
  assert.equal(stepTextSize(1, -1), 0.9);
  assert.equal(stepTextSize(2, 1), 2);
  assert.equal(stepTextSize(0.9, -1), 0.9);
  assert.equal(stepTextSize(1.3, 1), 1.1, "a value that is not a step counts as 100 %");
});

test("AC-05 the menu and shortcut functions move the page one step and tell the pages", () => {
  const prefs = createDesktopPrefs(memory(undefined)), contents = page(), told = [];
  const size = createTextSize({ prefs, contents: () => contents, changed: (step) => told.push(step) });
  size.zoomIn(); size.zoomIn(); size.zoomOut();
  assert.equal(contents.zoom, 1.1);
  assert.equal(prefs.textSize(), 1.1);
  assert.deepEqual(told, [1.1, 1.25, 1.1]);
});

test("AC-06 actual size sets 100 %", () => {
  const prefs = createDesktopPrefs(memory({ seen: [], textSize: 1.75 })), contents = page(1.75), told = [];
  const size = createTextSize({ prefs, contents: () => contents, changed: (step) => told.push(step) });
  size.reset();
  assert.equal(contents.zoom, 1);
  assert.equal(prefs.textSize(), 1);
  assert.deepEqual(told, [1]);
  size.reset();
  assert.deepEqual(told, [1], "no change, no event");
});

test("AC-02 choosing a step applies it at once; a value that is not a step changes nothing", () => {
  const prefs = createDesktopPrefs(memory(undefined)), contents = page();
  const size = createTextSize({ prefs, contents: () => contents });
  assert.equal(size.set(1.5), 1.5);
  assert.equal(contents.zoom, 1.5);
  assert.equal(size.set(7), 1.5);
  assert.equal(contents.zoom, 1.5);
});

test("AC-03 and AC-04 apply puts the stored step on a page that loaded, also one of another server", () => {
  const prefs = createDesktopPrefs(memory({ seen: [], textSize: 1.25 }));
  const size = createTextSize({ prefs, contents: () => null });
  const first = page(), other = page();
  size.apply(first);
  size.apply(other);
  assert.equal(first.zoom, 1.25);
  assert.equal(other.zoom, 1.25);
  size.apply(null);
  size.apply({ ...page(), isDestroyed: () => true });
});

test("AC-03 and AC-04 the main window gets the stored step when it is made and on every load, of any server", () => {
  const prefs = createDesktopPrefs(memory({ seen: [], textSize: 1.5 }));
  const handlers = new Map(), sent = [];
  const contents = { ...page(), on: (event, handler) => handlers.set(event, handler), send: (...args) => sent.push(args) };
  const win = { isDestroyed: () => false, webContents: contents };
  const size = createMainTextSize({ prefs: () => prefs, window: () => win });
  size.attach(contents);
  assert.equal(contents.zoom, 1.5, "before the window shows");
  assert.deepEqual([...handlers.keys()].sort(), ["did-finish-load", "did-navigate", "dom-ready"]);
  contents.zoom = 1;
  handlers.get("did-navigate")();
  assert.equal(contents.zoom, 1.5, "a page of another server starts at 100 % and is put back");
  size.zoomIn();
  assert.equal(contents.zoom, 1.75);
  assert.deepEqual(sent, [["text-size:changed", 1.75]]);
});

test("the main window's size does nothing once the window is gone", () => {
  const prefs = createDesktopPrefs(memory(undefined));
  const size = createMainTextSize({ prefs: () => prefs, window: () => null });
  assert.equal(size.zoomIn(), 1.1);
  assert.equal(prefs.textSize(), 1.1);
});

const BASE = { width: 840, height: 620 };
const fitting = ({ step = 1, bounds = { x: 900, y: 300, width: 840, height: 620 }, area = { x: 0, y: 0, width: 1920, height: 1040 }, maximized = false, fullScreen = false } = {}) => {
  const prefs = createDesktopPrefs(memory({ seen: [], textSize: step })), calls = { min: [], bounds: [] };
  const contents = { ...page(), on: () => {}, send: () => {} };
  const win = {
    minimum: [840, 620], bounds, contents, isDestroyed: () => false, webContents: contents,
    getMinimumSize() { return this.minimum; }, setMinimumSize(w, h) { this.minimum = [w, h]; calls.min.push([w, h]); },
    getBounds() { return this.bounds; }, setBounds(value) { this.bounds = value; calls.bounds.push(value); },
    isMaximized: () => maximized, isFullScreen: () => fullScreen,
  };
  const state = { area };
  const size = createMainTextSize({ prefs: () => prefs, window: () => win, base: BASE, workArea: () => state.area });
  return { win, calls, size, state };
};

test("AC-01 and AC-02 the window minimum grows with a step above 100 % and keeps the base at 90 % and 100 %", () => {
  const expected = [[0.9, 840, 620], [1, 840, 620], [1.1, 924, 682], [1.25, 1050, 775], [1.5, 1260, 930], [1.75, 1470, 1085], [2, 1680, 1240]];
  for (const [step, width, height] of expected) assert.deepEqual(textSizeMinimum(step, BASE, null), { width, height }, `step ${step}`);
});

test("AC-03 the window minimum never passes the work area", () => {
  const area = { x: 0, y: 0, width: 1366, height: 740 };
  assert.deepEqual(textSizeMinimum(1.25, BASE, area), { width: 1050, height: 740 });
  assert.deepEqual(textSizeMinimum(2, BASE, area), { width: 1366, height: 740 });
  assert.deepEqual(textSizeMinimum(2, BASE, null), { width: 1680, height: 1240 });
  assert.deepEqual(textSizeMinimum(2, BASE, { width: 0, height: NaN }), { width: 1680, height: 1240 });
});

test("AC-04 a step change grows a window that is smaller than the new minimum and keeps it inside the work area", () => {
  const { win, calls, size } = fitting();
  size.set(1.5);
  assert.deepEqual(win.minimum, [1260, 930]);
  assert.deepEqual(calls.bounds, [{ x: 660, y: 110, width: 1260, height: 930 }]);
});

test("AC-05 a maximized or full-screen window keeps its bounds on a step change", () => {
  for (const flags of [{ maximized: true }, { fullScreen: true }]) {
    const { win, calls, size } = fitting(flags);
    size.set(1.5);
    assert.deepEqual(win.minimum, [1260, 930]);
    assert.equal(calls.bounds.length, 0);
  }
});

test("AC-06 a move to another screen sets the minimum for that work area and does not resize the window", () => {
  const { win, calls, size, state } = fitting({ step: 1.5, bounds: { x: 0, y: 0, width: 1260, height: 930 } });
  size.fit();
  assert.deepEqual(win.minimum, [1260, 930]);
  state.area = { x: 1920, y: 0, width: 1366, height: 740 };
  size.fit();
  assert.deepEqual(win.minimum, [1260, 740]);
  assert.equal(calls.min.length, 2);
  assert.equal(calls.bounds.length, 0);
});

test("AC-07 the stored step sets the minimum and grows the window when the window is made", () => {
  const { win, calls, size } = fitting({ step: 1.25 });
  size.attach(win.contents);
  assert.deepEqual(win.minimum, [1050, 775]);
  assert.deepEqual(calls.bounds, [{ x: 870, y: 265, width: 1050, height: 775 }]);
});

test("a step back to 100 % lowers the minimum and leaves the window size", () => {
  const { win, calls, size } = fitting();
  size.set(1.5);
  const grown = win.bounds;
  size.reset();
  assert.deepEqual(win.minimum, [840, 620]);
  assert.equal(calls.bounds.length, 1);
  assert.equal(win.bounds, grown);
});
