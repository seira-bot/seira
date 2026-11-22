import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { jobBaseName, jobFenceArgv, jobFenceEnv, jobFencePath, startJobHold } from "../../server/job-fence.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EATER = join(root, "dist-native", "job-fence", "test", "test-eater.exe");
const MIB = 1024 * 1024;
const helper = jobFencePath({});
const skip = process.platform !== "win32" ? "Windows only" : !helper || !existsSync(EATER) ? "run scripts/prepare-job-fence.mjs --test first" : false;

const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8") }));
});

describe("the server's job hold", { skip, timeout: 120_000 }, () => {
  it("starts the job, fences a program, changes the limit and reports a stop", async () => {
    const events = [];
    let exits = 0;
    const hold = await startJobHold({ helper, base: jobBaseName(homedir()), limitBytes: 256 * MIB, onEvent: (event) => events.push(event), onExit: () => { exits += 1; } });
    assert.ok(hold, "the hold is ready");
    assert.match(hold.job, /^Local\\Seira-bots-[0-9a-f]{10}-\d+$/);
    try {
      const injob = jobFenceArgv(helper, EATER, ["injob"]);
      const env = { ...jobFenceEnv(process.env, hold.job), EATER_JOB: hold.job };
      const first = await run(injob.command, injob.args, env);
      assert.deepEqual(JSON.parse(first.stdout), { inJob: true, jobMemoryLimit: 256 * MIB, killOnClose: true });

      hold.setLimit(320 * MIB);
      for (let waited = 0; !events.some((event) => event.event === "limit") && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await run(injob.command, injob.args, env);
      assert.equal(JSON.parse(second.stdout).jobMemoryLimit, 320 * MIB);
      assert.equal(hold.limitBytes(), 320 * MIB);

      const eat = jobFenceArgv(helper, EATER, ["retry", "16"]);
      const stopped = await run(eat.command, eat.args, jobFenceEnv(process.env, hold.job));
      assert.equal(stopped.code, 137);
      for (let waited = 0; !events.some((event) => event.event === "memory-stop") && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      const stop = events.find((event) => event.event === "memory-stop");
      assert.equal(stop?.name.toLowerCase(), "test-eater.exe");
      assert.equal(hold.alive(), true);
    } finally {
      hold.close();
    }
    for (let waited = 0; exits === 0 && waited < 10_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(exits, 1, "the helper exits when the server closes its stdin");
    assert.equal(hold.alive(), false);
  });

  it("gives null when the helper cannot start", async () => {
    assert.equal(await startJobHold({ helper: join(root, "missing.exe"), base: "Local\\Seira-bots-test", limitBytes: 64 * MIB }), null);
  });
});
