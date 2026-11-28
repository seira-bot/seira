import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDataDirLeaseWhenFree, BOOT_LEASE_RETRY_MS, BOOT_LEASE_WAIT_MS } from "./boot-lease.mjs";
import { acquireDataDirLease, DataDirLeaseError } from "./data-dir-lease.mjs";

const LEASE = Object.freeze({ ownerPid: 1 });

function busy(message = "Seira is already using this data directory (process 4321).") {
  return Object.assign(new DataDirLeaseError(message), { busy: true });
}

function harness({ freeAfterMs = Infinity, failure = busy } = {}) {
  const h = { t: 0, calls: 0, sleeps: [], lines: [] };
  h.deps = {
    acquire: (dataDir, options) => {
      h.calls += 1;
      h.lastArgs = [dataDir, options];
      if (h.t >= freeAfterMs) return LEASE;
      throw failure();
    },
    describe: () => ({ state: "alive", pid: 4321 }),
    now: () => h.t,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.t += ms;
    },
    log: (line) => h.lines.push(line),
  };
  return h;
}

test("a free folder is acquired at once without waiting or logging", async () => {
  const h = harness({ freeAfterMs: 0 });
  const lease = await acquireDataDirLeaseWhenFree("/data", { legacyDataDir: "/old" }, h.deps);
  assert.equal(lease, LEASE);
  assert.deepEqual(h.lastArgs, ["/data", { legacyDataDir: "/old" }]);
  assert.deepEqual([h.calls, h.sleeps, h.lines], [1, [], []]);
});

test("a folder held by a quitting instance is acquired once that instance lets go", async () => {
  const h = harness({ freeAfterMs: 12_000 });
  const lease = await acquireDataDirLeaseWhenFree("/data", {}, h.deps);
  assert.equal(lease, LEASE);
  assert.ok(h.sleeps.every((ms) => ms === BOOT_LEASE_RETRY_MS));
  assert.equal(h.t, 12_000);
  assert.deepEqual(h.lines, [
    `data folder held by process 4321 (lease alive); waiting up to ${BOOT_LEASE_WAIT_MS / 1000}s`,
    "data folder lease acquired after waiting 12s",
  ]);
});

test("a folder that stays held throws the lease error after the wait", async () => {
  assert.equal(BOOT_LEASE_WAIT_MS, 90_000);
  const h = harness();
  await assert.rejects(
    acquireDataDirLeaseWhenFree("/data", {}, h.deps),
    (error) => error instanceof DataDirLeaseError && /already using this data directory \(process 4321\)/.test(error.message),
  );
  assert.equal(h.t, BOOT_LEASE_WAIT_MS);
  assert.deepEqual(h.lines, [
    "data folder held by process 4321 (lease alive); waiting up to 90s",
    "data folder still held by process 4321 (lease alive) after 90s; giving up",
  ]);
});

test("a lease error that waiting cannot fix is thrown at once", async () => {
  const h = harness({
    failure: () => new DataDirLeaseError("This Seira data directory is already owned by a process on another machine."),
  });
  await assert.rejects(acquireDataDirLeaseWhenFree("/data", {}, h.deps), /another machine/);
  assert.deepEqual([h.calls, h.sleeps, h.lines], [1, [], []]);
});

test("any other error is thrown at once", async () => {
  const h = harness({ failure: () => new Error("EACCES") });
  await assert.rejects(acquireDataDirLeaseWhenFree("/data", {}, h.deps), /EACCES/);
  assert.equal(h.calls, 1);
});

test("a holder that cannot be described still gets a log line", async () => {
  const h = harness({ freeAfterMs: 1_000 });
  h.deps.describe = () => {
    throw new Error("unreadable");
  };
  await acquireDataDirLeaseWhenFree("/data", {}, h.deps);
  assert.equal(h.lines[0], "data folder held by unknown holder (unreadable); waiting up to 90s");
});

test("a real lease held by a live owner is busy, and is acquired once that owner releases it", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "seira-boot-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const first = acquireDataDirLease(dataDir);
  assert.throws(
    () => acquireDataDirLease(dataDir),
    (error) => error instanceof DataDirLeaseError && error.busy === true && /already using this data directory/i.test(error.message),
  );

  const lines = [];
  const second = await acquireDataDirLeaseWhenFree(dataDir, {}, {
    sleep: async () => {
      first.release();
    },
    log: (line) => lines.push(line),
  });
  assert.equal(second.ownerPid, process.pid);
  assert.match(lines[0], new RegExp(`^data folder held by process ${process.pid} \\(lease alive\\)`));
  assert.equal(second.release(), true);
});
