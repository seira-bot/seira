import assert from "node:assert/strict";
import test from "node:test";

import { magicDnsEnabled } from "./tailscale-check.mjs";

const status = (flag) => JSON.stringify({ BackendState: "Running", CurrentTailnet: { Name: "example-tailnet", MagicDNSEnabled: flag } });

test("magicDnsEnabled asks the first command-line tool that exists and reports its MagicDNS flag", async () => {
  const asked = [];
  const run = async (cli) => { asked.push(cli); return cli === "/missing" ? { missing: true, stdout: "", stderr: "" } : { missing: false, stdout: status(false), stderr: "" }; };
  assert.equal(await magicDnsEnabled({ run, candidates: ["/missing", "/tailscale", "/never"] }), false);
  assert.deepEqual(asked, ["/missing", "/tailscale"]);
  assert.equal(await magicDnsEnabled({ run: async () => ({ missing: false, stdout: status(true), stderr: "" }), candidates: ["/tailscale"] }), true);
});

test("magicDnsEnabled is null with no tool, unreadable output or a failed run", async () => {
  assert.equal(await magicDnsEnabled({ run: async () => ({ missing: true, stdout: "", stderr: "" }), candidates: ["/a"] }), null);
  assert.equal(await magicDnsEnabled({ run: async () => ({ missing: false, stdout: "Tailscale started", stderr: "" }), candidates: ["/a"] }), null);
  assert.equal(await magicDnsEnabled({ run: async () => { throw new Error("boom"); }, candidates: ["/a"] }), null);
});
