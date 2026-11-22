import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import test from "node:test";
import { promisify } from "node:util";

import { parseVmStat } from "../../server/mac-memory.ts";
import { psProcessList } from "../../server/perf/process-sampler.ts";
import { createTreeMemoryWatchdog } from "../../server/tree-memory-watchdog.ts";

const skip = process.platform !== "darwin" ? "runs on macOS only" : false;
const MiB = 1024 * 1024;

test("vm_stat parses and available memory counts reclaimable pages", { skip }, async (t) => {
  const { stdout } = await promisify(execFile)("vm_stat");
  const stat = parseVmStat(stdout);
  assert.ok(stat, "vm_stat output parses");
  const freePart = stat.freePages * stat.pageBytes;
  t.diagnostic(`page ${stat.pageBytes} B, free ${freePart} B, inactive ${stat.inactivePages * stat.pageBytes} B, purgeable ${stat.purgeablePages * stat.pageBytes} B, speculative ${stat.speculativePages * stat.pageBytes} B`);
  t.diagnostic(`available ${stat.availableBytes} B of ${os.totalmem()} B`);
  assert.ok(stat.availableBytes > 0);
  assert.ok(stat.availableBytes <= os.totalmem());
  assert.ok(stat.availableBytes >= freePart);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts an engine stand-in whose child grows by 32 MiB every 100 ms, runs the watchdog with a 300 MiB budget until the
 * first stop, and checks that the child is gone and the engine is alive. */
async function stopHungryChild(t, extra = {}) {
  const childCode = "const keep=[];setInterval(()=>{if(keep.length<48)keep.push(Buffer.alloc(32*1024*1024,1))},100)";
  const parentCode = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});console.log("child "+c.pid);setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "ignore"] });
  let childPid = 0;
  let peak = 0, firstOver = null, stoppedAt = null;
  const stops = [];
  const watchdog = createTreeMemoryWatchdog({
    list: async () => {
      const list = await psProcessList();
      if (!list) return null;
      const tree = new Set([parent.pid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const row of list.rows) if (tree.has(row.ppid) && !tree.has(row.pid)) { tree.add(row.pid); grew = true; }
      }
      const bytes = list.rows.filter((row) => tree.has(row.pid)).reduce((sum, row) => sum + row.rssBytes, 0);
      peak = Math.max(peak, bytes);
      if (bytes > 300 * MiB && firstOver === null) firstOver = Date.now();
      return list.rows;
    },
    owners: () => [{ pid: parent.pid, botIds: ["bot-a"], kind: "engine" }],
    budgetBytes: () => 300 * MiB,
    onStop: (event) => { stops.push(event); stoppedAt ??= Date.now(); },
    ...extra,
  });
  try {
    childPid = await new Promise((resolve, reject) => {
      parent.stdout.once("data", (data) => resolve(Number(/child (\d+)/.exec(String(data))?.[1])));
      parent.once("error", reject);
    });
    assert.ok(childPid > 0);
    watchdog.start();
    const deadline = Date.now() + 45_000;
    while (stops.length === 0 && Date.now() < deadline) await sleep(250);
    const gone = Date.now() + 5_000;
    while (alive(childPid) && Date.now() < gone) await sleep(100);
    const overToStopMs = firstOver === null || stoppedAt === null ? null : stoppedAt - firstOver;
    t.diagnostic(`first over budget to stop: ${overToStopMs === null ? "n/a" : (overToStopMs / 1000).toFixed(1)} s`);
    t.diagnostic(`peak tree rss: ${(peak / MiB).toFixed(0)} MiB`);
    assert.equal(stops.length >= 1, true, "a process was stopped");
    assert.equal(stops[0].botId, "bot-a");
    assert.equal(stops[0].pid, childPid);
    assert.equal(alive(childPid), false, "the child is gone");
    assert.equal(parent.exitCode, null);
    assert.equal(alive(parent.pid), true, "the engine stand-in is alive");
    return { overToStopMs, peak };
  } finally {
    watchdog.stop();
    for (const pid of [childPid, parent.pid]) { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

test("the watchdog stops the memory-hungry child and keeps the engine (AC-07)", { skip, timeout: 60_000 }, async (t) => {
  const { overToStopMs } = await stopHungryChild(t);
  assert.ok(overToStopMs !== null && overToStopMs >= 8_000, `waited ${overToStopMs} ms over budget`);
});

test("with less than 1 GiB available the watchdog stops at the first check over budget (AC-07b)", { skip, timeout: 60_000 }, async (t) => {
  const { overToStopMs } = await stopHungryChild(t, { available: () => 0 });
  assert.ok(overToStopMs !== null && overToStopMs < 5_000, `waited ${overToStopMs} ms over budget`);
});
