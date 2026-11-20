import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WINDOWS_APP_ID, applyWindowsAppId } from "./app-identity.mjs";
import { LEGACY_APP_NAME, LEGACY_LINUX_PACKAGE } from "./legacy-names.mjs";

const fakeApp = () => ({ ids: [], setAppUserModelId(id) { this.ids.push(id); } });

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
