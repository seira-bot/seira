import assert from "node:assert/strict";
import test from "node:test";

import { installServerRename } from "./server-rename.mjs";

const state = () => ({ activeId: "local", environments: [
  { id: "vps", kind: "remote", name: "instabox-seira", origin: "https://bots.example.test" },
  { id: "acme", kind: "remote", name: "Acme", origin: "https://seira-t-acme.fly.dev", team: { id: "team-acme", role: "member" } },
  { id: "home", kind: "remote", name: "Studio", origin: "https://seira-u-1a2b3c4d5e6f.fly.dev", home: true },
  { id: "a", kind: "remote", name: "Client A", origin: "https://seira-c-a.fly.dev", cloud: { id: "c-a", role: "owner" } },
  { id: "lab", kind: "local", name: "Lab", dataDir: "/lab" },
] });

function harness({ fail = false } = {}) {
  const handlers = new Map(), written = [], guarded = [];
  let current = state();
  const rename = installServerRename({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: (channel, handler) => { guarded.push(channel); return handler; },
    state: () => current, persist: (next) => { if (fail) throw new Error("disk"); written.push(next); current = next; }, taken: () => ["This computer", "Work"] });
  return { rename, written, guarded, current: () => current, call: (...args) => handlers.get("environments:rename")({ sender: {} }, ...args) };
}

test("a server saved by hand takes a trimmed name, which is persisted at once so the title, menus and rail follow", () => {
  const h = harness();
  assert.deepEqual(h.guarded, ["environments:rename"], "behind this computer's own page guard");
  assert.deepEqual(h.call("vps", "  Studio   box "), { outcome: "saved" });
  assert.equal(h.written.length, 1);
  assert.equal(h.current().environments[0].name, "Studio box");
  assert.deepEqual(h.rename("vps", "Studio box"), { outcome: "saved" });
  assert.equal(h.written.length, 1, "the same name writes nothing");
});

test("an empty, long or used name keeps the old one and writes nothing; This computer's and a workspace's names are used", () => {
  const h = harness();
  assert.deepEqual(h.call("vps", ""), { outcome: "name" });
  assert.deepEqual(h.call("vps", "x".repeat(61)), { outcome: "name" });
  assert.deepEqual(h.call("vps", "client a"), { outcome: "taken" });
  assert.deepEqual(h.call("vps", "this computer"), { outcome: "taken" });
  assert.deepEqual(h.call("vps", "WORK"), { outcome: "taken" });
  assert.deepEqual(h.call("vps", 7), { outcome: "name" });
  assert.deepEqual(h.written, []);
  assert.equal(h.current().environments[0].name, "instabox-seira");
});

test("only a server saved by hand: never My Cloud, a team's or another Cloud of the person's, a workspace folder, or an unknown id", () => {
  const h = harness();
  for (const id of ["home", "acme", "a", "lab", "local", "nope", 5]) assert.deepEqual(h.call(id, "New name"), { outcome: "gone" }, String(id));
  assert.deepEqual(h.written, []);
});

test("a name that cannot be written says failed and the old name stays", () => {
  const h = harness({ fail: true });
  assert.deepEqual(h.call("vps", "Branch office"), { outcome: "failed" });
  assert.equal(h.current().environments[0].name, "instabox-seira");
});
