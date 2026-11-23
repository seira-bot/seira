import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { installPowerIpc } from "./power-ipc.mjs";

const require = createRequire(import.meta.url);
const localOrigin = require("./local-origin.cjs");

const LOCAL = "http://127.0.0.1:48993";
const REMOTE = "https://remote.example.test";

function setup() {
  const handlers = new Map();
  const mainFrame = {};
  let quits = 0, relaunches = 0;
  installPowerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly,
    requireMainWindowSender: (event) => {
      if (event.sender.window !== "main" || event.senderFrame !== mainFrame) throw new Error("The desktop client window is unavailable");
    },
    relaunch: () => { relaunches += 1; },
    quit: () => { quits += 1; },
  });
  const event = (url, window = "main") => ({ senderFrame: url === null ? {} : mainFrame, sender: { window, mainFrame, getURL: () => url ?? "" } });
  return { handler: handlers.get("desktop:quit"), event, quits: () => quits, relaunches: () => relaunches, channels: [...handlers.keys()] };
}

test("the local main window quits the app", () => {
  const power = setup();
  localOrigin.setLocalOrigin(LOCAL);
  assert.deepEqual(power.channels, ["desktop:relaunch", "desktop:quit"]);
  assert.equal(power.handler(power.event(`${LOCAL}/`)), true);
  assert.equal(power.quits(), 1);
});

test("a page that is not the local main window cannot quit the app", () => {
  const power = setup();
  localOrigin.setLocalOrigin(LOCAL);
  assert.throws(() => power.handler(power.event(`${REMOTE}/`)), /only available while using the local server/);
  assert.throws(() => power.handler(power.event(`${LOCAL}/`, "other")), /desktop client window is unavailable/);
  assert.throws(() => power.handler({ senderFrame: { url: `${LOCAL}/` }, sender: { window: "main", mainFrame: {}, getURL: () => `${LOCAL}/` } }), /desktop client window is unavailable/);
  localOrigin.setLocalOrigin(null);
  assert.throws(() => power.handler(power.event(`${LOCAL}/`)), /only available while using the local server/);
  assert.equal(power.quits(), 0);
  assert.equal(power.relaunches(), 0);
});
