// seira-job-fence on a real Windows job object. The Windows CI job runs this with `node --test` after
// `node scripts/prepare-job-fence.mjs --test`; on any other system every test skips.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FENCE = join(root, "dist-native", "job-fence", "win32-x64", "seira-job-fence.exe");
const EATER = join(root, "dist-native", "job-fence", "test", "test-eater.exe");
const MIB = 1024 * 1024;
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(FENCE) || !existsSync(EATER) ? "run scripts/prepare-job-fence.mjs --test first" : false;

/** A running `hold`: its events, and a wait for the next event that matches. */
function startHold(limitMib) {
  const proc = spawn(FENCE, ["hold", "Local\\Seira-bots-test", String(limitMib)], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  started.push(proc);
  const events = [];
  const waiters = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    const matched = waiters.filter((waiter) => waiter.match(event));
    for (const waiter of matched) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
  });
  const next = (match, ms = 30_000) => {
    const seen = events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (event) => { clearTimeout(timer); resolve(event); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`no event in ${ms} ms; got ${JSON.stringify(events)}`)); }, ms);
      waiters.push(waiter);
    });
  };
  const send = (line) => proc.stdin.write(`${line}\n`);
  const close = () => new Promise((resolve) => { if (proc.exitCode !== null) return resolve(proc.exitCode); proc.once("exit", (code) => resolve(code)); proc.stdin.end(); });
  return { proc, events, next, send, close };
}

/** Run a command through the helper inside `job`; resolves with its exit code, stdout and stderr. EATER_JOB tells
 * `test-eater injob` which job to look at. */
function fenced(job, command, args, { input, env } = {}) {
  const fence = job ? { SEIRA_FENCE_JOB: job, EATER_JOB: job } : {};
  const child = spawn(FENCE, ["--", command, ...args], { env: { ...process.env, ...env, ...fence }, windowsHide: true });
  started.push(child);
  return collect(child, input);
}

function collect(child, input) {
  const out = [], err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });
  return Object.assign(done, { child });
}

/** Every helper this file starts: a failed test must not leave one running, or the test file never ends. */
const started = [];
const stopAll = (...children) => { for (const child of children) if (child.exitCode === null) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exitCode = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  child.once("error", reject);
  child.once("exit", resolve);
});

const T = { timeout: 60_000 };
/** Windows counts a request that the job refuses in PeakJobMemoryUsed, with the page tables for its range (one 4 KiB page
 * for each 2 MiB, one more for a range that does not start on a 2 MiB line). The memory in use never passes the limit. */
const refusedRequestBytes = (mib) => mib * MIB + (Math.ceil(mib / 2) + 1) * 4096;

describe("seira-job-fence", { skip }, () => {
  after(() => stopAll(...started));

  it("passes arguments, stdin, stdout, stderr and the exit code through unchanged (AC-04)", T, async () => {
    const hold = startHold(2048);
    const { job } = await hold.next((event) => event.event === "ready");
    // Echo stdin to stdout byte for byte; argv and the fence variable go to stderr.
    const script = "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(c));"
      + "process.stderr.write(JSON.stringify({argv:process.argv.slice(1),fence:process.env.SEIRA_FENCE_JOB??null}));process.exitCode=7})";
    const args = ["-e", script, "a b", 'say "hi"', "back\\slash\\", "trail\\\\", "", "ünï ☃", "%PATH%"];
    const input = randomBytes(1024 * 1024);
    const direct = await collect(spawn(process.execPath, args, { windowsHide: true }), input);
    const viaFence = await fenced(job, process.execPath, args, { input });
    assert.equal(viaFence.code, 7);
    assert.equal(viaFence.code, direct.code);
    assert.ok(viaFence.stdout.equals(input), "stdout carries stdin byte for byte");
    assert.deepEqual(JSON.parse(viaFence.stderr), JSON.parse(direct.stderr));
    assert.equal(JSON.parse(viaFence.stderr).fence, null, "the program does not see the job variable");
    assert.equal(await hold.close(), 0);
  });

  it("starts the program and its children inside the job, with the limit already set (AC-01)", T, async () => {
    const hold = startHold(300);
    const { job } = await hold.next((event) => event.event === "ready");
    const own = await fenced(job, EATER, ["injob"]);
    assert.equal(own.code, 0);
    assert.deepEqual(JSON.parse(own.stdout.toString()), { inJob: true, jobMemoryLimit: 300 * MIB, killOnClose: true });
    const grandchild = await fenced(job, EATER, ["child", "injob"]);
    assert.equal(grandchild.code, 0);
    assert.deepEqual(JSON.parse(grandchild.stdout.toString()), { inJob: true, jobMemoryLimit: 300 * MIB, killOnClose: true });
    assert.equal(await hold.close(), 0);
  });

  it("stops a program at the limit, reports it, and keeps running (AC-03)", T, async (t) => {
    const hold = startHold(256);
    const { job } = await hold.next((event) => event.event === "ready");
    const started = Date.now();
    const run = fenced(job, EATER, ["retry", "16"]);
    const result = await run;
    const stop = await hold.next((event) => event.event === "memory-stop");
    t.diagnostic(`stopped after ${Date.now() - started} ms: ${JSON.stringify(stop)}`);
    assert.equal(result.code, 137);
    assert.equal(stop.name.toLowerCase(), "test-eater.exe");
    assert.equal(stop.helper, run.child.pid);
    assert.equal(stop.limitBytes, 256 * MIB);
    assert.equal(hold.proc.exitCode, null, "hold keeps running");
    assert.ok(stop.jobBytes <= 256 * MIB, `in use ${stop.jobBytes} within the limit`);
    hold.send("stats");
    const stats = await hold.next((event) => event.event === "stats");
    t.diagnostic(`peak ${stats.peakBytes}: ${stats.peakBytes - 256 * MIB} over the limit`);
    assert.ok(stats.peakBytes <= 256 * MIB + refusedRequestBytes(16), `peak ${stats.peakBytes} within the limit and one refused 16 MiB request`);
    assert.equal(await hold.close(), 0);
  });

  it("counts a refused request in the job's peak, while the memory in use stays under the limit", T, async (t) => {
    const hold = startHold(512);
    const { job } = await hold.next((event) => event.event === "ready");
    const run = fenced(job, EATER, ["ask", "64", "480"]);
    try {
      const answer = await new Promise((resolve) => run.child.stdout.on("data", (chunk) => {
        const match = /asked (\w+)/.exec(chunk.toString());
        if (match) resolve(match[1]);
      }));
      assert.equal(answer, "refused");
      // The job, not the computer, refused it: Windows sent the job's memory-limit message.
      const denied = await hold.next((event) => event.event === "memory-denied");
      assert.ok(denied.jobBytes < 128 * MIB, `in use ${denied.jobBytes} when refused`);
      hold.send("stats");
      const stats = await hold.next((event) => event.event === "stats");
      const counted = stats.peakBytes - stats.jobBytes;
      t.diagnostic(`in use ${stats.jobBytes}, peak ${stats.peakBytes}: the refused 480 MiB request counted ${counted}`);
      assert.ok(stats.jobBytes < 128 * MIB, `in use ${stats.jobBytes}`);
      assert.ok(counted >= 480 * MIB && counted <= refusedRequestBytes(480) + 64 * 1024, `counted ${counted}`);
      assert.equal(hold.events.some((event) => event.event === "memory-stop"), false, "nothing was stopped");
    } finally {
      stopAll(run.child);
      await hold.close();
    }
  });

  it("stops a child of the engine before the engine itself", T, async () => {
    const hold = startHold(256);
    const { job } = await hold.next((event) => event.event === "ready");
    const run = fenced(job, EATER, ["child", "retry", "16"]);
    const result = await run;
    const stop = await hold.next((event) => event.event === "memory-stop");
    // The engine stand-in passes its child's exit code on: the child was stopped, the engine was not.
    assert.equal(result.code, 137);
    assert.notEqual(stop.pid, stop.root);
    assert.equal(stop.helper, run.child.pid);
    assert.equal(await hold.close(), 0);
  });

  it("limits the sum of all programs in the job (AC-02)", T, async (t) => {
    const hold = startHold(256);
    const { job } = await hold.next((event) => event.event === "ready");
    const first = fenced(job, EATER, ["hold", "160"]);
    await new Promise((resolve) => first.child.stdout.on("data", (chunk) => { if (chunk.toString().includes("held")) resolve(); }));
    const second = fenced(job, EATER, ["retry", "16"]);
    try {
      // Each alone fits; together they pass the limit, so the job stops one, then the other as the second keeps growing.
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.code, 137);
      assert.equal(b.code, 137);
      hold.send("stats");
      const stats = await hold.next((event) => event.event === "stats");
      t.diagnostic(`stats ${JSON.stringify(stats)}; stops ${JSON.stringify(hold.events.filter((event) => event.event === "memory-stop"))}`);
      const stops = hold.events.filter((event) => event.event === "memory-stop");
      assert.ok(stops.every((stop) => stop.jobBytes <= 256 * MIB), "in use within the limit at each stop");
      // Only one program asks at a time: the first one holds its 160 MiB before the second starts.
      assert.ok(stats.peakBytes <= 256 * MIB + refusedRequestBytes(16), `peak ${stats.peakBytes} within the limit and one refused 16 MiB request`);
      assert.equal(stops.length, 2);
    } finally {
      stopAll(first.child, second.child);
      await hold.close();
    }
  });

  it("changes the limit on a command", T, async () => {
    const hold = startHold(256);
    await hold.next((event) => event.event === "ready");
    hold.send("limit 512");
    assert.equal((await hold.next((event) => event.event === "limit")).limitBytes, 512 * MIB);
    const { job } = hold.events[0];
    const own = await fenced(job, EATER, ["injob"]);
    assert.equal(JSON.parse(own.stdout.toString()).jobMemoryLimit, 512 * MIB);
    assert.equal(await hold.close(), 0);
  });

  it("runs the program without the bots job when that job is missing", T, async () => {
    const result = await fenced("Local\\Seira-bots-missing-0", EATER, ["injob"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout.toString()), { inJob: false, jobMemoryLimit: 0, killOnClose: true });
  });

  it("never runs the program outside a job that exists, even when the program cannot start inside it", T, async () => {
    const hold = startHold(1);
    const { job } = await hold.next((event) => event.event === "ready");
    try {
      const result = await fenced(job, EATER, ["injob"]);
      const out = result.stdout.toString();
      assert.ok(!out.includes('"inJob":false'), `ran outside the job: ${out} (exit ${result.code})`);
      if (result.code === 0) assert.equal(JSON.parse(out).inJob, true);
    } finally {
      await hold.close();
    }
  });

  it("refuses a .bat or .cmd program, whatever its spelling", T, async () => {
    const folder = mkdtempSync(join(tmpdir(), "seira-fence-"));
    const marker = join(folder, "ran.txt");
    for (const name of ["x.cmd", "y.BAT"]) writeFileSync(join(folder, name), `@echo off\r\necho ran> "${marker}"\r\n`);
    for (const program of [join(folder, "x.cmd"), `${join(folder, "x.cmd")}.`, `${join(folder, "x.cmd")} .`, join(folder, "y.BAT")]) {
      const result = await fenced(null, program, ["a"]);
      assert.equal(result.code, 127, `${program}: ${result.stderr}`);
    }
    assert.equal(existsSync(marker), false, "no batch file ran");
  });

  it("stops the program and its children when the helper is stopped", T, async () => {
    const hold = startHold(512);
    const { job } = await hold.next((event) => event.event === "ready");
    const run = fenced(job, EATER, ["child", "hold", "16"]);
    try {
      const pid = await new Promise((resolve) => run.child.stdout.on("data", (chunk) => {
        const match = /held \d+ (\d+)/.exec(chunk.toString());
        if (match) resolve(Number(match[1]));
      }));
      assert.ok(alive(pid));
      run.child.kill();
      for (let waited = 0; alive(pid) && waited < 10_000; waited += 100) await sleep(100);
      assert.equal(alive(pid), false, "the grandchild ended with the helper");
    } finally {
      stopAll(run.child);
      await hold.close();
    }
  });

  it("leaves processes the program started running after the program ends", T, async () => {
    const hold = startHold(512);
    const { job } = await hold.next((event) => event.event === "ready");
    let pid = 0;
    try {
      const result = await fenced(job, EATER, ["spawn", "hold", "16"]);
      assert.equal(result.code, 0);
      pid = Number(/spawned (\d+)/.exec(result.stdout.toString())?.[1]);
      await sleep(1000);
      assert.equal(alive(pid), true, "the process the program started still runs");
    } finally {
      if (pid) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      await hold.close();
    }
  });

  it("refuses a limit that is not a whole number of MiB in range", T, async () => {
    for (const limit of ["-1", "+5", " 5", "0", "99999999999999999999", "8796093022208"]) {
      assert.equal(await exitCode(FENCE, ["hold", "Local\\Seira-bots-test", limit]), 2, limit);
    }
    const hold = startHold(64);
    await hold.next((event) => event.event === "ready");
    for (const line of ["limit -5", "limit 0", "limit 99999999999999999999"]) hold.send(line);
    await hold.next((event) => event.event === "error" && hold.events.filter((seen) => seen.step === "limit-value").length === 3);
    assert.equal(hold.events.some((event) => event.event === "limit"), false);
    assert.equal(await hold.close(), 0);
  });

  it("exits when its stdin closes", T, async () => {
    const hold = startHold(128);
    await hold.next((event) => event.event === "ready");
    assert.equal(await hold.close(), 0);
  });
});
