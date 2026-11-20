// Moving an earlier version's folders to the current names once, without ever losing or doubling a person's data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { legacyLeaseHeld } from "./data-dir-lease.mjs";
import { migrateHomeFolders, migrateInnerFiles, rewriteLegacyHomePaths } from "./legacy-migrate.mjs";

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "seira-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function folder(base, name, content = "old") {
  mkdirSync(path.join(base, name), { recursive: true });
  writeFileSync(path.join(base, name, "bots.json"), content);
}
const never = () => false;

test("an old folder only is moved to the current name", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  folder(base, ".openmausbot-work");
  mkdirSync(path.join(base, ".openmausbot-companion"));
  mkdirSync(path.join(base, ".mausbot-meet"));
  const moves = migrateHomeFolders({ home: base, env: {}, held: never });
  assert.equal(moves.length, 4);
  assert.equal(readFileSync(path.join(base, ".seira", "bots.json"), "utf8"), "old");
  for (const name of [".seira-work", ".seira-companion", ".seira-meet"]) assert.ok(existsSync(path.join(base, name)), name);
  for (const name of [".openmausbot", ".openmausbot-work", ".openmausbot-companion", ".mausbot-meet"]) assert.ok(!existsSync(path.join(base, name)), name);
});

test("the current folder only is left untouched", (t) => {
  const base = home(t);
  folder(base, ".seira", "new");
  assert.deepEqual(migrateHomeFolders({ home: base, env: {}, held: never }), []);
  assert.equal(readFileSync(path.join(base, ".seira", "bots.json"), "utf8"), "new");
});

test("both folders are left untouched and the skip is logged", (t) => {
  const base = home(t);
  folder(base, ".openmausbot", "old");
  folder(base, ".seira", "new");
  const lines = [];
  assert.deepEqual(migrateHomeFolders({ home: base, env: {}, held: never, log: (line) => lines.push(line) }), []);
  assert.equal(readFileSync(path.join(base, ".seira", "bots.json"), "utf8"), "new");
  assert.equal(readFileSync(path.join(base, ".openmausbot", "bots.json"), "utf8"), "old");
  assert.equal(lines.length, 1);
});

test("nothing moves while SEIRA_DATA_DIR is set", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  assert.deepEqual(migrateHomeFolders({ home: base, env: { SEIRA_DATA_DIR: path.join(base, "elsewhere") }, held: never }), []);
  assert.ok(existsSync(path.join(base, ".openmausbot")));
  assert.ok(!existsSync(path.join(base, ".seira")));
});

test("the companion folder stays while its override is set", (t) => {
  const base = home(t);
  mkdirSync(path.join(base, ".openmausbot-companion"));
  assert.deepEqual(migrateHomeFolders({ home: base, env: { SEIRA_COMPANION_DIR: "/x" }, held: never }), []);
  assert.ok(existsSync(path.join(base, ".openmausbot-companion")));
});

test("a folder an earlier version still holds is left untouched", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  const lines = [];
  assert.deepEqual(migrateHomeFolders({ home: base, env: {}, held: () => true, log: (line) => lines.push(line) }), []);
  assert.ok(existsSync(path.join(base, ".openmausbot")));
  assert.equal(lines.length, 1);
});

test("a lease of a live earlier-version process holds the folder", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  const record = { version: 1, pid: process.pid, host: hostname(), token: randomUUID(), createdAt: Date.now() };
  writeFileSync(path.join(base, ".openmausbot", "openmausbot-server.lease"), JSON.stringify(record));
  assert.equal(legacyLeaseHeld(path.join(base, ".openmausbot")), true);
  assert.deepEqual(migrateHomeFolders({ home: base, env: {} }), []);
  assert.ok(existsSync(path.join(base, ".openmausbot")));
});

test("a lease of a process that is gone does not hold the folder", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  const record = { version: 1, pid: 2 ** 22 + 12345, host: hostname(), token: randomUUID(), createdAt: Date.now() };
  writeFileSync(path.join(base, ".openmausbot", "openmausbot-server.lease"), JSON.stringify(record));
  assert.equal(legacyLeaseHeld(path.join(base, ".openmausbot")), false);
  assert.equal(migrateHomeFolders({ home: base, env: {} }).length, 1);
  migrateInnerFiles({ dataDir: path.join(base, ".seira"), env: {} });
  assert.ok(!existsSync(path.join(base, ".seira", "openmausbot-server.lease")));
});

test("a second run changes nothing", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  assert.equal(migrateHomeFolders({ home: base, env: {}, held: never }).length, 1);
  assert.deepEqual(migrateHomeFolders({ home: base, env: {}, held: never }), []);
});

test("paths in the saved servers follow the move, once, keeping a copy", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  const file = path.join(base, "environments.json");
  writeFileSync(file, JSON.stringify({ dataDir: `${base}/.openmausbot-work`, other: `${base}/.openmausbotx` }));
  migrateHomeFolders({ home: base, env: {}, held: never, rewriteFiles: [file] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { dataDir: `${base}/.seira-work`, other: `${base}/.openmausbotx` });
  assert.ok(existsSync(`${file}.before-seira`));
});

test("the receipt travels with the moved folder", (t) => {
  const base = home(t);
  folder(base, ".openmausbot");
  migrateHomeFolders({ home: base, env: {}, held: never });
  const receipt = JSON.parse(readFileSync(path.join(base, ".seira", ".backups", "legacy-move.json"), "utf8"));
  assert.equal(receipt.pathsRewritten, false);
});

test("old marker files and engine-home folders are renamed, current ones kept", (t) => {
  const base = home(t);
  const dir = path.join(base, ".seira");
  mkdirSync(path.join(dir, "engine-homes", "a", ".omb-folders"), { recursive: true });
  mkdirSync(path.join(dir, "engine-homes", "b", ".omb-folders"), { recursive: true });
  mkdirSync(path.join(dir, "engine-homes", "b", ".seira-folders"), { recursive: true });
  writeFileSync(path.join(dir, ".omb-cloud-home.json"), "{}");
  migrateInnerFiles({ dataDir: dir, env: {}, held: never });
  assert.ok(existsSync(path.join(dir, ".seira-cloud-home.json")));
  assert.ok(existsSync(path.join(dir, "engine-homes", "a", ".seira-folders")));
  assert.ok(existsSync(path.join(dir, "engine-homes", "b", ".omb-folders")));
  assert.deepEqual(migrateInnerFiles({ dataDir: dir, env: {}, held: never }).length, 0);
});

test("inner files stay while SEIRA_DATA_DIR is set", (t) => {
  const base = home(t);
  writeFileSync(path.join(base, ".omb-cloud-home.json"), "{}");
  assert.deepEqual(migrateInnerFiles({ dataDir: base, env: { SEIRA_DATA_DIR: base }, held: never }), []);
  assert.ok(existsSync(path.join(base, ".omb-cloud-home.json")));
});

test("rewriting leaves other names alone", () => {
  assert.equal(rewriteLegacyHomePaths("C:\\Users\\a\\.openmausbot\\x /a/.openmausbot-b/c .openmausbot /a/.openmausbotx"),
    "C:\\Users\\a\\.seira\\x /a/.seira-b/c .openmausbot /a/.openmausbotx");
});
