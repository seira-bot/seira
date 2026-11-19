import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const relaunchModule = join(here, "relaunch-after-exit.cjs");

test("outside an AppImage the desktop restarts through Electron with the given arguments", () => {
  const { relaunchAfterExit } = createRequire(import.meta.url)(relaunchModule);
  const calls = [];
  relaunchAfterExit({ relaunch: (options) => calls.push(options) }, ["--flag", "openmausbot://x"], {
    env: {},
    onError: (error) => assert.fail(error),
  });
  assert.deepEqual(calls, [{ args: ["--flag", "openmausbot://x"] }]);
});

test("the desktop never calls Electron's relauncher directly", () => {
  // Electron's relauncher sets no_new_privs, so an AppImage cannot mount itself again.
  assert.doesNotMatch(readFileSync(join(here, "main.mjs"), "utf8"), /app\.relaunch\(/);
});

const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout?.trim()
  : "";

// Without a display or xvfb-run, Electron runs on the headless Ozone platform: the fixture opens no window.
const headless = process.platform === "linux" && !process.env.DISPLAY && !xvfb;

test("an AppImage desktop restarts its AppImage after exit, with its arguments and setuid fusermount usable", {
  skip: process.platform !== "linux" && "AppImages run only on Linux",
  timeout: 45_000,
}, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-desktop-relaunch-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const launched = join(workspace, "Seira-1.0.0.AppImage");
  const receipt = join(workspace, "restarted.json");
  const expected = join(workspace, "expected-args.json");
  const started = join(workspace, "started");
  const electronReran = join(workspace, "electron-reran");
  const failure = join(workspace, "relaunch-error.txt");
  const fixture = join(workspace, "main.cjs");
  mkdirSync(join(workspace, "user-data"));
  // A disposable executable substitutes for the AppImage.
  writeFileSync(launched, `#!${process.execPath}
    const { readFileSync, writeFileSync } = require("node:fs");
    // A zombie has exited, though kill(pid, 0) still answers for it.
    let parentAlive = true;
    try { parentAlive = !/^\\d+ \\(.*\\) [ZX] /.test(readFileSync("/proc/" + process.env.OMB_RELAUNCH_TEST_PARENT + "/stat", "utf8")); }
    catch (error) { if (error.code === "ENOENT") parentAlive = false; else throw error; }
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ parentAlive, args: process.argv.slice(2),
      noNewPrivs: readFileSync("/proc/self/status", "utf8").match(/NoNewPrivs:\\s*(\\d)/)?.[1] }));
  `, { mode: 0o755 });
  writeFileSync(fixture, `
    const { app } = require("electron");
    const { existsSync, writeFileSync } = require("node:fs");
    if (existsSync(${JSON.stringify(started)})) {
      writeFileSync(${JSON.stringify(electronReran)}, "");
      app.exit(0);
    } else {
      writeFileSync(${JSON.stringify(started)}, "");
      app.setPath("userData", ${JSON.stringify(join(workspace, "user-data"))});
      app.whenReady().then(() => {
        process.env.APPIMAGE = ${JSON.stringify(launched)};
        process.env.OMB_RELAUNCH_TEST_PARENT = String(process.pid);
        let cleaned = false;
        app.on("before-quit", event => {
          if (cleaned) return;
          event.preventDefault();
          setTimeout(() => {
            if (existsSync(${JSON.stringify(receipt)})) throw new Error("the AppImage started during cleanup");
            cleaned = true;
            app.quit();
          }, 250);
        });
        const args = process.argv.slice(1);
        writeFileSync(${JSON.stringify(expected)}, JSON.stringify(args));
        const { relaunchAfterExit } = require(${JSON.stringify(relaunchModule)});
        relaunchAfterExit(app, args, { onError: error => writeFileSync(${JSON.stringify(failure)}, String(error.stack || error)) });
        app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    }
  `);
  const electron = createRequire(import.meta.url)("electron");
  const args = ["--no-sandbox", ...(headless ? ["--ozone-platform=headless"] : []), fixture, "an argument with spaces"];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = xvfb ? [xvfb, "-a", electron, ...args] : [electron, ...args];
  // The launcher leads its own process group, so a timeout also stops xvfb-run's Xvfb and Electron.
  const child = spawn(launch[0], launch.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 30_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(code, 0, output);
  for (let attempt = 0; !existsSync(receipt) && !existsSync(electronReran) && attempt < 200; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  assert.equal(existsSync(failure) ? readFileSync(failure, "utf8") : "", "");
  assert.equal(existsSync(electronReran), false, "Electron restarted its own binary instead of the AppImage");
  assert.equal(existsSync(receipt), true, `the AppImage never started: ${output}`);
  assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
    parentAlive: false, args: JSON.parse(readFileSync(expected, "utf8")), noNewPrivs: "0",
  }, "with no_new_privs set, the AppImage runtime cannot mount the image again");
  assert.ok(JSON.parse(readFileSync(expected, "utf8")).includes("an argument with spaces"));
});

test("in a snap the desktop restarts through the snap's command, never Electron's relauncher", () => {
  const { relaunchAfterExit } = createRequire(import.meta.url)(relaunchModule);
  const calls = [];
  const errors = [];
  const empty = mkdtempSync(join(tmpdir(), "omb-snap-path-"));
  try {
    // With nothing in PATH the waiting shell cannot start: the failure goes to onError, so the path taken was the snap's.
    relaunchAfterExit({ relaunch: (options) => calls.push(options) }, ["--flag"], {
      env: { SNAP: "/snap/seira/17", SNAP_NAME: "seira", PATH: empty },
      onError: (error) => errors.push(error),
    });
    assert.deepEqual(calls, []);
    assert.equal(errors.length > 0, true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
