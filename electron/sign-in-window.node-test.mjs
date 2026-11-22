import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { openCleanSignIn } from "./sign-in-window.mjs";

const START = "https://backend.composio.dev/api/v3/s/abc";
const GITHUB_LOGIN = "https://github.com/login?client_id=x";
const CALLBACK = "https://backend.composio.dev/api/v1/auth-apps/add?code=secret";
const DONE = "https://platform.composio.dev/done";

function fixture() {
  const log = { windows: [], loaded: [], timers: [], cleared: [], permission: {} };
  class FakeContents extends EventEmitter {
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    loadURL(url) { log.loaded.push(url); return Promise.resolve(); }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.title = options.title;
      this.closed = false;
      this.webContents = new FakeContents();
      log.windows.push(this);
    }
    setTitle(title) { this.title = title; }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; this.emit("closed"); }
  }
  const clean = {
    setPermissionRequestHandler(handler) { log.permission.request = handler; },
    setPermissionCheckHandler(handler) { log.permission.check = handler; },
    clearStorageData: async () => { log.cleared.push("storage"); },
    clearCache: async () => { log.cleared.push("cache"); },
  };
  const session = { fromPartition: (partition) => { log.partition = partition; return clean; } };
  const setTimer = (fn, ms) => { const timer = { fn, ms, unref() {} }; log.timers.push(timer); return timer; };
  const deps = { BrowserWindow: FakeWindow, session, randomId: () => "id1", setTimer };
  const open = (url = START) => openCleanSignIn(deps, url);
  return { log, open, win: () => log.windows[0] };
}

const nav = (url, extra = {}) => ({ url, isMainFrame: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra });

test("the clean window starts only on a composio.dev https page", () => {
  for (const url of ["https://github.com/login", "https://evil.example/composio.dev", "https://composio.dev.evil.example/", "http://backend.composio.dev/x", "https://u:p@backend.composio.dev/", "javascript:1", "nope", null]) {
    const f = fixture();
    assert.throws(() => f.open(url), String(url));
    assert.equal(f.log.windows.length, 0);
  }
  const f = fixture();
  assert.equal(f.open("https://composio.dev/a"), true);
  assert.deepEqual(f.log.loaded, ["https://composio.dev/a"]);
});

test("the window runs sandboxed in a memory session with no preload and no permissions", () => {
  const f = fixture();
  f.open();
  const { webPreferences } = f.win().options;
  assert.equal(f.log.partition, "clean-sign-in-id1");
  assert.ok(!webPreferences.partition.startsWith("persist:"));
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal("preload" in webPreferences, false);
  let granted = "unset";
  f.log.permission.request({}, "notifications", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(f.log.permission.check(), false);
});

test("the title stays the host of the current page", () => {
  const f = fixture();
  f.open();
  assert.equal(f.win().title, "backend.composio.dev");
  const title = nav("");
  f.win().webContents.emit("page-title-updated", title, "Sign in to GitHub");
  assert.equal(title.defaultPrevented, true);
  f.win().webContents.emit("did-navigate", {}, GITHUB_LOGIN);
  assert.equal(f.win().title, "github.com");
});

test("navigation, redirects and new windows outside composio.dev and github.com over https are blocked", () => {
  const f = fixture();
  f.open();
  const contents = f.win().webContents;
  for (const url of ["https://evil.example/", "http://github.com/login", "https://github.com.evil.example/", "file:///etc/passwd", "https://user:pw@github.com/"]) {
    const a = nav(url);
    contents.emit("will-navigate", a, url);
    assert.equal(a.defaultPrevented, true, `navigate ${url}`);
    const b = nav(url);
    contents.emit("will-redirect", b, url, false, true);
    assert.equal(b.defaultPrevented, true, `redirect ${url}`);
    assert.deepEqual(contents.openHandler({ url }), { action: "deny" });
  }
  assert.deepEqual(f.log.loaded, [START]);
  for (const url of [GITHUB_LOGIN, "https://api.github.com/x", CALLBACK]) {
    const a = nav(url);
    contents.emit("will-navigate", a, url);
    assert.equal(a.defaultPrevented, false);
  }
  assert.deepEqual(contents.openHandler({ url: GITHUB_LOGIN }), { action: "deny" });
  assert.deepEqual(f.log.loaded, [START, GITHUB_LOGIN]);
  const attach = nav("");
  contents.emit("will-attach-webview", attach);
  assert.equal(attach.defaultPrevented, true);
});

test("a redirect inside a subframe is not blocked", () => {
  const f = fixture();
  f.open();
  const frame = nav("https://captcha.example/", { isMainFrame: false });
  f.win().webContents.emit("will-redirect", frame, frame.url, false, false);
  assert.equal(frame.defaultPrevented, false);
});

test("the window closes after composio answers once github was reached, and clears its storage", () => {
  const f = fixture();
  f.open();
  const contents = f.win().webContents;
  contents.emit("did-navigate", {}, START);
  assert.equal(f.log.timers.length, 0);
  contents.emit("did-start-navigation", nav(GITHUB_LOGIN), GITHUB_LOGIN, false, true);
  contents.emit("did-navigate", {}, GITHUB_LOGIN);
  assert.equal(f.log.timers.length, 0, "no close while github is on screen");
  contents.emit("will-redirect", nav(CALLBACK), CALLBACK, false, true);
  assert.equal(f.log.timers.length, 0, "no close on the redirect into composio.dev");
  contents.emit("did-navigate", {}, CALLBACK);
  assert.equal(f.log.timers.length, 1);
  assert.ok(f.log.timers[0].ms <= 2_000);
  assert.equal(f.win().closed, false);
  f.log.timers[0].fn();
  assert.equal(f.win().closed, true);
  assert.deepEqual(f.log.cleared.sort(), ["cache", "storage"]);
});

test("a redirect that composio sends after the callback also closes the window", () => {
  const f = fixture();
  f.open();
  const contents = f.win().webContents;
  contents.emit("did-start-navigation", nav(GITHUB_LOGIN), GITHUB_LOGIN, false, true);
  contents.emit("will-redirect", nav(CALLBACK), CALLBACK, false, true);
  assert.equal(f.log.timers.length, 0);
  contents.emit("will-redirect", nav(DONE), DONE, false, true);
  assert.equal(f.log.timers.length, 1);
});

test("a blocked redirect that composio sends after the callback still closes the window", () => {
  const f = fixture();
  f.open();
  const contents = f.win().webContents;
  contents.emit("did-start-navigation", nav(GITHUB_LOGIN), GITHUB_LOGIN, false, true);
  contents.emit("will-redirect", nav(CALLBACK), CALLBACK, false, true);
  const away = nav("https://example.com/connected");
  contents.emit("will-redirect", away, away.url, false, true);
  assert.equal(away.defaultPrevented, true);
  assert.equal(f.log.timers.length, 1);
});

test("composio pages before github never close the window", () => {
  const f = fixture();
  f.open();
  const contents = f.win().webContents;
  contents.emit("did-navigate", {}, START);
  contents.emit("will-redirect", nav(DONE), DONE, false, true);
  contents.emit("did-navigate", {}, DONE);
  assert.equal(f.log.timers.length, 0);
});

test("a person who closes the window early still clears the storage", () => {
  const f = fixture();
  f.open();
  f.win().close();
  assert.deepEqual(f.log.cleared.sort(), ["cache", "storage"]);
});
