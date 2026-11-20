// Electron names the settings folder after the app name. An earlier version used another app name, so the first start
// under the current name copies that folder once. The earlier folder is never changed, moved or deleted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";

/** Written into the copy: the stored secrets in it still need the earlier name's key. */
export const SETTINGS_MOVE_RECEIPT = "settings-move.json";
const COPYING = ".copying-";
// Chromium rebuilds its caches. The lock files belong to the process that made them.
const NOT_COPIED = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
  "GraphiteDawnCache", "ShaderCache", "Crashpad", "blob_storage", "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]);

let chosen = null;
/** What the start chose, for the log. */
export const settingsFolderChoice = () => chosen;

function present(fsApi, file) {
  try {
    fsApi.lstatSync(file);
    return true;
  } catch (error) {
    // A folder that cannot be checked counts as there, so nothing is copied over it.
    return !(error?.code === "ENOENT" || error?.code === "ENOTDIR");
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True while a running app holds this settings folder. Chromium keeps a `SingletonLock` link to "host-pid" on Linux
 * and macOS, and on Windows holds `lockfile` open without write sharing and deletes it on close.
 */
export function instanceHolds(folder, { platform = process.platform, fsApi = fs, host = os.hostname(), alive = processAlive } = {}) {
  if (platform === "win32") {
    let fd;
    try {
      fd = fsApi.openSync(path.join(folder, "lockfile"), "r+");
    } catch (error) {
      return error?.code !== "ENOENT";
    }
    fsApi.closeSync(fd);
    return false;
  }
  let owner;
  try {
    owner = fsApi.readlinkSync(path.join(folder, "SingletonLock"));
  } catch (error) {
    return error?.code !== "ENOENT";
  }
  const at = owner.lastIndexOf("-");
  const pid = Number(owner.slice(at + 1));
  if (at <= 0 || !Number.isSafeInteger(pid) || pid <= 0) return true;
  // Chromium also gives up on a lock from another host: a shared home folder.
  return owner.slice(0, at) !== host || alive(pid);
}

function removeAbandonedCopies(appData, name, fsApi, alive) {
  let entries = [];
  try {
    entries = fsApi.readdirSync(appData);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}${COPYING}`)) continue;
    const pid = Number(entry.slice(name.length + COPYING.length));
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) continue;
    fsApi.rmSync(path.join(appData, entry), { recursive: true, force: true });
  }
}

/**
 * Picks the app name for this run before anything reads the settings folder. It returns the current name, except while
 * the earlier folder cannot be copied yet; then this run keeps the earlier name and its folder, and a later start copies.
 */
export function chooseSettingsFolder({ appData, name, fsApi = fs, holds = folder => instanceHolds(folder, { fsApi }), alive = processAlive,
  sleep = sleepSync, waitMs = 3_000, now = () => new Date(), log = () => {} }) {
  const decide = choice => (chosen = choice);
  const current = path.join(appData, name);
  const legacy = path.join(appData, LEGACY_APP_NAME);
  if (name === LEGACY_APP_NAME || present(fsApi, current) || !present(fsApi, legacy)) return decide({ name, copied: false });

  // An update can start the new version while the earlier one still closes.
  for (let waited = 0; holds(legacy); waited += 100) {
    if (waited >= waitMs) {
      log("settings folder: an earlier version still runs; this run keeps its folder, a later start copies it");
      return decide({ name: LEGACY_APP_NAME, copied: false, reason: "running" });
    }
    sleep(100);
  }

  removeAbandonedCopies(appData, name, fsApi, alive);
  const copying = `${current}${COPYING}${process.pid}`;
  try {
    fsApi.cpSync(legacy, copying, {
      recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true,
      filter: source => {
        if (path.dirname(source) === legacy && NOT_COPIED.has(path.basename(source))) return false;
        const stat = fsApi.lstatSync(source);
        return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
      },
    });
    fsApi.writeFileSync(path.join(copying, SETTINGS_MOVE_RECEIPT), `${JSON.stringify({ copiedAt: now().toISOString(), keys: "pending", attempts: 0 })}\n`, { mode: 0o600 });
    // One rename, so the current folder is either absent or complete.
    fsApi.renameSync(copying, current);
  } catch (error) {
    fsApi.rmSync(copying, { recursive: true, force: true });
    if (present(fsApi, current)) return decide({ name, copied: false });
    log(`settings folder: copy failed (${error?.code ?? error?.message}); this run keeps the earlier folder`);
    return decide({ name: LEGACY_APP_NAME, copied: false, reason: "copy-failed" });
  }
  log("settings folder: copied the earlier folder once; the earlier folder stays as it was");
  return decide({ name, copied: true });
}
