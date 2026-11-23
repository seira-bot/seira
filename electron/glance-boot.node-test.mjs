import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");

test("AC-11 the helper branch starts first, before the settings folder is chosen, and never loads main", () => {
  const branch = source.indexOf('process.argv.includes("--seira-glance-visor")');
  assert.ok(branch > 0);
  assert.ok(branch < source.indexOf("OLD_KEY_READER}="));
  assert.ok(branch < source.indexOf("chooseSettingsFolder({"));
  const end = source.indexOf("} else if", branch);
  const helperBranch = source.slice(branch, end);
  assert.match(helperBranch, /glance-visor-host\.mjs/);
  assert.doesNotMatch(helperBranch, /main\.mjs|chooseSettingsFolder/);
});
