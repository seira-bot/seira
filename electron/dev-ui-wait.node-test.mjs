import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { devWaitPage, loadDevUi } from "./dev-ui-wait.mjs";

const URL_ = "http://127.0.0.1:5199";

function setup(answers) {
  const win = new EventEmitter();
  win.loads = [];
  win.destroyed = false;
  win.webContents = new EventEmitter();
  win.loadURL = (u) => { win.loads.push(u); return Promise.resolve(); };
  win.isDestroyed = () => win.destroyed;
  const timers = [];
  const cleared = [];
  const fetchCalls = [];
  const fetch = async (u) => {
    fetchCalls.push(u);
    if (!answers.shift()) throw new Error("refused");
    return { ok: true };
  };
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const clearTimer = (id) => cleared.push(id);
  loadDevUi({ win, url: URL_, fetch, setTimer, clearTimer });
  const fail = (code = -102, url = URL_ + "/", main = true) => win.webContents.emit("did-fail-load", {}, code, "x", url, main);
  return { win, timers, cleared, fetchCalls, fail };
}

const flush = () => new Promise((r) => setImmediate(r));

test("the dev UI loads first and no wait page shows when it answers", () => {
  const { win, timers } = setup([]);
  assert.deepEqual(win.loads, [URL_]);
  assert.equal(timers.length, 0);
});

test("a failed main-frame load shows the wait page and polls every 2 seconds", () => {
  const { win, timers, fail } = setup([]);
  fail();
  assert.equal(win.loads.length, 2);
  assert.equal(win.loads[1], devWaitPage(URL_));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
});

test("code -3, a subframe, and another origin are ignored", () => {
  const { win, timers, fail } = setup([]);
  fail(-3);
  fail(-102, URL_ + "/", false);
  fail(-102, "http://127.0.0.1:9999/");
  assert.equal(win.loads.length, 1);
  assert.equal(timers.length, 0);
});

test("polling goes on while the UI is down and loads the UI once it answers", async () => {
  const { win, timers, fetchCalls, fail } = setup([false, true]);
  fail();
  await timers.shift().fn();
  assert.equal(timers.length, 1, "next poll scheduled");
  assert.equal(win.loads.length, 2);
  await timers.shift().fn();
  await flush();
  assert.deepEqual(fetchCalls, [URL_, URL_]);
  assert.equal(win.loads.length, 3);
  assert.equal(win.loads[2], URL_);
  assert.equal(timers.length, 0, "polling stopped");
});

test("closing the window stops polling", async () => {
  const { win, timers, cleared, fetchCalls, fail } = setup([false]);
  fail();
  win.emit("closed");
  assert.equal(cleared.length, 1);
  await timers.shift().fn();
  assert.equal(fetchCalls.length, 0);
  assert.equal(timers.length, 0);
});

test("a destroyed window stops polling without a fetch", async () => {
  const { win, timers, fetchCalls, fail } = setup([true]);
  fail();
  win.destroyed = true;
  await timers.shift().fn();
  assert.equal(fetchCalls.length, 0);
  assert.equal(win.loads.length, 2);
});

test("the wait page names both commands and supports light and dark", () => {
  const html = decodeURIComponent(devWaitPage(URL_).split(",").slice(1).join(","));
  assert.match(html, /Seira \(dev\) is waiting for the app/);
  assert.match(html, /pnpm dev:server/);
  assert.match(html, /<code>pnpm dev<\/code>/);
  assert.match(html, /prefers-color-scheme:dark/);
});
