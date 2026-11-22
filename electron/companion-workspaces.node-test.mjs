import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionWorkspaces, WORKSPACES_MESSAGE, WORKSPACE_SWITCH_MESSAGE } from "./companion-workspaces.mjs";

function setup({ facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "ready" }], settling = null } = {}) {
  const w = { facts, settling, calls: [], sent: [], running: true, order: [] };
  w.profiles = {
    phoneFacts: () => w.facts,
    settling: () => w.settling,
    open: async (id) => { w.order.push("open"); w.calls.push(["open", id]); },
    computer: async () => { w.calls.push(["computer"]); },
    cancel: () => { w.calls.push(["cancel"]); },
  };
  w.module = createCompanionWorkspaces({ profiles: w.profiles, post: (message) => { w.sent.push(message); return w.running; }, settled: async () => { w.order.push("settled"); }, log: (line) => (w.logs ??= []).push(line) });
  w.ask = async (action, id) => { assert.equal(w.module.receive({ type: WORKSPACE_SWITCH_MESSAGE, action, id }), true); await new Promise((resolve) => setImmediate(resolve)); };
  return w;
}

test("a companion that starts gets the facts first", () => {
  const w = setup();
  assert.deepEqual(w.module.initial(), { type: WORKSPACES_MESSAGE, workspaces: w.facts });
  w.module.changed();
  assert.deepEqual(w.sent, [], "the same facts are not sent twice");
});

test("a change sends the facts once, and again after the companion restarts", () => {
  const w = setup();
  w.module.changed();
  w.module.changed();
  assert.equal(w.sent.length, 1);
  w.facts = [{ id: "local", current: false, state: "ready" }, { id: "work", current: true, state: "ready" }];
  w.module.changed();
  assert.equal(w.sent.length, 2);
  assert.equal(w.sent[1].workspaces[1].current, true);
});

test("facts that no companion received are sent on the next change", () => {
  const w = setup();
  w.running = false;
  w.module.changed();
  w.running = true;
  w.module.changed();
  assert.equal(w.sent.length, 2);
});

test("home that is not this computer sends null, so the phone's routes answer 404", () => {
  const w = setup({ facts: null });
  assert.deepEqual(w.module.initial(), { type: WORKSPACES_MESSAGE, workspaces: null });
});

test("open starts the switch the rail starts, after the same wait", async () => {
  const w = setup();
  await w.ask("open", "work");
  assert.deepEqual(w.calls, [["open", "work"]]);
  assert.deepEqual(w.order, ["settled", "open"]);
});

test("open for This PC goes back to this computer's own copy", async () => {
  const w = setup({ facts: [{ id: "local", current: false, state: "ready" }, { id: "work", current: true, state: "ready" }] });
  await w.ask("open", "local");
  assert.deepEqual(w.calls, [["computer"]]);
});

test("open does nothing for a workspace that is waiting or unavailable, or not in the list", async () => {
  const w = setup({ facts: [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }, { id: "home", current: false, state: "unavailable" }] });
  await w.ask("open", "work");
  await w.ask("open", "home");
  await w.ask("open", "nope");
  assert.deepEqual(w.calls, []);
});

test("hurry opens the workspace that waits, as a second click does, and only that one", async () => {
  const w = setup({ facts: [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }], settling: { id: "work", name: "Scout" } });
  await w.ask("hurry", "work");
  assert.deepEqual(w.calls, [["open", "work"]]);
  const other = setup({ settling: { id: "home", name: "Scout" } });
  await other.ask("hurry", "work");
  assert.deepEqual(other.calls, []);
  const local = setup({ facts: [{ id: "local", current: false, state: "waiting" }, { id: "work", current: true, state: "ready" }], settling: { id: null, name: "Juno" } });
  await local.ask("hurry", "local");
  assert.deepEqual(local.calls, [["computer"]]);
});

test("cancel ends the switch that waits, and does nothing when none waits", async () => {
  const waiting = setup({ settling: { id: "work", name: "Scout" } });
  await waiting.ask("cancel", "local");
  assert.deepEqual(waiting.calls, [["cancel"]]);
  const idle = setup();
  await idle.ask("cancel", "local");
  assert.deepEqual(idle.calls, []);
});

test("a message of another kind is not this module's, and a bad action does nothing", async () => {
  const w = setup();
  assert.equal(w.module.receive({ type: "seira:companion-e2e-redial" }), false);
  assert.equal(w.module.receive(undefined), false);
  await w.ask("explode", "work");
  assert.deepEqual(w.calls, []);
});

test("a switch that fails is logged, and the facts are sent again after it", async () => {
  const w = setup();
  w.profiles.open = async () => { throw new Error("no folder"); };
  w.module.initial();
  w.facts = [{ id: "local", current: true, state: "unavailable" }, { id: "work", current: false, state: "ready" }];
  await w.ask("open", "work");
  assert.match(w.logs[0], /open failed \(no folder\)/);
  assert.equal(w.sent.length, 1);
});
