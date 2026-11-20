// The first start under the current app name copies the earlier settings folder once, and never changes the earlier one.
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";
import { SETTINGS_MOVE_RECEIPT, chooseSettingsFolder, instanceHolds } from "./settings-folder.mjs";

const NAME = "Seira";
function appData(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "seira-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function earlierFolder(base) {
  const legacy = path.join(base, LEGACY_APP_NAME);
  mkdirSync(path.join(legacy, "Local Storage", "leveldb"), { recursive: true });
  writeFileSync(path.join(legacy, "credentials.bin"), "v11secret", { mode: 0o600 });
  writeFileSync(path.join(legacy, "desktop-prefs.json"), '{"theme":"dark"}');
  writeFileSync(path.join(legacy, "Local Storage", "leveldb", "000003.log"), "storage");
  mkdirSync(path.join(legacy, "Cache", "Cache_Data"), { recursive: true });
  writeFileSync(path.join(legacy, "Cache", "Cache_Data", "data_0"), "cache");
  mkdirSync(path.join(legacy, "GPUCache"));
  return legacy;
}
/** Every path under a folder with its content or link target, to prove a folder did not change. */
function snapshot(folder) {
  const out = {};
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const key = path.relative(folder, file);
      if (entry.isSymbolicLink()) out[key] = `-> ${fs.readlinkSync(file)}`;
      else if (entry.isDirectory()) { out[key] = "dir"; walk(file); }
      else out[key] = `${readFileSync(file, "utf8")} ${(statSync(file).mode & 0o777).toString(8)}`;
    }
  };
  walk(folder);
  return out;
}
const free = () => false;
const choose = (base, options = {}) => chooseSettingsFolder({ appData: base, name: NAME, holds: free, alive: () => false, sleep: () => {}, ...options });

test("a new person gets the current name and no copy", t => {
  const base = appData(t);
  assert.deepEqual(choose(base), { name: NAME, copied: false });
  assert.deepEqual(readdirSync(base), []);
});

test("an earlier folder is copied once to the current name, without caches or locks, and stays as it was", t => {
  const base = appData(t);
  const legacy = earlierFolder(base);
  symlinkSync(`${hostname()}-999999`, path.join(legacy, "SingletonLock"));
  const before = snapshot(legacy);
  const logs = [];

  assert.deepEqual(choose(base, { now: () => new Date("2026-11-20T00:00:00Z"), log: line => logs.push(line) }), { name: NAME, copied: true });

  const current = path.join(base, NAME);
  assert.deepEqual(snapshot(legacy), before, "the earlier folder is unchanged");
  assert.equal(readFileSync(path.join(current, "credentials.bin"), "utf8"), "v11secret");
  assert.equal(statSync(path.join(current, "credentials.bin")).mode & 0o777, 0o600);
  assert.equal(readFileSync(path.join(current, "Local Storage", "leveldb", "000003.log"), "utf8"), "storage");
  assert.equal(readFileSync(path.join(current, "desktop-prefs.json"), "utf8"), '{"theme":"dark"}');
  for (const skipped of ["Cache", "GPUCache", "SingletonLock"]) assert.ok(!existsSync(path.join(current, skipped)), skipped);
  assert.deepEqual(JSON.parse(readFileSync(path.join(current, SETTINGS_MOVE_RECEIPT), "utf8")), { copiedAt: "2026-11-20T00:00:00.000Z", keys: "pending", attempts: 0 });
  assert.deepEqual(readdirSync(base).sort(), [NAME, LEGACY_APP_NAME].sort(), "no copy folder is left");
  assert.equal(logs.length, 1);

  writeFileSync(path.join(current, "desktop-prefs.json"), '{"theme":"light"}');
  assert.deepEqual(choose(base), { name: NAME, copied: false }, "a later start copies nothing");
  assert.equal(readFileSync(path.join(current, "desktop-prefs.json"), "utf8"), '{"theme":"light"}');
});

test("when both folders exist, the current one is used as it is and nothing is copied into it", t => {
  const base = appData(t);
  const legacy = earlierFolder(base);
  const current = path.join(base, NAME);
  mkdirSync(current);
  writeFileSync(path.join(current, "notes.txt"), "a person's own file");
  const before = { legacy: snapshot(legacy), current: snapshot(current) };

  assert.deepEqual(choose(base), { name: NAME, copied: false });
  assert.deepEqual({ legacy: snapshot(legacy), current: snapshot(current) }, before);
});

test("while an earlier version still runs, this run keeps the earlier name and a later start copies", t => {
  const base = appData(t);
  earlierFolder(base);
  let running = true;
  let slept = 0;
  const logs = [];
  const options = { holds: () => running, sleep: () => { slept += 1; }, waitMs: 300, log: line => logs.push(line) };

  assert.deepEqual(choose(base, options), { name: LEGACY_APP_NAME, copied: false, reason: "running" });
  assert.equal(slept, 3, "it waits a short time for an earlier version that is closing");
  assert.ok(!existsSync(path.join(base, NAME)));
  assert.match(logs[0], /still runs/);

  running = false;
  assert.equal(choose(base, options).copied, true);
});

test("an earlier version that closes while the new one waits is copied in the same start", t => {
  const base = appData(t);
  earlierFolder(base);
  let checks = 0;
  assert.equal(choose(base, { holds: () => ++checks < 3, waitMs: 3_000 }).copied, true);
});

test("a failed copy leaves no partial folder and keeps the earlier name for this run", t => {
  const base = appData(t);
  const legacy = earlierFolder(base);
  const before = snapshot(legacy);
  const failing = {
    ...fs,
    cpSync(source, target) {
      mkdirSync(target);
      writeFileSync(path.join(target, "half.json"), "{}");
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    },
  };
  const logs = [];
  assert.deepEqual(choose(base, { fsApi: failing, log: line => logs.push(line) }), { name: LEGACY_APP_NAME, copied: false, reason: "copy-failed" });
  assert.deepEqual(readdirSync(base), [LEGACY_APP_NAME]);
  assert.deepEqual(snapshot(legacy), before);
  assert.match(logs[0], /ENOSPC/);
});

test("when another start finishes the copy first, this start uses that copy and removes its own", t => {
  const base = appData(t);
  earlierFolder(base);
  const racing = {
    ...fs,
    renameSync(from, to) {
      mkdirSync(to);
      writeFileSync(path.join(to, "other.json"), "{}");
      fs.renameSync(from, to);
    },
  };
  assert.deepEqual(choose(base, { fsApi: racing }), { name: NAME, copied: false });
  assert.deepEqual(readdirSync(path.join(base, NAME)), ["other.json"]);
  assert.deepEqual(readdirSync(base).sort(), [NAME, LEGACY_APP_NAME].sort());
});

test("a copy folder that a closed start left behind is removed, and one of a running start is kept", t => {
  const base = appData(t);
  earlierFolder(base);
  mkdirSync(path.join(base, `${NAME}.copying-111`));
  mkdirSync(path.join(base, `${NAME}.copying-222`));
  mkdirSync(path.join(base, "SeiraOther"));
  choose(base, { alive: pid => pid === 222 });
  assert.deepEqual(readdirSync(base).sort(), [NAME, `${NAME}.copying-222`, LEGACY_APP_NAME, "SeiraOther"].sort());
});

test("a folder that cannot be checked counts as there, so nothing is copied over it", t => {
  const base = appData(t);
  earlierFolder(base);
  const denied = { ...fs, lstatSync(file, ...rest) {
    if (file === path.join(base, NAME)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.lstatSync(file, ...rest);
  } };
  assert.deepEqual(choose(base, { fsApi: denied }), { name: NAME, copied: false });
  assert.ok(!existsSync(path.join(base, NAME)));
});

test("Chromium's lock link says whether a running app holds the folder", t => {
  const base = appData(t);
  const folder = path.join(base, "f");
  mkdirSync(folder);
  const holds = (options = {}) => instanceHolds(folder, { platform: "linux", host: "box", ...options });
  assert.equal(holds(), false, "no lock");
  symlinkSync("box-4242", path.join(folder, "SingletonLock"));
  assert.equal(holds({ alive: pid => pid === 4242 }), true, "same host, live pid");
  assert.equal(holds({ alive: () => false }), false, "same host, closed pid");
  assert.equal(holds({ host: "other", alive: () => false }), true, "another host shares this home");
  rmSync(path.join(folder, "SingletonLock"));
  symlinkSync("garbage", path.join(folder, "SingletonLock"));
  assert.equal(holds({ alive: () => false }), true, "a lock it cannot read counts as held");
});

test("on Windows, a lockfile that cannot be opened for writing means a running app", t => {
  const base = appData(t);
  const folder = path.join(base, "f");
  mkdirSync(folder);
  const win = fsApi => instanceHolds(folder, { platform: "win32", fsApi });
  assert.equal(win(fs), false, "no lockfile");
  writeFileSync(path.join(folder, "lockfile"), "");
  assert.equal(win(fs), false, "a lockfile that opens is left from a closed app");
  const busy = { ...fs, openSync() { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
  assert.equal(win(busy), true);
});

test("a folder with a mode stays private in the copy", t => {
  const base = appData(t);
  const legacy = earlierFolder(base);
  chmodSync(legacy, 0o700);
  choose(base);
  assert.equal(statSync(path.join(base, NAME)).mode & 0o777, 0o700);
});
