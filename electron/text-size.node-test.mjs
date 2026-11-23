import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopPrefs } from "./desktop-prefs.mjs";
import { createMainTextSize, createTextSize, normalizeTextSize, stepTextSize, TEXT_SIZE_STEPS } from "./text-size.mjs";

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
