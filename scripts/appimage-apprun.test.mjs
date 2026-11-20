import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// app-builder-lib is a dependency of electron-builder, not of this project, so resolve it from there.
const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json"));
const { generateAppRunScript } = fromBuilder("app-builder-lib/out/targets/appimage/appImageUtil.js");

const SANDBOX_OFF = /--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox/;
const appRun = generateAppRunScript({
  DesktopFileName: "seira.desktop",
  ExecutableName: "seira",
  ProductName: "Seira",
  ProductFilename: "Seira",
  ResourceName: "appimagekit-seira",
});

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 });
}

/** Runs AppRun in a fake AppDir whose Electron binary records its arguments, with `unshare` exiting `probeStatus`. */
function launch(probeStatus, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seira-apprun-"));
  dirs.push(root);
  const appDir = path.join(root, "AppDir");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(appDir);
  fs.mkdirSync(fakeBin);
  const record = path.join(root, "electron-args");
  writeExecutable(path.join(appDir, "AppRun"), appRun);
  writeExecutable(
    path.join(appDir, "seira"),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(record)}\n`,
  );
  writeExecutable(path.join(fakeBin, "unshare"), `#!/bin/sh\nexit ${probeStatus}\n`);
  const result = spawnSync("bash", [path.join(appDir, "AppRun"), ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: root,
      APPDIR: appDir,
      APPIMAGE: path.join(root, "Seira.AppImage"),
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
    },
  });
  const started = fs.existsSync(record);
  return { ...result, started, electronArgs: started ? fs.readFileSync(record, "utf8").split("\n").slice(0, -1) : [] };
}

describe("AppImage AppRun", () => {
  it("never puts a sandbox-off switch on the Electron command line", () => {
    const assignments = appRun.split("\n").filter((line) => /NO_SANDBOX=|exec "\$BIN"/.test(line));
    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) expect(line).not.toMatch(SANDBOX_OFF);
  });

  it("starts Electron with the arguments unchanged when user namespaces work", () => {
    const run = launch(0, ["--first", "two words", "seira://install?x=1"]);
    expect(run.status).toBe(0);
    expect(run.started).toBe(true);
    expect(run.electronArgs).toEqual(["--first", "two words", "seira://install?x=1"]);
  });

  it("does not start Electron and names the Ubuntu package when user namespaces are blocked", () => {
    const run = launch(1, ["--first"]);
    expect(run.status).not.toBe(0);
    expect(run.started).toBe(false);
    expect(run.stderr).toContain("Seira can't open from this AppImage on this computer.");
    expect(run.stderr).toContain("sudo apt install ./Seira-amd64.deb");
    expect(run.stderr).not.toMatch(SANDBOX_OFF);
  });
});
