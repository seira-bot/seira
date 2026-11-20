import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { autostartEntry, createOpenAtLogin, installOpenAtLogin } from "./open-at-login.mjs";

/** Electron's login item API on macOS and Windows: one item per name, as Windows keeps one Run entry per name. */
function fakeApp({ openAtLogin = false, isPackaged = true } = {}) {
  const items = new Map(openAtLogin ? [["Seira", { args: [] }]] : []);
  return {
    isPackaged, items, wasOpenedAtLogin: false,
    getLoginItemSettings() {
      return { openAtLogin: items.size > 0, wasOpenedAtLogin: this.wasOpenedAtLogin, launchItems: [...items].map(([name, item]) => ({ name, args: item.args, enabled: true })) };
    },
    setLoginItemSettings({ openAtLogin: on, args = [], name = "Seira" }) { if (on) items.set(name, { args }); else items.delete(name); },
  };
}

const temp = async t => { const dir = await mkdtemp(path.join(os.tmpdir(), "seira-open-at-login-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test("macOS: the person's own login item opens the window, and lending never takes it away", async t => {
  const dir = await temp(t);
  const app = fakeApp();
  const login = createOpenAtLogin({ app, file: path.join(dir, "mac.json"), platform: "darwin", home: dir });
  assert.equal(login.chosen(), false);
  login.choose(true);
  assert.equal(login.chosen(), true);
  app.wasOpenedAtLogin = true;
  assert.equal(login.startedHidden(), false, "a launch from the person's own item opens the window");
  login.follow(true);
  login.follow(false);
  assert.equal(login.chosen(), true, "lending stopping leaves it");
  login.choose(false);
  assert.equal(app.getLoginItemSettings().openAtLogin, false);
});

test("macOS: choosing it while lending added one makes it the person's, so it opens the window and stays", async t => {
  const dir = await temp(t);
  const app = fakeApp();
  const login = createOpenAtLogin({ app, file: path.join(dir, "mac.json"), platform: "darwin", home: dir });
  login.follow(true);
  assert.equal(login.chosen(), false, "lending's own item is not the person's choice");
  login.choose(true);
  app.wasOpenedAtLogin = true;
  assert.deepEqual([login.chosen(), login.startedHidden()], [true, false]);
  login.follow(false);
  assert.equal(app.getLoginItemSettings().openAtLogin, true);
});

test("Windows: the person's item has a name of its own, apart from lending's hidden one", async t => {
  const dir = await temp(t);
  const app = fakeApp();
  const login = createOpenAtLogin({ app, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["Seira.exe"] });
  login.follow(true);
  login.choose(true);
  assert.equal(login.chosen(), true);
  assert.deepEqual(app.items.get("Seira at login"), { args: [] }, "no hidden flag");
  login.follow(false);
  assert.equal(login.chosen(), true, "lending stopping leaves it");
  login.choose(false);
  assert.equal(login.chosen(), false);
});

/** Electron 43's login item API on Windows: one Run entry per name (the AppUserModelId unless named), `openAtLogin` true
 * only for that default entry with exactly the asked `args`, and `launchItems` listing every entry for this executable. */
function windowsApp(entries = []) {
  const items = new Map(entries.map(({ name, args = [], enabled = true }) => [name, { args, enabled }]));
  const DEFAULT = "electron.app.Seira";
  return {
    isPackaged: true, items,
    getLoginItemSettings({ args = [] } = {}) {
      const own = items.get(DEFAULT);
      return {
        openAtLogin: Boolean(own) && JSON.stringify(own.args) === JSON.stringify(args),
        launchItems: [...items].map(([name, item]) => ({ name, path: "C:\\Seira\\Seira.exe", args: item.args, scope: "user", enabled: item.enabled })),
      };
    },
    setLoginItemSettings({ openAtLogin: on, args = [], name = DEFAULT }) { if (on) items.set(name, { args, enabled: true }); else items.delete(name); },
  };
}

test("Windows: Settings shows on while Windows already starts the app, even from lending's hidden entry", async t => {
  const dir = await temp(t);
  const app = windowsApp([{ name: "electron.app.Seira", args: ["--seira-hidden"] }]);
  const login = createOpenAtLogin({ app, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["Seira.exe"] });
  const handlers = new Map();
  installOpenAtLogin({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler, loginItem: login, changed: () => {} });
  assert.deepEqual(await handlers.get("open-at-login:state")({}), { available: true, on: true, startupApps: false });
  app.items.get("electron.app.Seira").enabled = false;
  assert.equal(login.chosen(), false, "an entry turned off in Task Manager starts nothing");
});

test("Windows: turning it off removes every entry that starts the app, and lending adds none until it is on again", async t => {
  const dir = await temp(t);
  const app = windowsApp([{ name: "electron.app.Seira", args: ["--seira-hidden"] }, { name: "Seira at login" }]);
  const login = createOpenAtLogin({ app, file: path.join(dir, "win.json"), platform: "win32", home: dir, argv: ["Seira.exe"] });
  login.choose(false);
  assert.deepEqual([...app.items.keys()], []);
  login.follow(true);
  assert.equal(login.chosen(), false, "lending keeps to the person's choice");
  login.choose(true);
  login.follow(true);
  assert.deepEqual([...app.items].sort(), [["Seira at login", { args: [], enabled: true }], ["electron.app.Seira", { args: ["--seira-hidden"], enabled: true }]]);
});

test("Linux: the person's autostart entry has no hidden flag and no lending mark, and lending never removes it", async t => {
  const dir = await temp(t);
  const config = path.join(dir, "config");
  const entry = path.join(config, "autostart", "seira.desktop");
  const login = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "linux.json"), platform: "linux", home: dir, env: { XDG_CONFIG_HOME: config, APPIMAGE: "/home/me/Seira.AppImage" } });
  login.choose(true);
  assert.equal(await readFile(entry, "utf8"), autostartEntry("/home/me/Seira.AppImage", { lending: false }));
  assert.doesNotMatch(await readFile(entry, "utf8"), /--seira-hidden|X-Seira-Lending/);
  assert.equal(login.chosen(), true);
  login.follow(false);
  assert.equal(existsSync(entry), true, "lending stopping leaves it");
  login.choose(false);
  assert.equal(existsSync(entry), false);
});

test("a build that cannot add a login item offers no switch and changes nothing", async t => {
  const dir = await temp(t);
  const app = fakeApp({ isPackaged: false });
  const login = createOpenAtLogin({ app, file: path.join(dir, "dev.json"), platform: "darwin", home: dir });
  const handlers = new Map();
  let redraws = 0;
  installOpenAtLogin({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler, loginItem: login, changed: () => redraws++ });
  assert.deepEqual(await handlers.get("open-at-login:state")({}), { available: false, on: false, startupApps: false });
  await handlers.get("open-at-login:set")({}, true);
  assert.equal(app.getLoginItemSettings().openAtLogin, false);
  const packaged = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "mac.json"), platform: "darwin", home: dir });
  installOpenAtLogin({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler, loginItem: packaged, changed: () => redraws++ });
  assert.deepEqual(await handlers.get("open-at-login:set")({}, true), { available: true, on: true, startupApps: false });
  assert.deepEqual(await handlers.get("open-at-login:set")({}, "yes"), { available: true, on: false, startupApps: false }, "only a real true turns it on");
  assert.equal(redraws, 3, "the app menu's item is drawn again after each change");
});

test("Linux in a snap: the autostart entry starts the snap's stable command, not this revision's path", async t => {
  const dir = await temp(t);
  const config = path.join(dir, "config");
  const entry = path.join(config, "autostart", "seira.desktop");
  const env = { XDG_CONFIG_HOME: config, SNAP: "/snap/seira/17", SNAP_NAME: "seira" };
  const login = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "snap.json"), platform: "linux", home: dir, env, execPath: "/snap/seira/17/seira" });
  login.choose(true);
  assert.equal(await readFile(entry, "utf8"), autostartEntry("/snap/bin/seira", { lending: false }));
  login.choose(false);
  login.follow(true);
  assert.equal(await readFile(entry, "utf8"), autostartEntry("/snap/bin/seira"));
});

test("Windows in a Microsoft Store package: no Run entry is ever written, and only Startup apps can start the app", async t => {
  const dir = await temp(t);
  const app = windowsApp([{ name: "electron.app.Seira", args: ["--seira-hidden"] }]);
  const writes = [];
  const setLoginItemSettings = app.setLoginItemSettings.bind(app);
  app.setLoginItemSettings = settings => { writes.push(settings); setLoginItemSettings(settings); };
  const login = createOpenAtLogin({ app, file: path.join(dir, "store.json"), platform: "win32", home: dir, argv: ["Seira.exe"], windowsStore: true });
  assert.deepEqual([login.available(), login.startupApps(), login.chosen(), login.starts()], [false, true, false, false]);
  login.follow(true);
  login.follow(false);
  login.choose(true);
  login.choose(false);
  login.hold(true);
  assert.equal(login.homeAdd(), null);
  login.homeRelease({ declined: false, lending: true });
  assert.deepEqual(writes, [], "nothing reaches the Run key");
  const handlers = new Map();
  installOpenAtLogin({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_channel, handler) => handler, loginItem: login, changed: () => {} });
  assert.deepEqual(await handlers.get("open-at-login:state")({}), { available: false, on: false, startupApps: true });
  assert.deepEqual(await handlers.get("open-at-login:set")({}, true), { available: false, on: false, startupApps: true });
  assert.deepEqual(writes, []);
});

test("a Store package on another system, or a build that is not packaged, keeps the normal behaviour", async t => {
  const dir = await temp(t);
  const mac = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "mac.json"), platform: "darwin", home: dir, windowsStore: true });
  assert.deepEqual([mac.available(), mac.startupApps()], [true, false]);
  const win = createOpenAtLogin({ app: windowsApp(), file: path.join(dir, "win.json"), platform: "win32", home: dir, windowsStore: undefined });
  assert.deepEqual([win.available(), win.startupApps()], [true, false]);
  const dev = createOpenAtLogin({ app: { ...windowsApp(), isPackaged: false }, file: path.join(dir, "dev.json"), platform: "win32", home: dir, windowsStore: true });
  assert.equal(dev.startupApps(), false);
});

test("Linux: an earlier version's autostart file becomes the current one, keeping its kind", async t => {
  const dir = await temp(t);
  const config = path.join(dir, "config");
  const autostart = path.join(config, "autostart");
  const make = () => createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "migrate.json"), platform: "linux", home: dir, env: { XDG_CONFIG_HOME: config, APPIMAGE: "/home/me/Seira.AppImage" } });
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  mkdirSync(autostart, { recursive: true });
  writeFileSync(path.join(autostart, "openmausbot.desktop"), "[Desktop Entry]\nExec=\"/old\" --hidden\nX-OpenMausBot-Lending=true\n");
  make().migrateLegacy();
  assert.ok(!existsSync(path.join(autostart, "openmausbot.desktop")));
  assert.equal(readFileSync(path.join(autostart, "seira.desktop"), "utf8"), autostartEntry("/home/me/Seira.AppImage", { lending: true }));
  make().migrateLegacy();
  assert.equal(readFileSync(path.join(autostart, "seira.desktop"), "utf8"), autostartEntry("/home/me/Seira.AppImage", { lending: true }), "a second run changes nothing");
});

test("Linux: the person's own old autostart file stays a chosen item, and the current file is never replaced", async t => {
  const dir = await temp(t);
  const config = path.join(dir, "config");
  const autostart = path.join(config, "autostart");
  const login = createOpenAtLogin({ app: fakeApp(), file: path.join(dir, "migrate.json"), platform: "linux", home: dir, env: { XDG_CONFIG_HOME: config, APPIMAGE: "/home/me/Seira.AppImage" } });
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  mkdirSync(autostart, { recursive: true });
  writeFileSync(path.join(autostart, "openmausbot.desktop"), "[Desktop Entry]\nExec=\"/old\"\n");
  login.migrateLegacy();
  assert.equal(readFileSync(path.join(autostart, "seira.desktop"), "utf8"), autostartEntry("/home/me/Seira.AppImage", { lending: false }));
  assert.equal(login.chosen(), true);
  writeFileSync(path.join(autostart, "openmausbot.desktop"), "[Desktop Entry]\nExec=\"/old\"\nX-OpenMausBot-Lending=true\n");
  writeFileSync(path.join(autostart, "seira.desktop"), "kept");
  login.migrateLegacy();
  assert.equal(readFileSync(path.join(autostart, "seira.desktop"), "utf8"), "kept");
  assert.ok(!existsSync(path.join(autostart, "openmausbot.desktop")));
});
