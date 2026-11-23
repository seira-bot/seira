import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SOURCE_ICON, WINDOWS_APP_ID, WINDOWS_SOURCE_APP_ID, applyWindowsAppId, windowsTaskbarDetails } from "./app-identity.mjs";
import { LEGACY_APP_NAME, LEGACY_LINUX_PACKAGE } from "./legacy-names.mjs";

const fakeApp = (isPackaged = true) => ({
  ids: [], isPackaged, listeners: [],
  getAppPath() { return "C:/src/seira"; },
  setAppUserModelId(id) { this.ids.push(id); },
  on(event, listener) { this.listeners.push([event, listener]); },
});
const fakeWindow = () => ({ details: [], icons: [], setAppDetails(d) { this.details.push(d); }, setIcon(i) { this.icons.push(i); } });

test("win32 gives the process the ID that the installer's shortcut carries", () => {
  const app = fakeApp();
  applyWindowsAppId({ app, platform: "win32" });
  assert.deepEqual(app.ids, ["bot.seira.app"]);
});

test("macOS and Linux set no app user model ID", () => {
  for (const platform of ["darwin", "linux", "freebsd"]) {
    const app = fakeApp();
    applyWindowsAppId({ app, platform });
    assert.deepEqual(app.ids, [], platform);
  }
});

test("the ID equals the appId that electron-builder writes into the shortcut", () => {
  const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.equal(/^appId:\s*(\S+)\s*$/m.exec(builder)?.[1], WINDOWS_APP_ID);
});

test("main sets the ID before the app is ready", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const call = source.search(/^\s*applyWindowsAppId\(/m);
  const ready = source.indexOf("app.whenReady()");
  assert.ok(call > 0, "main.mjs calls applyWindowsAppId");
  assert.ok(ready > 0 && call < ready, "the call comes before app.whenReady()");
});

test("the app name is Seira, so the settings folder and the saved-key store item carry it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Electron takes productName before name.
  assert.equal(pkg.productName, "Seira");
  assert.equal(pkg.name, "seira");
  assert.notEqual(pkg.productName, LEGACY_APP_NAME);
});

test("the app starts at boot.mjs, which chooses the settings folder before it loads main.mjs", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "electron/boot.mjs");
  const boot = readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(boot, /^import .*["']\.\/main\.mjs["']/m, "a static import would run main.mjs first");
  const choose = boot.indexOf("chooseSettingsFolder(");
  const main = boot.indexOf('import("./main.mjs")');
  assert.ok(choose > 0 && main > choose, "boot.mjs chooses the folder, then loads main.mjs");
});

test("the deb and pacman packages are named seira and replace the package that an earlier install used", () => {
  const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const packageNames = [...builder.matchAll(/^\s+packageName:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(packageNames, ["seira", "seira"]);
  for (const section of ["deb", "pacman"]) {
    const block = new RegExp(`^${section}:\\n((?:[ #].*\\n|\\n)*)`, "m").exec(builder)?.[1] ?? "";
    const fpm = /^\s+fpm:\s*(\[[^\]]*\])/m.exec(block)?.[1];
    assert.ok(fpm, `${section} has fpm arguments`);
    const args = JSON.parse(fpm);
    for (const flag of ["--conflicts", "--replaces", "--provides"]) {
      assert.equal(args[args.indexOf(flag) + 1], LEGACY_LINUX_PACKAGE, `${section} ${flag} ${LEGACY_LINUX_PACKAGE}`);
    }
  }
});

const PACKAGED_EXE = "C:/Users/someone/AppData/Local/Programs/Seira/Seira.exe";

test("win32 from source uses its own ID and the dev relaunch details", () => {
  const app = fakeApp(false);
  applyWindowsAppId({ app, platform: "win32", iconPath: "C:/seira/icon.ico", windowsStore: false });
  assert.deepEqual(app.ids, ["bot.seira.app.dev"]);
  assert.equal(app.listeners.length, 1);
  assert.equal(app.listeners[0][0], "browser-window-created");
  const win = fakeWindow();
  app.listeners[0][1]({}, win);
  assert.deepEqual(win.details, [{
    appId: "bot.seira.app.dev",
    appIconPath: "C:/seira/icon.ico",
    appIconIndex: 0,
    relaunchCommand: `"${process.execPath}" "C:/src/seira"`,
    relaunchDisplayName: "Seira (dev)",
  }]);
  assert.deepEqual(win.icons, ["C:/seira/icon.ico"]);
});

test("the source ID and the installed ID differ", () => {
  assert.notEqual(WINDOWS_SOURCE_APP_ID, WINDOWS_APP_ID);
});

test("win32 NSIS package gets explicit relaunch details and keeps the window icon", () => {
  const app = fakeApp(true);
  applyWindowsAppId({ app, platform: "win32", windowsStore: false });
  assert.deepEqual(app.ids, ["bot.seira.app"]);
  assert.equal(app.listeners.length, 1);
  const win = fakeWindow();
  app.listeners[0][1]({}, win);
  assert.equal(win.details.length, 1);
  assert.equal(win.details[0].appId, "bot.seira.app");
  assert.equal(win.details[0].relaunchDisplayName, "Seira");
  assert.deepEqual(win.icons, []);
  assert.deepEqual(
    windowsTaskbarDetails({ platform: "win32", isPackaged: true, windowsStore: false, execPath: PACKAGED_EXE }),
    { appId: "bot.seira.app", appIconPath: PACKAGED_EXE, appIconIndex: 0, relaunchCommand: `"${PACKAGED_EXE}"`, relaunchDisplayName: "Seira" },
  );
});

test("win32 Microsoft Store package sets the ID and registers no details", () => {
  const app = fakeApp(true);
  applyWindowsAppId({ app, platform: "win32", windowsStore: true });
  assert.deepEqual(app.ids, ["bot.seira.app"]);
  assert.deepEqual(app.listeners, []);
  assert.equal(windowsTaskbarDetails({ platform: "win32", isPackaged: true, windowsStore: true }), null);
});

test("Linux and macOS from source register nothing", () => {
  for (const platform of ["darwin", "linux"]) {
    const app = fakeApp(false);
    applyWindowsAppId({ app, platform });
    assert.deepEqual(app.listeners, [], platform);
    assert.equal(windowsTaskbarDetails({ platform, isPackaged: false }), null, platform);
  }
});

test("the source icon is the installer icon and exists in a checkout", () => {
  assert.ok(SOURCE_ICON.endsWith(join("build", "icon.ico")));
  assert.ok(readFileSync(SOURCE_ICON).length > 0);
});
