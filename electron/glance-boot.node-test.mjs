import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");

test("AC-11 the helper branch starts first, before the settings folder is chosen, and never loads main", () => {
  const branch = source.indexOf('process.argv.some(entry => entry.startsWith("--seira-glance-visor="))');
  assert.ok(branch > 0);
  assert.ok(branch < source.indexOf("OLD_KEY_READER}="));
  assert.ok(branch < source.indexOf("chooseSettingsFolder({"));
  const end = source.indexOf("} else if", branch);
  const helperBranch = source.slice(branch, end);
  assert.match(helperBranch, /glance-visor-host\.mjs/);
  assert.doesNotMatch(helperBranch, /main\.mjs|chooseSettingsFolder/);
});

test("AC-01 the helper branch does not await the host, so Electron can emit ready", () => {
  const branch = source.indexOf('process.argv.some(entry => entry.startsWith("--seira-glance-visor="))');
  const helperBranch = source.slice(branch, source.indexOf("} else if", branch));
  assert.match(helperBranch, /void runGlanceVisorHost\(/);
  assert.doesNotMatch(helperBranch, /await runGlanceVisorHost\(/);
});
