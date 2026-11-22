import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BotMemoryGuard } from "../../server/bot-memory-guard.ts";
import { jobFencePath } from "../../server/job-fence.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EATER = join(root, "dist-native", "job-fence", "test", "test-eater.exe");
const MIB = 1024 * 1024;
const DESKTOP = { SEIRA_DESKTOP_PARENT: "1" };
const windowsSkip = process.platform !== "win32" ? "Windows only" : !jobFencePath({}) || !existsSync(EATER) ? "run scripts/prepare-job-fence.mjs --test first" : false;
const macSkip = process.platform !== "darwin" ? "macOS only" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (done, ms) => { for (let waited = 0; !done() && waited < ms; waited += 50) await sleep(50); return done(); };

const run = (spawned) => new Promise((resolve, reject) => {
  const child = spawn(spawned.command, spawned.args, { env: spawned.env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.once("error", reject);
  child.once("close", (code) => resolve({ pid: child.pid, code, stdout: Buffer.concat(out).toString("utf8") }));
});

describe("the memory limit for bots on Windows", { skip: windowsSkip, timeout: 120_000 }, () => {
  it("starts each engine in one job at the budget, passes its output through, and counts a stop by that engine", async () => {
    const logs = [];
    const guard = new BotMemoryGuard({ env: DESKTOP, budget: () => 256 * MIB, dataDir: () => homedir(), log: (line) => logs.push(line) });
    await guard.start(() => []);
    assert.equal(guard.protection(), "job", logs.join("\n"));

    const injob = guard.argv(EATER, ["injob"], process.env);
    const first = await run({ ...injob, env: { ...injob.env, EATER_JOB: injob.env.SEIRA_FENCE_JOB } });
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.stdout), { inJob: true, jobMemoryLimit: 256 * MIB, killOnClose: true });

    assert.equal(guard.sliceKills(), 0);
    const stopped = await run(guard.argv(EATER, ["retry", "16"], process.env));
    assert.equal(stopped.code, 137);
    assert.ok(await until(() => guard.sliceKills() === 1, 10_000), "the stop is counted");
    assert.equal(guard.scopeKills(stopped.pid), 1);
    assert.equal(guard.scopeKills(first.pid), 0);
    assert.match(logs.join("\n"), /stopped test-eater\.exe/i);

    guard.usedBytes();
    assert.ok(await until(() => guard.usedBytes() !== null, 5_000), "the job's memory is read");
    assert.equal(guard.protection(), "job");
  });

  it("uses the watchdog when the helper is missing", async () => {
    const guard = new BotMemoryGuard({ env: DESKTOP, budget: () => 256 * MIB, helper: () => null, log: () => {} });
    await guard.start(() => []);
    assert.equal(guard.protection(), "watchdog");
    assert.equal(guard.argv(EATER, ["injob"], process.env), null);
  });
});

describe("the memory limit for bots on macOS", { skip: macSkip, timeout: 120_000 }, () => {
  it("stops the largest process of an engine over the budget, keeps the engine, and counts the stop by it", async () => {
    const childCode = "const keep=[];setInterval(()=>{if(keep.length<48)keep.push(Buffer.alloc(32*1024*1024,1))},100)";
    const parentCode = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});console.log("child "+c.pid);setInterval(()=>{},1000)`;
    const engine = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "ignore"] });
    let childPid = 0;
    engine.stdout.on("data", (chunk) => { const found = /child (\d+)/.exec(String(chunk)); if (found) childPid = Number(found[1]); });
    const owners = [{ pid: engine.pid, botIds: ["b1"], kind: "engine" }];
    const guard = new BotMemoryGuard({ env: DESKTOP, budget: () => 300 * MIB, log: () => {} });
    try {
      await guard.start(() => owners);
      assert.equal(guard.protection(), "watchdog");
      assert.ok(guard.machine().availableBytes > 0);
      assert.ok(await until(() => childPid > 0, 10_000), "the engine started its child");
      assert.ok(await until(() => (guard.sliceKills() ?? 0) >= 1, 60_000), "the watchdog stopped a process");
      assert.equal(guard.scopeKills(engine.pid), guard.sliceKills());
      assert.ok(await until(() => !alive(childPid), 10_000), "the hungry child is gone");
      assert.ok(alive(engine.pid), "the engine still runs");
    } finally {
      engine.kill("SIGKILL");
      if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  });
});
