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

test("the app name and the Linux package name stay the ones that an earlier install used", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, LEGACY_APP_NAME);
  const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  const packageNames = [...builder.matchAll(/^\s+packageName:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(packageNames, [LEGACY_LINUX_PACKAGE, LEGACY_LINUX_PACKAGE]);
});
