import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { windowsProcessList } from "../../server/perf/windows-process-list.ts";
import { createTreeMemoryWatchdog } from "../../server/tree-memory-watchdog.ts";

const skip = process.platform !== "win32" ? "Windows only" : false;
const MiB = 1024 * 1024;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the process list sees this process with its memory", { skip }, async () => {
  const list = await windowsProcessList();
  assert.ok(list, "the list is read");
  const own = list.rows.find((row) => row.pid === process.pid);
  assert.ok(own, "this process is in the list");
  assert.equal(own.name, "node.exe");
  assert.ok(own.rssBytes > 10 * MiB);
  assert.ok(list.rows.some((row) => row.ppid === own.ppid));
});

/** Starts an engine stand-in whose child grows by 32 MiB every 100 ms, runs the watchdog with a 300 MiB budget until the
 * first stop, and checks that the child is gone and the engine is alive. */
async function stopHungryChild(t, extra = {}) {
  const childCode = "const keep=[];setInterval(()=>{if(keep.length<48)keep.push(Buffer.alloc(32*1024*1024,1))},100)";
  const parentCode = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});console.log("child "+c.pid);setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const stops = [];
  let childPid = 0, firstOver = null, stoppedAt = null, peak = 0;
  const watchdog = createTreeMemoryWatchdog({
    list: async () => {
      const list = await windowsProcessList();
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
    const deadline = Date.now() + 60_000;
    while (stops.length === 0 && Date.now() < deadline) await sleep(250);
    const gone = Date.now() + 5_000;
    while (alive(childPid) && Date.now() < gone) await sleep(100);
    const overToStopMs = firstOver === null || stoppedAt === null ? null : stoppedAt - firstOver;
    t.diagnostic(`first over budget to stop: ${overToStopMs === null ? "n/a" : (overToStopMs / 1000).toFixed(1)} s; peak ${(peak / MiB).toFixed(0)} MiB`);
    assert.ok(stops.length >= 1, "a process was stopped");
    assert.equal(stops[0].botId, "bot-a");
    assert.equal(stops[0].pid, childPid);
    assert.equal(alive(childPid), false, "the child is gone");
    assert.equal(alive(parent.pid), true, "the engine stand-in is alive");
    return { overToStopMs, peak };
  } finally {
    watchdog.stop();
    for (const pid of [childPid, parent.pid]) { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

test("without the helper, the watchdog stops the memory-hungry child and keeps the engine (AC-06)", { skip, timeout: 90_000 }, async (t) => {
  const { overToStopMs } = await stopHungryChild(t);
  assert.ok(overToStopMs !== null && overToStopMs >= 8_000, `waited ${overToStopMs} ms over budget`);
});

test("with less than 1 GiB available the watchdog stops at the first check over budget (AC-07b)", { skip, timeout: 90_000 }, async (t) => {
  const { overToStopMs } = await stopHungryChild(t, { available: () => 0 });
  assert.ok(overToStopMs !== null && overToStopMs < 5_000, `waited ${overToStopMs} ms over budget`);
});
