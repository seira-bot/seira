import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HANG_LIMIT_MS, RELOAD_LIMIT, RELOAD_WINDOW_MS, RETRY_DELAYS_MS, createRendererRecovery, exitCodeHex } from "./renderer-recovery.mjs";

/** A window whose page ends the way Electron's does: crashing it by force reports `render-process-gone` with that reason. */
function appWindow() {
  const page = Object.assign(new EventEmitter(), { reloads: 0, crashes: 0, destroyed: false, loaded: [],
    reload() { this.reloads++; }, loadURL(url) { this.loaded.push(url); return Promise.resolve(); }, isDestroyed() { return this.destroyed; },
    forcefullyCrashRenderer() { this.crashes++; this.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 }); } });
  const win = Object.assign(new EventEmitter(), { webContents: page, destroyed: false, isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; page.destroyed = true; state.order.push("destroy"); }, close() { state.order.push("close"); } });
  return { win, page };
}
let state;

function world(t, { shuttingDown = false, answers = [], ...extra } = {}) {
  try { t.mock.timers.enable({ apis: ["setTimeout"] }); } catch {}
  state = { shuttingDown, clock: 1_000_000, lines: [], stops: [], boxes: [], order: [], created: [], relaunches: 0 };
  const recovery = createRendererRecovery({ isShuttingDown: () => state.shuttingDown, now: () => state.clock, log: (line) => state.lines.push(line),
    onStop: (stop) => state.stops.push(stop), fallbackUrl: () => "http://127.0.0.1:8799",
    showMessageBox: (options) => { state.boxes.push(options); return Promise.resolve({ response: answers.shift() ?? 2 }); },
    createWindow: () => { state.order.push("create"); const next = appWindow(); state.created.push(next); return next.win; },
    relaunch: () => { state.relaunches++; }, ...extra });
  const { win, page } = appWindow();
  recovery.attach(win);
  /** Ends the page, then lets the pause before its reload pass. */
  const end = (reason = "crashed", exitCode = 1) => {
    page.emit("render-process-gone", {}, { reason, exitCode });
    t.mock.timers.tick(RETRY_DELAYS_MS.at(-1));
  };
  return { recovery, win, page, state, end };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const decoded = (url) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

test("the page reloads when its renderer ends for any reason but a clean exit", (t) => {
  for (const reason of ["crashed", "abnormal-exit", "killed", "oom", "launch-failed", "integrity-failure"]) {
    const { page, end, state } = world(t);
    end(reason);
    assert.equal(page.reloads, 1, reason);
    assert.match(state.lines.join("\n"), new RegExp(reason), "the log names the reason");
  }
});

test("AC-01: the pause before a reload is 1, 5, then 15 seconds", (t) => {
  assert.deepEqual([...RETRY_DELAYS_MS], [1_000, 5_000, 15_000]);
  const { page } = world(t);
  const ends = () => page.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  for (const [delay, reloads] of [[1_000, 1], [5_000, 2], [15_000, 3]]) {
    ends();
    t.mock.timers.tick(delay - 1);
    assert.equal(page.reloads, reloads - 1, `not before ${delay} ms`);
    t.mock.timers.tick(1);
    assert.equal(page.reloads, reloads, `at ${delay} ms`);
  }
});

test("AC-08: the log writes the exit code in hex", (t) => {
  assert.equal(exitCodeHex(-36861), "0xffff7003");
  assert.equal(exitCodeHex(undefined), "unknown");
  const { end, state } = world(t);
  end("crashed", -36861);
  assert.match(state.lines[0], /0xffff7003/);
});

test("a clean exit is not a failure, so the page stays as it is", (t) => {
  const { page, end, state } = world(t);
  end("clean-exit");
  assert.equal(page.reloads, 0);
  assert.deepEqual(state.lines, []);
});

test("nothing reloads while the app is shutting down", (t) => {
  const { page, end, state } = world(t, { shuttingDown: true });
  end("crashed");
  assert.equal(page.reloads, 0);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.equal(page.crashes, 0, "a hung page is left alone too");
  assert.deepEqual(state.lines, []);
});

test("AC-07: a pending reload is cancelled when the window closes or the app shuts down", (t) => {
  const closing = world(t);
  closing.page.emit("render-process-gone", {}, { reason: "crashed" });
  closing.win.emit("closed");
  t.mock.timers.tick(RETRY_DELAYS_MS[0] * 2);
  assert.equal(closing.page.reloads, 0);
  const quitting = world(t);
  quitting.page.emit("render-process-gone", {}, { reason: "crashed" });
  quitting.state.shuttingDown = true;
  t.mock.timers.tick(RETRY_DELAYS_MS[0] * 2);
  assert.equal(quitting.page.reloads, 0);
});

test("AC-02: a page that ends a fourth time in a minute loads the recovery page once, and reload stops", (t) => {
  const { page, end, state } = world(t);
  assert.equal(RELOAD_LIMIT, 3);
  assert.equal(RELOAD_WINDOW_MS, 60_000);
  for (let i = 0; i < RELOAD_LIMIT; i++) { end(); state.clock += 5_000; }
  assert.equal(page.reloads, 3);
  assert.deepEqual(page.loaded, []);
  end("killed", 7);
  assert.equal(page.reloads, 3, "the fourth in a minute is not reloaded");
  assert.equal(page.loaded.length, 1, "it loads the recovery page");
  assert.deepEqual(state.stops, [{ reason: "killed", exitCode: 7, next: "page" }]);
  assert.match(state.lines.at(-1), /0x7\); stop reloading/);
  assert.equal(state.boxes.length, 0);
  page.emit("did-navigate", {}, "http://127.0.0.1:8799/chat");
});

test("AC-02: the recovery page opens the last app address in the same window, or the app address when none is known", (t) => {
  const known = world(t);
  known.page.emit("did-navigate", {}, "http://127.0.0.1:8799/settings?x=1&y=\"2\"");
  for (let i = 0; i < 4; i++) known.end();
  const html = decoded(known.page.loaded[0]);
  assert.match(html, /<a href="http:\/\/127\.0\.0\.1:8799\/settings\?x=1&amp;y=&quot;2&quot;"/);
  assert.ok(!html.includes("target="), "the link stays in the window");
  assert.match(html, />Reload<\/a>/);
  const unknown = world(t);
  for (let i = 0; i < 4; i++) unknown.end();
  assert.match(decoded(unknown.page.loaded[0]), /<a href="http:\/\/127\.0\.0\.1:8799"/);
  const odd = world(t);
  odd.page.emit("did-navigate", {}, "javascript:alert(1)");
  for (let i = 0; i < 4; i++) odd.end();
  assert.match(decoded(odd.page.loaded[0]), /<a href="http:\/\/127\.0\.0\.1:8799"/, "only a web address is used");
});

test("a page that keeps ending stops once, and a stopped window logs the stop one time", (t) => {
  const { end, state } = world(t);
  for (let i = 0; i < 4; i++) end();
  end("crashed");
  assert.equal(state.lines.filter((line) => /stop/i.test(line)).length, 2, "the recovery page that goes away is the second stop");
  assert.deepEqual(state.stops.map((stop) => stop.next), ["page", "dialog"]);
});

test("after Reload on the recovery page, a page that ends again in the same minute shows the recovery page again", (t) => {
  const { page, end, state } = world(t);
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.loaded.length, 1);
  page.emit("did-navigate", {}, "http://127.0.0.1:8799/");
  end();
  assert.equal(page.reloads, 3, "no reload inside the minute");
  assert.equal(page.loaded.length, 2);
  assert.deepEqual(state.stops.map((stop) => stop.next), ["page", "page"]);
});

test("reloading resumes once the failures are more than a minute old", (t) => {
  const { page, end, state } = world(t);
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.reloads, 3);
  state.clock += RELOAD_WINDOW_MS + 1;
  page.emit("did-navigate", {}, "http://127.0.0.1:8799/");
  end();
  assert.equal(page.reloads, 4, "the old failures no longer count");
});

test("AC-03: launch-failed at the limit shows one dialog, not the recovery page", async (t) => {
  const { page, end, state } = world(t);
  for (let i = 0; i < 3; i++) end("launch-failed", 18);
  end("launch-failed", 18);
  await settle();
  assert.deepEqual(page.loaded, []);
  assert.equal(state.boxes.length, 1);
  assert.deepEqual(state.boxes[0].buttons, ["Try again", "Restart Seira", "Close"]);
  assert.equal(state.boxes[0].message, "Seira could not open its window. Try again, or restart Seira.");
  assert.equal(state.boxes[0].parent, undefined, "the dialog has no parent window");
  assert.deepEqual(state.stops, [{ reason: "launch-failed", exitCode: 18, next: "dialog" }]);
});

test("AC-03: a recovery page that also goes away shows the dialog", async (t) => {
  const { page, end, state } = world(t);
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.loaded.length, 1);
  page.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
  await settle();
  assert.equal(state.boxes.length, 1);
  assert.equal(state.stops.at(-1).next, "dialog");
});

test("AC-04: Try again makes a new window before it destroys the old one", async (t) => {
  const { win, end, state } = world(t, { answers: [0] });
  for (let i = 0; i < 3; i++) end("launch-failed");
  end("launch-failed");
  await settle();
  assert.deepEqual(state.order, ["create", "destroy"]);
  assert.equal(win.destroyed, true);
  assert.equal(state.created.length, 1);
  assert.equal(state.relaunches, 0);
});

test("AC-05: Restart Seira relaunches once", async (t) => {
  const { page, end, state } = world(t, { answers: [1] });
  for (let i = 0; i < 4; i++) end("launch-failed");
  await settle();
  assert.equal(state.relaunches, 1);
  assert.deepEqual(state.order, []);
  page.emit("render-process-gone", {}, { reason: "crashed" });
  await settle();
  assert.equal(state.relaunches, 1);
});

test("Close closes the window the way its own close button does", async (t) => {
  const { end, state } = world(t, { answers: [2] });
  for (let i = 0; i < 4; i++) end("launch-failed");
  await settle();
  assert.equal(state.relaunches, 0);
  assert.deepEqual(state.order, ["close"]);
});

test("a dialog that fails to open changes nothing", async (t) => {
  const { end, state } = world(t, { showMessageBox: () => Promise.reject(new Error("no display")) });
  for (let i = 0; i < 4; i++) end("launch-failed");
  await settle();
  assert.deepEqual(state.order, []);
  assert.equal(state.relaunches, 0);
});

test("AC-06: while the dialog is open no reload runs and no second dialog opens", async (t) => {
  let answer;
  const { page, end, state } = world(t, { showMessageBox: (options) => { state.boxes.push(options); return new Promise((resolve) => { answer = resolve; }); } });
  for (let i = 0; i < 4; i++) end("launch-failed");
  assert.equal(state.boxes.length, 1);
  state.clock += RELOAD_WINDOW_MS + 1;
  end("crashed");
  end("launch-failed");
  assert.equal(page.reloads, 3, "no reload while the dialog is open");
  assert.equal(state.boxes.length, 1);
  answer({ response: 2 });
  await settle();
  assert.deepEqual(state.order, ["close"]);
  assert.equal(page.reloads, 3);
});

test("an onStop that throws does not change the flow", async (t) => {
  const { page, end } = world(t, { onStop: () => { throw new Error("listener"); } });
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.loaded.length, 1);
});

test("a recovery page that fails to load shows the dialog", async (t) => {
  const { page, end, state } = world(t);
  page.loadURL = () => Promise.reject(new Error("aborted"));
  for (let i = 0; i < 4; i++) end();
  await settle();
  assert.equal(state.boxes.length, 1);
});

test("a page that stays unresponsive for 30 seconds is ended, and reloads in a new renderer", (t) => {
  const { page, state } = world(t);
  assert.equal(HANG_LIMIT_MS, 30_000);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS - 1);
  assert.equal(page.crashes, 0, "not before 30 seconds");
  t.mock.timers.tick(1);
  assert.equal(page.crashes, 1);
  t.mock.timers.tick(RETRY_DELAYS_MS[0]);
  assert.equal(page.reloads, 1, "the renderer's end reloads the page once");
  assert.match(state.lines.join("\n"), /did not respond/i);
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 1, "the timer fires once");
});

test("a page that answers again within 30 seconds is not ended", (t) => {
  const { page } = world(t);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS - 1);
  page.emit("responsive");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0);
  assert.equal(page.reloads, 0);
});

test("a second unresponsive report does not start a second timer", (t) => {
  const { page } = world(t);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS / 2);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS / 2);
  assert.equal(page.crashes, 1, "30 seconds from the first report");
});

test("a page that ends while a hang is pending cancels the pending end", (t) => {
  const { page, end } = world(t);
  page.emit("unresponsive");
  end("crashed");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0, "the old renderer is already gone");
  assert.equal(page.reloads, 1);
});

test("a hung page is left alone once reloading has stopped", (t) => {
  const { page, end } = world(t);
  for (let i = 0; i < 4; i++) end();
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.equal(page.crashes, 0, "ending it would leave a blank window with nothing to reload it");
});

test("a closed window is not touched, and its pending end is cancelled", (t) => {
  const { win, page, end } = world(t);
  page.emit("unresponsive");
  win.emit("closed");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0);
  win.destroyed = true;
  page.destroyed = true;
  end("crashed");
  assert.equal(page.reloads, 0, "nothing to reload in a destroyed window");
});

test("each window has its own count", (t) => {
  const { recovery, page, end } = world(t);
  const second = appWindow();
  recovery.attach(second.win);
  for (let i = 0; i < 4; i++) end();
  second.page.emit("render-process-gone", {}, { reason: "crashed" });
  t.mock.timers.tick(RETRY_DELAYS_MS[0]);
  assert.equal(page.reloads, 3);
  assert.equal(second.page.reloads, 1);
});

test("main attaches the recovery to each window that createWindow makes", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function createWindow(");
  assert.ok(start > 0, "main.mjs has createWindow");
  const next = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, next > 0 ? next : undefined);
  assert.match(body, /rendererRecovery\.attach\(win\)/);
  assert.match(source, /createRendererRecovery\(\{[^}]*isShuttingDown: \(\) => desktopShutdownStarted/);
});

test("AC-15: onHang runs with the page just before the forced end, and a failing onHang changes nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order = [];
  const { win, page } = appWindow();
  createRendererRecovery({ onHang: (contents) => { order.push(["hang", contents === page, page.crashes]); } }).attach(win);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.deepEqual(order, [["hang", true, 0]], "onHang ran before the crash was forced");
  assert.equal(page.crashes, 1);

  const second = appWindow();
  createRendererRecovery({ onHang: () => { throw new Error("listener"); } }).attach(second.win);
  second.page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.equal(second.page.crashes, 1, "a listener that throws does not stop the recovery");
});
