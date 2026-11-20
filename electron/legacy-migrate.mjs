// One-time moves from the names earlier versions used. Each move is a single rename, never a copy, so a folder is
// never half moved, and nothing moves while an earlier version's server still holds its folder.
import nodeFs from "node:fs";
import nodePath from "node:path";
import { legacyLeaseHeld } from "./data-dir-lease.mjs";
import {
  currentHomeFolder,
  LEGACY_CHILD_LEASE_FOLDER,
  LEGACY_COMPANION_FOLDER,
  LEGACY_DATA_FILES,
  LEGACY_ENGINE_HOME_ENTRIES,
  LEGACY_LEASE_FILE,
  LEGACY_MEET_FOLDER,
  MEET_FOLDER,
} from "./legacy-names.mjs";

export const LEGACY_MOVE_RECEIPT = nodePath.join(".backups", "legacy-move.json");
const DEFINITION_MARKERS = ["bots.json", "groups.json", "config.json"];

const OLD_FOLDER_IN_PATH = /(?<=[\\/])\.openmausbot(?![A-Za-z0-9_])/g;

/** Text with every path to an old home folder (`.openmausbot`, `.openmausbot-work`) pointing at the current one. */
export function rewriteLegacyHomePaths(text) {
  return text.replace(OLD_FOLDER_IN_PATH, ".seira");
}

const exists = (fs, path) => {
  try { fs.lstatSync(path); return true; } catch (error) { return error?.code !== "ENOENT" && error?.code !== "ENOTDIR"; }
};

function homeTargets(fs, home, env) {
  let names;
  try { names = fs.readdirSync(home); } catch { return []; }
  const targets = [];
  for (const name of names.sort()) {
    if (name === LEGACY_COMPANION_FOLDER && env.SEIRA_COMPANION_DIR) continue;
    const current = name === LEGACY_MEET_FOLDER ? MEET_FOLDER : currentHomeFolder(name);
    if (current) targets.push([name, current]);
  }
  return targets;
}

function isDataFolder(fs, dir) {
  try { return DEFINITION_MARKERS.some((name) => fs.existsSync(nodePath.join(dir, name))); } catch { return false; }
}

function rewriteFile(fs, file, log) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  const after = rewriteLegacyHomePaths(text);
  if (after === text) return false;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const before = `${file}.before-seira`;
    if (!exists(fs, before)) fs.copyFileSync(file, before);
    fs.writeFileSync(temporary, after, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    log(`legacy migration: could not update ${nodePath.basename(file)}: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * Moves each old folder in `home` to its current name when the current one is absent and no earlier-version server
 * holds the old one. Does nothing when SEIRA_DATA_DIR is set. `rewriteFiles`: files outside the folders (the saved
 * servers, the desktop settings) whose paths name an old folder; rewritten after a data folder moved.
 * Returns the moves made, as [from, to] folder names.
 */
export function migrateHomeFolders({ home, env = process.env, fs = nodeFs, log = () => {}, held = legacyLeaseHeld, rewriteFiles = [] }) {
  if (env.SEIRA_DATA_DIR) return [];
  const moves = [];
  let dataMoved = false;
  for (const [from, to] of homeTargets(fs, home, env)) {
    const source = nodePath.join(home, from);
    const target = nodePath.join(home, to);
    if (exists(fs, target)) {
      log(`legacy migration: ${from} and ${to} both exist; both left as they are`);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(source); } catch { continue; }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    if (held(source)) {
      log(`legacy migration: ${from} is in use by an earlier version; left as it is`);
      continue;
    }
    const receipt = stat.isDirectory() && isDataFolder(fs, source) ? nodePath.join(source, LEGACY_MOVE_RECEIPT) : null;
    try {
      if (receipt) {
        fs.mkdirSync(nodePath.dirname(receipt), { recursive: true, mode: 0o700 });
        fs.writeFileSync(receipt, JSON.stringify({ from: source, to: target, pathsRewritten: false }), { mode: 0o600 });
      }
      fs.renameSync(source, target);
    } catch (error) {
      if (receipt) try { fs.rmSync(receipt, { force: true }); } catch {}
      log(`legacy migration: could not move ${from} to ${to}: ${error?.message ?? error}`);
      continue;
    }
    moves.push([from, to]);
    if (receipt) dataMoved = true;
    log(`legacy migration: moved ${from} to ${to}`);
  }
  if (dataMoved) for (const file of rewriteFiles) rewriteFile(fs, file, log);
  return moves;
}

/**
 * Inside a data folder already at its current name: renames the old marker files and engine-home folders, and removes
 * lease files left by an earlier version that no longer runs. Does nothing when SEIRA_DATA_DIR is set.
 */
export function migrateInnerFiles({ dataDir, env = process.env, fs = nodeFs, log = () => {}, held = legacyLeaseHeld }) {
  if (env.SEIRA_DATA_DIR) return [];
  const moves = [];
  const rename = (dir, from, to) => {
    const source = nodePath.join(dir, from);
    const target = nodePath.join(dir, to);
    if (!exists(fs, source)) return;
    if (exists(fs, target)) {
      log(`legacy migration: ${from} and ${to} both exist in ${nodePath.basename(dir)}; both left as they are`);
      return;
    }
    try {
      fs.renameSync(source, target);
      moves.push([source, target]);
    } catch (error) {
      log(`legacy migration: could not move ${from} to ${to}: ${error?.message ?? error}`);
    }
  };
  if (held(dataDir)) return moves;
  for (const [from, to] of LEGACY_DATA_FILES) rename(dataDir, from, to);
  const homes = nodePath.join(dataDir, "engine-homes");
  let keys = [];
  try { keys = fs.readdirSync(homes); } catch {}
  for (const key of keys) for (const [from, to] of LEGACY_ENGINE_HOME_ENTRIES) rename(nodePath.join(homes, key), from, to);
  for (const path of [nodePath.join(dataDir, LEGACY_LEASE_FILE), nodePath.join(dataDir, LEGACY_CHILD_LEASE_FOLDER)]) {
    try { fs.rmSync(path, { recursive: true, force: true }); } catch {}
  }
  return moves;
}
