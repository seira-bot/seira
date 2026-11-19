import assert from "node:assert/strict";
import { test } from "node:test";

import { postToServer } from "./server-message.mjs";

test("a message reaches the server process", () => {
  const sent = [];
  const logs = [];
  postToServer({ postMessage: (message) => sent.push(message) }, { type: "x" }, "sync", (line) => logs.push(line));
  assert.deepEqual(sent, [{ type: "x" }]);
  assert.deepEqual(logs, []);
});

test("a failing postMessage logs the failure and does not throw", () => {
  const logs = [];
  const proc = { postMessage: () => { throw new Error("channel closed"); } };
  assert.doesNotThrow(() => postToServer(proc, {}, "phone credential key sync", (line) => logs.push(line)));
  assert.deepEqual(logs, ["phone credential key sync failed: channel closed"]);
});
