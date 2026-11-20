import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adoptLegacyEnv, isHarnessEnvName } from "./legacy-env.mjs";

const lines = () => { const out = []; return { out, warn: (line) => out.push(line) }; };

test("an old name is renamed to the current one and removed", () => {
  const env = { OMB_DATA_DIR: "/tmp/fixture-old", PATH: "/bin" };
  const { out, warn } = lines();
  const report = adoptLegacyEnv(env, warn);
  assert.deepEqual(env, { SEIRA_DATA_DIR: "/tmp/fixture-old", PATH: "/bin" });
  assert.deepEqual(report, { adopted: ["OMB_DATA_DIR"], conflicts: [] });
  assert.equal(out.length, 1);
  assert.match(out[0], /OMB_DATA_DIR is deprecated.*SEIRA_DATA_DIR/);
});

test("the current name wins over a different old value, and the warning never prints a value", () => {
  const env = { SEIRA_JEV_API_KEY: "current-secret", OMB_JEV_API_KEY: "old-secret" };
  const { out, warn } = lines();
  const report = adoptLegacyEnv(env, warn);
  assert.deepEqual(env, { SEIRA_JEV_API_KEY: "current-secret" });
  assert.deepEqual(report.conflicts, ["OMB_JEV_API_KEY"]);
  assert.match(out.join("\n"), /using SEIRA_JEV_API_KEY/);
  assert.doesNotMatch(out.join("\n"), /secret/);
});

test("an old name warns once per process, however often the environment is read", () => {
  const { out, warn } = lines();
  adoptLegacyEnv({ OMB_PORT: "1" }, warn);
  adoptLegacyEnv({ OMB_PORT: "2" }, warn);
  assert.equal(out.filter((line) => line.includes("OMB_PORT")).length, 1);
});

test("a name under either prefix is the harness's", () => {
  assert.equal(isHarnessEnvName("SEIRA_CONTROL_TOKEN"), true);
  assert.equal(isHarnessEnvName("OMB_CONTROL_TOKEN"), true);
  assert.equal(isHarnessEnvName("OPENAI_API_KEY"), false);
});

test("a name matches the harness prefixes in any letter case", () => {
  assert.equal(isHarnessEnvName("seira_mcp_token_x"), true);
  assert.equal(isHarnessEnvName("Omb_control_token"), true);
});

test("an empty current value gives way to a set old value", () => {
  const env = { SEIRA_DATA_DIR: "", OMB_DATA_DIR: "/tmp/fixture-old" };
  const report = adoptLegacyEnv(env);
  assert.deepEqual(env, { SEIRA_DATA_DIR: "/tmp/fixture-old" });
  assert.deepEqual(report.adopted, ["OMB_DATA_DIR"]);
  const both = { SEIRA_PORT: "", OMB_PORT: "" };
  adoptLegacyEnv(both);
  assert.deepEqual(both, { SEIRA_PORT: "" });
});

test("prefixes match without regard to letter case, and the adopted name is in capitals", () => {
  assert.equal(isHarnessEnvName("Omb_Control_Token"), true);
  assert.equal(isHarnessEnvName("seira_control_token"), true);
  const env = { Omb_Data_Dir: "/fixture" };
  adoptLegacyEnv(env);
  assert.deepEqual(env, { SEIRA_DATA_DIR: "/fixture" });
});

test("a process that imports the boot module sees the old name under the new one, with a warning and no value", () => {
  const boot = fileURLToPath(new URL("./legacy-env-boot.mjs", import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), "seira-legacy-env-"));
  const script = `import ${JSON.stringify(boot)}; console.log(JSON.stringify({ dir: process.env.SEIRA_DATA_DIR, old: process.env.OMB_DATA_DIR ?? null }));`;
  const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const legacy = run({ OMB_DATA_DIR: fixture });
  assert.deepEqual(JSON.parse(legacy.stdout), { dir: fixture, old: null });
  assert.match(legacy.stderr, /OMB_DATA_DIR is deprecated/);
  assert.doesNotMatch(legacy.stderr, new RegExp(fixture));
  const current = run({ SEIRA_DATA_DIR: fixture });
  assert.deepEqual(JSON.parse(current.stdout), { dir: fixture, old: null });
  assert.equal(current.stderr, "");
});
