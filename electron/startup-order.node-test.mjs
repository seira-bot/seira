import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the server fork never waits for the startup screen", () => {
  assert.ok(!main.includes("await startupScreen?.ready"), "the startup screen's ready promise is kept, not awaited");
  const fork = main.indexOf("await startServerPackaged()");
  const wait = main.indexOf("await splashReady");
  assert.ok(fork !== -1 && wait !== -1, "both steps exist");
  assert.ok(fork < wait, "the server starts before startup waits for the startup screen");
  assert.ok(main.indexOf("const splashReady = ") < fork, "the startup screen is created before the server starts");
  assert.ok(wait < main.indexOf('startupScreen?.progress("engine")'), "the wait ends before the engine step");
});
