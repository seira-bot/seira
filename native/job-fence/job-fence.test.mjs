// seira-job-fence on a real Windows job object. The Windows CI job runs this with `node --test` after
// `node scripts/prepare-job-fence.mjs --test`; on any other system every test skips.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FENCE = join(root, "dist-native", "job-fence", "win32-x64", "seira-job-fence.exe");
const EATER = join(root, "dist-native", "job-fence", "test", "test-eater.exe");
const MIB = 1024 * 1024;
const skip = process.platform !== "win32" ? "Windows only" : !existsSync(FENCE) || !existsSync(EATER) ? "run scripts/prepare-job-fence.mjs --test first" : false;

/** A running `hold`: its events, and a wait for the next event that matches. */
function startHold(limitMib) {
  const proc = spawn(FENCE, ["hold", "Local\\Seira-bots-test", String(limitMib)], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
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

/** Run a command through the helper inside `job`; resolves with its exit code, stdout and stderr. */
function fenced(job, command, args, { input, env } = {}) {
  return collect(spawn(FENCE, ["--", command, ...args], { env: { ...process.env, ...env, ...(job ? { SEIRA_FENCE_JOB: job } : {}) }, windowsHide: true }), input);
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

const stopAll = (...children) => { for (const child of children) if (child.exitCode === null) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); };

describe("seira-job-fence", { skip, timeout: 120_000 }, () => {
  it("passes arguments, stdin, stdout, stderr and the exit code through unchanged (AC-04)", async () => {
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

  it("starts the program and its children inside the job, with the limit already set (AC-01)", async () => {
    const hold = startHold(300);
    const { job } = await hold.next((event) => event.event === "ready");
    const own = await fenced(job, EATER, ["injob"]);
    assert.equal(own.code, 0);
    assert.deepEqual(JSON.parse(own.stdout.toString()), { inJob: true, jobMemoryLimit: 300 * MIB });
    const grandchild = await fenced(job, EATER, ["child", "injob"]);
    assert.equal(grandchild.code, 0);
    assert.deepEqual(JSON.parse(grandchild.stdout.toString()), { inJob: true, jobMemoryLimit: 300 * MIB });
    assert.equal(await hold.close(), 0);
  });

  it("stops a program at the limit, reports it, and keeps running (AC-03)", async (t) => {
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
    hold.send("stats");
    const stats = await hold.next((event) => event.event === "stats");
    assert.ok(stats.peakBytes <= 256 * MIB, `peak ${stats.peakBytes} within the limit`);
    assert.equal(await hold.close(), 0);
  });

  it("stops a child of the engine before the engine itself", async () => {
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

  it("limits the sum of all programs in the job (AC-02)", async (t) => {
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
      assert.ok(stats.peakBytes <= 256 * MIB, `peak ${stats.peakBytes} within the limit`);
      assert.equal(hold.events.filter((event) => event.event === "memory-stop").length, 2);
    } finally {
      stopAll(first.child, second.child);
      await hold.close();
    }
  });

  it("changes the limit on a command", async () => {
    const hold = startHold(256);
    await hold.next((event) => event.event === "ready");
    hold.send("limit 512");
    assert.equal((await hold.next((event) => event.event === "limit")).limitBytes, 512 * MIB);
    const { job } = hold.events[0];
    const own = await fenced(job, EATER, ["injob"]);
    assert.equal(JSON.parse(own.stdout.toString()).jobMemoryLimit, 512 * MIB);
    assert.equal(await hold.close(), 0);
  });

  it("runs the program without a job when the job is missing", async () => {
    const result = await fenced("Local\\Seira-bots-missing-0", EATER, ["injob"]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout.toString()).jobMemoryLimit, 0);
  });

  it("exits when its stdin closes", async () => {
    const hold = startHold(128);
    await hold.next((event) => event.event === "ready");
    assert.equal(await hold.close(), 0);
  });
});
