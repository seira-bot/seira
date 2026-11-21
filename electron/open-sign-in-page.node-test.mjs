import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import { signInPageOpener } from "./app-permissions.mjs";

const require = createRequire(import.meta.url);
const localOrigin = require("./local-origin.cjs");
const { workspaceSenderAllowed } = require("./environments.cjs");

const LOCAL = "http://127.0.0.1:48992";
const SERVER = "https://seira.example.test";
const SIGN_IN = "https://auth.example.test/authorize?client_id=seira&state=s1";
const preloadSource = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function preload({ origin, active }) {
  const invoked = [];
  let bridge;
  vm.runInNewContext(preloadSource, {
    process: { platform: "win32", argv: [`--seira-local-origin=${LOCAL}`] },
    location: { origin },
    navigator: { userActivation: { isActive: active } },
    URL,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } }, ipcRenderer: {
      on: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => false,
      invoke: (...args) => { invoked.push(args); return Promise.resolve(true); },
    } }),
  });
  return { bridge, invoked };
}

test("another server's page opens an https sign-in page from the person's click", async () => {
  const page = preload({ origin: SERVER, active: true });
  assert.equal(page.bridge.openExternal, undefined, "the wide link opener stays this computer's own");
  assert.equal(await page.bridge.openSignInPage(SIGN_IN), true);
  assert.deepEqual(page.invoked, [["desktop:open-sign-in-page", SIGN_IN]]);
});

test("another server's page cannot open a sign-in page without a click, or any address that is not https", async () => {
  const late = preload({ origin: SERVER, active: false });
  await assert.rejects(late.bridge.openSignInPage(SIGN_IN));
  const page = preload({ origin: SERVER, active: true });
  for (const url of ["http://auth.example.test/authorize", "mailto:a@example.com", "javascript:alert(1)", "file:///etc/passwd", "not a url", null]) {
    await assert.rejects(page.bridge.openSignInPage(url), String(url));
  }
  assert.deepEqual([...late.invoked, ...page.invoked], []);
});

test("main opens only an https address, with no user name or password in it", async () => {
  const opened = [];
  const open = signInPageOpener({ allowed: () => true, open: async (url) => { opened.push(url); } });
  assert.equal(await open({}, SIGN_IN), true);
  for (const url of ["http://auth.example.test/authorize", "http://127.0.0.1:5000/authorize", "http://localhost:5000/authorize", "https://user:secret@auth.example.test/", "mailto:a@example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "seira://open", "ms-settings:privacy", "not a url", null, 42]) {
    await assert.rejects(open({}, url), String(url));
  }
  assert.deepEqual(opened, [SIGN_IN]);
});

function productionHandler(state) {
  const start = mainSource.indexOf('ipcMain.handle("desktop:open-sign-in-page"');
  assert.ok(start > 0, "main.mjs registers the channel");
  const end = mainSource.indexOf("}));\n", start) + "}));".length;
  assert.equal(mainSource.split('"desktop:open-sign-in-page"').length, 2, "exactly one registration of the channel in main.mjs");
  const handlers = new Map();
  const opened = [];
  const mainWindow = { webContents: { mainFrame: { url: "" } } };
  vm.runInNewContext(mainSource.slice(start, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    signInPageOpener,
    shell: { openExternal: async (url) => { opened.push(url); } },
    senderIsLocal: localOrigin.isLocalSender,
    homeWindow: { homePage: () => false },
    workspaceSenderAllowed,
    mainWindow,
    environmentsState: state,
    rendererOrigin: () => LOCAL,
  });
  const from = (url, frame = mainWindow.webContents.mainFrame) => {
    frame.url = url;
    return { sender: mainWindow.webContents, senderFrame: frame };
  };
  return { handler: handlers.get("desktop:open-sign-in-page"), opened, from };
}

test("main opens the page for the window's own page and the server on screen, and refuses any other page", async () => {
  localOrigin.setLocalOrigin(LOCAL);
  const { handler, opened, from } = productionHandler({ activeId: "s1", environments: [{ id: "s1", kind: "remote", origin: SERVER }] });
  assert.equal(await handler(from(`${SERVER}/chat`), SIGN_IN), true);
  assert.equal(await handler(from(`${LOCAL}/chat`), SIGN_IN), true);
  await assert.rejects(handler(from("https://other.example.test/"), SIGN_IN), "a page the window does not show");
  await assert.rejects(handler(from(`${SERVER}/frame`, { url: "" }), SIGN_IN), "a frame inside the server's page");
  await assert.rejects(handler(from(`${SERVER}/chat`), "http://auth.example.test/authorize"), "an address that is not https");
  assert.deepEqual(opened, [SIGN_IN, SIGN_IN]);
});
