import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCrashQueue } from "./crash-report-queue.mjs";

const idOf = (n) => n.toString(16).padStart(32, "0");
function folder(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "crash-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return join(root, "crash-reports");
}

test("each report is one owner-only file, listed oldest first", (t) => {
  let clock = 1_000;
  const dir = folder(t);
  const queue = createCrashQueue({ dir, now: () => clock });
  for (let n = 1; n <= 3; n++) { clock += 10; assert.equal(queue.add(idOf(n), "renderer-error", `body ${n}`), true); }
  const entries = queue.list();
  assert.deepEqual(entries.map((entry) => entry.id), [idOf(1), idOf(2), idOf(3)]);
  assert.equal(entries[0].kind, "renderer-error");
  assert.equal(queue.read(entries[1]), "body 2");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(join(dir, entries[0].name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o077, 0, "the folder is private too");
  }
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temporary file stays");
});

test("AC-23: at most 30 reports, the oldest deleted first", (t) => {
  let clock = 1_000;
  const queue = createCrashQueue({ dir: folder(t), now: () => (clock += 1) });
  for (let n = 1; n <= 35; n++) queue.add(idOf(n), "native", "x");
  const ids = queue.list().map((entry) => entry.id);
  assert.equal(ids.length, 30);
  assert.equal(ids[0], idOf(6));
  assert.equal(ids.at(-1), idOf(35));
});

test("AC-23: at most 10 MB, the oldest deleted first, and one report over the limit is refused", (t) => {
  let clock = 1_000;
  const queue = createCrashQueue({ dir: folder(t), now: () => (clock += 1), maxBytes: 100 });
  for (let n = 1; n <= 5; n++) queue.add(idOf(n), "native", "x".repeat(30));
  assert.deepEqual(queue.list().map((entry) => entry.id), [idOf(3), idOf(4), idOf(5)]);
  assert.equal(queue.add(idOf(9), "native", "x".repeat(101)), false);
  assert.equal(queue.list().length, 3, "a refused report deletes nothing");
  const real = createCrashQueue({ dir: folder(t) });
  assert.equal(real.add(idOf(1), "native", "x".repeat(10 * 1024 * 1024 + 1)), false);
});

test("a bad id or kind is refused and writes nothing", (t) => {
  const dir = folder(t);
  const queue = createCrashQueue({ dir });
  for (const [id, kind, body] of [["../x", "native", "b"], [idOf(1), "../x", "b"], [idOf(1), "Native", "b"], [idOf(1), "native", 5]]) assert.equal(queue.add(id, kind, body), false);
  assert.deepEqual(queue.list(), []);
});

test("AC-08: clear deletes every waiting report and keeps state and marker", (t) => {
  const queue = createCrashQueue({ dir: folder(t) });
  queue.add(idOf(1), "native", "x");
  queue.add(idOf(2), "hang", "x");
  queue.saveState({ retryAfterUntil: 5, sent: [] });
  queue.writeJson("session.json", { startedAt: 1 });
  queue.clear();
  assert.deepEqual(queue.list(), []);
  assert.equal(queue.state().retryAfterUntil, 5);
  assert.deepEqual(queue.readJson("session.json"), { startedAt: 1 });
});

test("state survives a restart, drops malformed entries and forgets sends older than 7 days", (t) => {
  const dir = folder(t);
  let clock = 10 * 24 * 60 * 60_000;
  const queue = createCrashQueue({ dir, now: () => clock });
  const old = clock - 8 * 24 * 60 * 60_000, recent = clock - 1000;
  queue.saveState({ retryAfterUntil: clock + 5000, sent: [{ at: old, id: idOf(1) }, { at: recent, id: idOf(2) }] });
  const again = createCrashQueue({ dir, now: () => clock });
  assert.deepEqual(again.state(), { retryAfterUntil: clock + 5000, sent: [{ at: recent, id: idOf(2) }] });
  fs.writeFileSync(join(dir, "state.json"), JSON.stringify({ retryAfterUntil: "soon", sent: [{ at: 1, id: "../x" }, { at: "x", id: idOf(3) }, null, { at: 5, id: idOf(4), extra: "canary" }] }));
  assert.deepEqual(again.state(), { retryAfterUntil: 0, sent: [{ at: 5, id: idOf(4) }] });
  fs.writeFileSync(join(dir, "state.json"), "not json");
  assert.deepEqual(again.state(), { retryAfterUntil: 0, sent: [] });
});

test("AC-24: a disk that fails never throws to the caller", (t) => {
  const dir = folder(t);
  const failing = new Proxy(fs, { get: (target, key) => (["writeFileSync", "mkdirSync", "renameSync", "readdirSync", "readFileSync", "statSync"].includes(key) ? () => { throw new Error("disk full"); } : target[key]) });
  const queue = createCrashQueue({ dir, fs: failing });
  assert.equal(queue.add(idOf(1), "native", "x"), false);
  assert.deepEqual(queue.list(), []);
  assert.equal(queue.read({ name: "x" }), null);
  assert.equal(queue.writeJson("state.json", {}), false);
  assert.equal(queue.readJson("state.json"), null);
  assert.equal(queue.saveState({ retryAfterUntil: 0, sent: [] }), false);
  assert.doesNotThrow(() => queue.clear());
  assert.deepEqual(queue.state(), { retryAfterUntil: 0, sent: [] });
});

test("AC-24: a write that fails halfway leaves no partial report", (t) => {
  const dir = folder(t);
  const flaky = new Proxy(fs, { get: (target, key) => (key === "renameSync" ? () => { throw new Error("rename failed"); } : target[key]) });
  const queue = createCrashQueue({ dir, fs: flaky });
  assert.equal(queue.add(idOf(1), "native", "x"), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
