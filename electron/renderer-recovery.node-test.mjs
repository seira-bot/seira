import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HANG_LIMIT_MS, RELOAD_LIMIT, RELOAD_WINDOW_MS, createRendererRecovery } from "./renderer-recovery.mjs";

/** A window whose page ends the way Electron's does: crashing it by force reports `render-process-gone` with that reason. */
function appWindow() {
  const page = Object.assign(new EventEmitter(), { reloads: 0, crashes: 0, destroyed: false,
    reload() { this.reloads++; }, isDestroyed() { return this.destroyed; },
    forcefullyCrashRenderer() { this.crashes++; this.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 }); } });
  const win = Object.assign(new EventEmitter(), { webContents: page, destroyed: false, isDestroyed() { return this.destroyed; } });
  return { win, page };
}

function world({ shuttingDown = false } = {}) {
  const state = { shuttingDown, clock: 1_000_000, lines: [] };
  const recovery = createRendererRecovery({ isShuttingDown: () => state.shuttingDown, now: () => state.clock, log: (line) => state.lines.push(line) });
  const { win, page } = appWindow();
  recovery.attach(win);
  const end = (reason = "crashed") => page.emit("render-process-gone", {}, { reason, exitCode: 1 });
  return { recovery, win, page, state, end };
}

test("the page reloads when its renderer ends for any reason but a clean exit", () => {
  for (const reason of ["crashed", "abnormal-exit", "killed", "oom", "launch-failed", "integrity-failure"]) {
    const { page, end, state } = world();
    end(reason);
    assert.equal(page.reloads, 1, reason);
    assert.match(state.lines.join("\n"), new RegExp(reason), "the log names the reason");
  }
});

test("a clean exit is not a failure, so the page stays as it is", () => {
  const { page, end, state } = world();
  end("clean-exit");
  assert.equal(page.reloads, 0);
  assert.deepEqual(state.lines, []);
});

test("nothing reloads while the app is shutting down", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, end, state } = world({ shuttingDown: true });
  end("crashed");
  assert.equal(page.reloads, 0);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.equal(page.crashes, 0, "a hung page is left alone too");
  assert.deepEqual(state.lines, []);
});

test("a page that ends more than three times in a minute stops reloading, with one log line", () => {
  const { page, end, state } = world();
  assert.equal(RELOAD_LIMIT, 3);
  assert.equal(RELOAD_WINDOW_MS, 60_000);
  for (let i = 0; i < RELOAD_LIMIT; i++) { end(); state.clock += 5_000; }
  assert.equal(page.reloads, 3);
  assert.equal(state.lines.length, 3, "one line for each reload");
  end();
  assert.equal(page.reloads, 3, "the fourth in a minute is not reloaded");
  assert.equal(state.lines.length, 4, "and says so once");
  end(); end();
  assert.equal(page.reloads, 3);
  assert.equal(state.lines.length, 4, "the same stop is not logged again");
});

test("reloading resumes once the failures are more than a minute old", () => {
  const { page, end, state } = world();
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.reloads, 3);
  state.clock += RELOAD_WINDOW_MS + 1;
  end();
  assert.equal(page.reloads, 4, "the old failures no longer count");
  for (let i = 0; i < 4; i++) end();
  assert.equal(page.reloads, 6, "a new stop starts a new count");
  assert.equal(state.lines.filter((line) => /stop/i.test(line)).length, 2, "and is logged once more");
});

test("a page that stays unresponsive for 30 seconds is ended, and reloads in a new renderer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, state } = world();
  assert.equal(HANG_LIMIT_MS, 30_000);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS - 1);
  assert.equal(page.crashes, 0, "not before 30 seconds");
  t.mock.timers.tick(1);
  assert.equal(page.crashes, 1);
  assert.equal(page.reloads, 1, "the renderer's end reloads the page once");
  assert.match(state.lines.join("\n"), /did not respond/i);
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 1, "the timer fires once");
});

test("a page that answers again within 30 seconds is not ended", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page } = world();
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS - 1);
  page.emit("responsive");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0);
  assert.equal(page.reloads, 0);
});

test("a second unresponsive report does not start a second timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page } = world();
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS / 2);
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS / 2);
  assert.equal(page.crashes, 1, "30 seconds from the first report");
});

test("a page that ends while a hang is pending cancels the pending end", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, end } = world();
  page.emit("unresponsive");
  end("crashed");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0, "the old renderer is already gone");
  assert.equal(page.reloads, 1);
});

test("a hung page is left alone once reloading has stopped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { page, end } = world();
  for (let i = 0; i < 4; i++) end();
  page.emit("unresponsive");
  t.mock.timers.tick(HANG_LIMIT_MS);
  assert.equal(page.crashes, 0, "ending it would leave a blank window with nothing to reload it");
});

test("a closed window is not touched, and its pending end is cancelled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { win, page, end } = world();
  page.emit("unresponsive");
  win.emit("closed");
  t.mock.timers.tick(HANG_LIMIT_MS * 2);
  assert.equal(page.crashes, 0);
  win.destroyed = true;
  page.destroyed = true;
  end("crashed");
  assert.equal(page.reloads, 0, "nothing to reload in a destroyed window");
});

test("each window has its own count", () => {
  const state = { clock: 0, lines: [] };
  const recovery = createRendererRecovery({ now: () => state.clock, log: (line) => state.lines.push(line) });
  const first = appWindow(), second = appWindow();
  recovery.attach(first.win);
  recovery.attach(second.win);
  for (let i = 0; i < 4; i++) first.page.emit("render-process-gone", {}, { reason: "crashed" });
  second.page.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(first.page.reloads, 3);
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
