import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchAppImageUpdater } from "../scripts/patch-appimage-updater.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(root, "electron/vendor/electron-updater.cjs"), "utf8");

// Non-global on purpose: a shared /g regex carries lastIndex between .test()
// calls and would report alternating results.
const renamePattern = /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/;

test("the vendored bundle still contains the AppImage installer we patch", () => {
  assert.match(bundle, /const appImageFile = process\.env\["APPIMAGE"\]/);
  assert.match(bundle, /destination = appImageFile;/);
});

test("the install stages the replacement instead of deleting first", () => {
  // Upstream unlinks the AppImage before the download is validated; nothing may remove the running file ahead of the rename.
  assert.doesNotMatch(bundle, /unlinkSync\)\(appImageFile\)/);
  assert.match(bundle, /renameSync\)\(stagedDestination, destination\)/);
});

test("an AppImage update can never be written to a different filename", () => {
  // Upstream renames a versioned running file, orphaning every .desktop entry, symlink and dock pin pointing at it.
  assert.doesNotMatch(bundle, renamePattern);
});

const SHARED_RELAUNCH = 'require("../relaunch-after-exit.cjs").relaunchAppImageAfterExit(destination, [], {';

// The shape of the sites the patch rewrites, as esbuild emits them.
const UPSTREAM = [
  "        (0, fs_1.unlinkSync)(appImageFile);",
  "        let destination;",
  "        const existingBaseName = path2.basename(appImageFile);",
  "        const installerPath = this.installerPath;",
  "        if (path2.basename(installerPath) === existingBaseName || !/\\d+\\.\\d+\\.\\d+/.test(existingBaseName)) {",
  "          destination = appImageFile;",
  "        } else {",
  "          destination = path2.join(path2.dirname(appImageFile), path2.basename(installerPath));",
  "        }",
  '        (0, child_process_1.execFileSync)("mv", ["-f", installerPath, destination]);',
  '        this.spawnLog(destination, [], env);',
].join("\n");

test("the patch keeps the running path and never deletes ahead of the rename", () => {
  const patched = patchAppImageUpdater(UPSTREAM);

  assert.doesNotMatch(patched, renamePattern);
  assert.equal(patched.match(/destination = appImageFile;/g)?.length, 2);
  assert.doesNotMatch(patched, /unlinkSync\)\(appImageFile\)/);
  assert.match(patched, /mv", \["-f", installerPath, stagedDestination\]/);
  assert.match(patched, /renameSync\)\(stagedDestination, destination\)/);
  // Electron's relauncher sets no_new_privs, so the AppImage runtime cannot mount the update with setuid fusermount.
  assert.doesNotMatch(patched, /app\.relaunch\(/);
  assert.ok(patched.includes(SHARED_RELAUNCH), patched);
  assert.doesNotMatch(patched, /this\.spawnLog\(destination/);
});

test("the vendored bundle restarts the AppImage through the desktop's shared restart", () => {
  assert.doesNotMatch(bundle, /app\.relaunch\(\{ execPath: destination/);
  assert.ok(bundle.includes(SHARED_RELAUNCH));
  assert.equal(typeof createRequire(import.meta.url)("./relaunch-after-exit.cjs").relaunchAppImageAfterExit, "function");
});

test("the patch tolerates esbuild renaming the path import", () => {
  const patched = patchAppImageUpdater(UPSTREAM.replaceAll("path2", "path7"));

  assert.doesNotMatch(patched, renamePattern);
  assert.equal(patched.match(/destination = appImageFile;/g)?.length, 2);
});

test("the patch fails closed when upstream's shape moves", () => {
  for (const [label, mutated] of [
    ["no rename branch", UPSTREAM.replace(/destination = path2\.join[^;]+;/, "destination = elsewhere;")],
    ["no early unlink", UPSTREAM.replace("        (0, fs_1.unlinkSync)(appImageFile);\n", "")],
    ["no move", UPSTREAM.replace(/\(0, child_process_1\.execFileSync\)\("mv"[^;]+;/, "")],
    ["no immediate relaunch", UPSTREAM.replace("this.spawnLog(destination, [], env);", "")],
    ["two rename branches", `${UPSTREAM}\n${UPSTREAM}`],
  ]) {
    assert.throws(() => patchAppImageUpdater(mutated), /to patch, found/, label);
  }
});

test("the shipped installer replaces the AppImage and starts it after the old process exits", {
  skip: process.platform !== "linux" && "AppImage updates run only on Linux",
  timeout: 20_000,
}, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-install-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  // The user launches a versioned filename — the case upstream renames.
  const launched = join(workspace, "OpenMausBot-0.1.43-x86_64.AppImage");
  const staged = join(workspace, "pending", "OpenMausBot-0.1.44-x86_64.AppImage");
  const installer = join(workspace, "installer.cjs");
  const installed = join(workspace, "installed.json");
  const keepAlive = join(workspace, "keep-alive.txt");
  const receipt = join(workspace, "restarted.json");
  const data = join(workspace, "data");
  const leaseModule = new URL("./data-dir-lease.mjs", import.meta.url).href;
  mkdirSync(join(workspace, "pending"));
  writeFileSync(launched, "old", { mode: 0o755 });
  const replacement = `
    const { readdirSync, readFileSync, readlinkSync, writeFileSync } = require("node:fs");
    (async () => {
      // A zombie has exited, though kill(pid, 0) still answers for it.
      let parentAlive = true;
      try { parentAlive = !/^\\d+ \\(.*\\) [ZX] /.test(readFileSync("/proc/" + process.env.OMB_UPDATER_TEST_PARENT + "/stat", "utf8")); }
      catch (error) { if (error.code === "ENOENT") parentAlive = false; else throw error; }
      const descriptors = readdirSync("/proc/self/fd").map((fd) => { try { return readlinkSync("/proc/self/fd/" + fd); } catch { return null; } });
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      acquireDataDirLease(${JSON.stringify(data)}).release();
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ parentAlive, acquired: true, descriptors,
        noNewPrivs: readFileSync("/proc/self/status", "utf8").match(/NoNewPrivs:\\s*(\\d)/)?.[1],
        appImage: process.env.APPIMAGE, silent: process.env.APPIMAGE_SILENT_INSTALL }));
    })().catch((error) => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ error: error.message })); process.exitCode = 1; });
  `;
  // A disposable executable substitutes for the AppImage payload, not for the vendored methods.
  writeFileSync(staged, `#!${process.execPath}\n${replacement}`, { mode: 0o755 });
  writeFileSync(installer, `
    const Module = require("node:module");
    const { EventEmitter } = require("node:events");
    const { existsSync, readlinkSync, writeFileSync } = require("node:fs");
    const load = Module._load;
    const electron = { app: { relaunch() { throw new Error("Electron's relauncher cannot mount an AppImage"); } }, autoUpdater: new EventEmitter() };
    Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
    (async () => {
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      const lease = acquireDataDirLease(${JSON.stringify(data)});
      writeFileSync(${JSON.stringify(keepAlive)}, readlinkSync("/proc/self/fd/3"));
      process.env.APPIMAGE = ${JSON.stringify(launched)};
      process.env.OMB_UPDATER_TEST_PARENT = String(process.pid);
      const silent = process.env.APPIMAGE_SILENT_INSTALL;
      const { AppImageUpdater } = require(${JSON.stringify(join(root, "electron/vendor/electron-updater.cjs"))});
      const renames = [];
      const errors = [];
      const result = AppImageUpdater.prototype.doInstall.call({
        installerPath: ${JSON.stringify(staged)},
        _logger: { info() {}, warn() {}, debug() {}, error: (message) => errors.push(String(message)) },
        dispatchError(error) { throw error; },
        emit: (event, value) => renames.push([event, value]),
        spawnLog() { throw new Error("the replacement must not start before desktop shutdown"); },
      }, { isForceRunAfter: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeFileSync(${JSON.stringify(installed)}, JSON.stringify({ result, renames, errors,
        silentKept: process.env.APPIMAGE_SILENT_INSTALL === silent, startedEarly: existsSync(${JSON.stringify(receipt)}) }));
      lease.release();
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);

  // fd 3 stands for the AppImage runtime's keep-alive pipe: inherited without close-on-exec, it holds the old mount open.
  const child = spawn(process.execPath, [installer], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, output);
  for (let attempt = 0; !existsSync(receipt) && attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.deepEqual(JSON.parse(readFileSync(installed, "utf8")), {
    result: true, renames: [], errors: [], silentKept: true, startedEarly: false,
  }, "no filename change means no appimage-filename-updated event, and nothing starts before the old process exits");
  assert.equal(existsSync(receipt), true, `the updated AppImage never started: ${output}`);
  const { descriptors, ...restarted } = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(restarted, {
    parentAlive: false, acquired: true, noNewPrivs: "0", appImage: launched, silent: "true",
  });
  const keptMount = readFileSync(keepAlive, "utf8");
  assert.equal(descriptors.includes(keptMount), false, `the new version inherited ${keptMount} from the old one`);
  assert.equal(readFileSync(launched, "utf8"), `#!${process.execPath}\n${replacement}`, "the update must land on the launched path");
  assert.equal(existsSync(staged), false, "the staged download must be consumed");
  assert.deepEqual(readdirSync(workspace).sort(),
    ["OpenMausBot-0.1.43-x86_64.AppImage", "data", "installed.json", "installer.cjs", "keep-alive.txt", "pending", "restarted.json"]);
});

test("a failed AppImage restart is reported without quitting the desktop", {
  skip: process.platform === "win32" && "AppImage updates run only on Linux",
}, (t) => {
  const electron = { app: { relaunch: () => assert.fail("Electron's relauncher cannot mount an AppImage") }, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => request === "electron" ? electron : load(request, ...rest);
  t.after(() => { Module._load = load; });
  const { AppImageUpdater, BaseUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-relaunch-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const launched = join(workspace, "OpenMausBot.AppImage");
  const staged = join(workspace, "pending.AppImage");
  writeFileSync(launched, "old");
  writeFileSync(staged, "new");
  // A PATH that holds mv and no bash makes the restart shell fail to start.
  const bin = join(workspace, "bin");
  mkdirSync(bin);
  symlinkSync(spawnSync("which", ["mv"], { encoding: "utf8" }).stdout.trim(), join(bin, "mv"));
  const previous = { APPIMAGE: process.env.APPIMAGE, APPIMAGE_SILENT_INSTALL: process.env.APPIMAGE_SILENT_INSTALL, PATH: process.env.PATH };
  Object.assign(process.env, { APPIMAGE: launched, APPIMAGE_SILENT_INSTALL: "previous", PATH: bin });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const errors = [];
  const updater = {
    installerPath: staged,
    downloadedUpdateHelper: { downloadedFileInfo: {} },
    _logger: { info() {}, warn() {}, error() {} },
    dispatchError: (error) => errors.push(error.message),
    emit() {},
    doInstall: AppImageUpdater.prototype.doInstall,
    install: BaseUpdater.prototype.install,
    app: { quit: () => assert.fail("a failed restart must not quit the desktop") },
  };
  BaseUpdater.prototype.quitAndInstall.call(updater, true, true);
  assert.deepEqual(errors, ["Could not schedule the AppImage to restart"]);
  assert.equal(updater.quitAndInstallCalled, false);
  assert.equal(process.env.APPIMAGE_SILENT_INSTALL, "previous");
  assert.equal(readFileSync(launched, "utf8"), "new", "the installed replacement remains available for a manual restart");
});

test("the running AppImage is never removed before its replacement is in place", (t) => {
  const electron = { app: {}, autoUpdater: new EventEmitter() };
  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? electron : load(request, ...rest));
  t.after(() => {
    Module._load = load;
  });

  const { AppImageUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const launched = join(workspace, "OpenMausBot-0.1.43-x86_64.AppImage");
  writeFileSync(launched, "the app the user has", { mode: 0o755 });

  const previous = process.env.APPIMAGE;
  process.env.APPIMAGE = launched;
  t.after(() => {
    if (previous === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previous;
  });

  // A missing staged download stands in for every way the move can fail (full disk, cut-short copy, revoked mount).
  assert.throws(() =>
    AppImageUpdater.prototype.doInstall.call(
      {
        installerPath: join(workspace, "never-downloaded.AppImage"),
        _logger: { info() {}, warn() {}, error() {}, debug() {} },
        dispatchError: (error) => {
          throw error;
        },
        emit() {},
        spawnLog: () => assert.fail("a failed install must not relaunch"),
      },
      { isForceRunAfter: true },
    ),
  );

  assert.equal(readFileSync(launched, "utf8"), "the app the user has", "a failed update cost the user their app");
  assert.deepEqual(readdirSync(workspace), [basename(launched)], "a partial download was left behind");
});

const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout?.trim()
  : "";
const dbusRunSession = process.platform === "linux" && !process.env.DBUS_SESSION_BUS_ADDRESS
  ? spawnSync("which", ["dbus-run-session"], { encoding: "utf8" }).stdout?.trim()
  : "";

// Without a display or xvfb-run, Electron runs on the headless Ozone platform: the fixture opens no window.
const headless = process.platform === "linux" && !process.env.DISPLAY && !xvfb;

test("the AppImage restart waits for deferred cleanup, keeps setuid fusermount usable, and reacquires the data directory", {
  skip: process.platform !== "linux"
    ? "AppImage updates run only on Linux"
    : !process.env.DBUS_SESSION_BUS_ADDRESS && !dbusRunSession
      ? "no session bus and no dbus-run-session; single-instance lock cannot be tested"
      : false,
  timeout: 45_000,
}, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-appimage-relaunch-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const launched = join(workspace, "OpenMausBot-1.0.0.AppImage");
  const staged = join(workspace, "OpenMausBot-2.0.0.AppImage");
  const receipt = join(workspace, "restarted.json");
  const fixture = join(workspace, "main.cjs");
  mkdirSync(join(workspace, "user-data"));
  const leaseModule = new URL("./data-dir-lease.mjs", import.meta.url).href;
  const replacement = `
    const { readFileSync, writeFileSync } = require("node:fs");
    (async () => {
      // A zombie has exited, though kill(pid, 0) still answers for it.
      let parentAlive = true;
      try { parentAlive = !/^\\d+ \\(.*\\) [ZX] /.test(readFileSync("/proc/" + process.env.OMB_UPDATER_TEST_PARENT + "/stat", "utf8")); }
      catch (error) { if (error.code === "ENOENT") parentAlive = false; else throw error; }
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      const lease = acquireDataDirLease(${JSON.stringify(join(workspace, "data"))});
      lease.release();
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ parentAlive, acquired: true,
        noNewPrivs: readFileSync("/proc/self/status", "utf8").match(/NoNewPrivs:\\s*(\\d)/)?.[1],
        appImage: process.env.APPIMAGE, silent: process.env.APPIMAGE_SILENT_INSTALL }));
    })().catch(error => { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ error: error.message })); process.exitCode = 1; });
  `;
  writeFileSync(launched, "old AppImage", { mode: 0o755 });
  // A disposable executable substitutes for the AppImage payload, not for the vendored methods.
  writeFileSync(staged, `#!${process.execPath}\n${replacement}`, { mode: 0o755 });
  writeFileSync(fixture, `
    const { app, autoUpdater } = require("electron");
    const { existsSync } = require("node:fs");
    app.setPath("userData", ${JSON.stringify(join(workspace, "user-data"))});
    app.whenReady().then(async () => {
      if (!app.requestSingleInstanceLock()) throw new Error("fixture lock unavailable");
      const { acquireDataDirLease } = await import(${JSON.stringify(leaseModule)});
      const lease = acquireDataDirLease(${JSON.stringify(join(workspace, "data"))});
      process.env.APPIMAGE = ${JSON.stringify(launched)};
      process.env.OMB_UPDATER_TEST_PARENT = String(process.pid);
      autoUpdater.on("before-quit-for-update", () => app.releaseSingleInstanceLock());
      let cleaned = false;
      app.on("before-quit", event => {
        if (cleaned) return;
        event.preventDefault();
        setTimeout(() => {
          if (existsSync(${JSON.stringify(receipt)})) throw new Error("replacement started during cleanup");
          cleaned = true;
          app.quit();
        }, 250);
      });
      app.on("will-quit", () => lease.release());
      const { AppImageUpdater, BaseUpdater } = require(${JSON.stringify(join(root, "electron/vendor/electron-updater.cjs"))});
      const updater = {
        installerPath: ${JSON.stringify(staged)}, downloadedUpdateHelper: { downloadedFileInfo: {} },
        _logger: { info() {}, warn() {}, error() {} }, emit() {},
        dispatchError(error) { throw error; }, app,
        doInstall: AppImageUpdater.prototype.doInstall, install: BaseUpdater.prototype.install,
        spawnLog() { throw new Error("immediate relaunch bypassed cleanup"); }
      };
      BaseUpdater.prototype.quitAndInstall.call(updater, true, true);
    }).catch(error => { console.error(error); app.exit(1); });
  `);
  const electron = createRequire(import.meta.url)("electron");
  const args = ["--no-sandbox", ...(headless ? ["--ozone-platform=headless"] : []), fixture];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = xvfb ? [xvfb, "-a", electron, ...args] : [electron, ...args];
  const launch = process.env.DBUS_SESSION_BUS_ADDRESS || !dbusRunSession ? run : [dbusRunSession, "--", ...run];
  // The launcher leads its own process group: on headless Linux it wraps dbus-run-session, xvfb-run, Xvfb and Electron,
  // and killing only the wrapper leaves orphans holding the output pipes open.
  const child = spawn(launch[0], launch.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const killLaunch = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  };
  // Passing runs take 1 to 9.5 s on hosted Ubuntu runners.
  const timeout = setTimeout(killLaunch, 30_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, output);
  for (let attempt = 0; !existsSync(receipt) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(receipt), true, `replacement never started: ${output}`);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
    parentAlive: false, acquired: true, noNewPrivs: "0", appImage: launched, silent: "true",
  }, "with no_new_privs set, the AppImage runtime cannot mount the update");
  assert.equal(readFileSync(launched, "utf8"), `#!${process.execPath}\n${replacement}`);
});
