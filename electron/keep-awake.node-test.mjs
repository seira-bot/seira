import assert from "node:assert/strict";
import test from "node:test";

import { reachableForKeepAwake } from "./keep-awake.mjs";

test("Keep this computer awake applies while the phone link runs or the person's other computers may open this one", () => {
  assert.equal(reachableForKeepAwake({ enabled: true }, { on: false }), true);
  assert.equal(reachableForKeepAwake({ enabled: false }, { on: true }), true, "the share alone: nothing paired, the phone link asleep");
  assert.equal(reachableForKeepAwake({ enabled: true, error: "port in use" }, { on: true }), true);
  assert.equal(reachableForKeepAwake({ enabled: true, error: "port in use" }, { on: false }), false);
  assert.equal(reachableForKeepAwake({ enabled: false }, { on: false }), false);
  assert.equal(reachableForKeepAwake({ enabled: false }, undefined), false);
});

import { createCompanionAwakeHold } from "./keep-awake.mjs";

function awakeHold({ battery = false } = {}) {
  const state = { battery, started: 0, stopped: 0, lines: [], listeners: {}, live: new Set() };
  const blocker = {
    start: () => { state.started += 1; state.live.add(state.started); return state.started; },
    stop: (id) => { state.stopped += 1; state.live.delete(id); },
    isStarted: (id) => state.live.has(id),
  };
  const monitor = { on: (event, listener) => { state.listeners[event] = listener; } };
  const hold = createCompanionAwakeHold({ blocker, isOnBattery: () => state.battery, log: (line) => state.lines.push(line) });
  hold.watch(monitor);
  return { state, hold };
}

test("the Phone link hold starts while wanted on power and does not start twice", () => {
  const { state, hold } = awakeHold();
  hold.want(true);
  hold.want(true);
  hold.look();
  assert.equal(hold.holding(), true);
  assert.equal(state.started, 1);
  assert.equal(state.lines.length, 1);
});

test("the Phone link hold releases on battery and holds again on power", () => {
  const { state, hold } = awakeHold();
  hold.want(true);
  state.battery = true;
  state.listeners["on-battery"]();
  assert.equal(hold.holding(), false);
  assert.equal(state.stopped, 1);
  assert.match(state.lines[1], /on battery/);
  state.battery = false;
  state.listeners["on-ac"]();
  assert.equal(hold.holding(), true);
  assert.equal(state.started, 2);
  assert.equal(state.lines.length, 3);
});

test("the Phone link hold does not start on battery, and releases when switched off", () => {
  const { state, hold } = awakeHold({ battery: true });
  hold.want(true);
  assert.equal(hold.holding(), false);
  assert.equal(state.started, 0);
  state.battery = false;
  state.listeners["on-ac"]();
  hold.want(false);
  assert.equal(hold.holding(), false);
  assert.equal(state.stopped, 1);
  assert.match(state.lines.at(-1), /off/);
  assert.equal(state.lines.length, 2);
});

test("a battery check that throws counts as on power", () => {
  const blocker = { start: () => 1, stop() {}, isStarted: () => true };
  const hold = createCompanionAwakeHold({ blocker, isOnBattery: () => { throw new Error("no power api"); } });
  hold.want(true);
  assert.equal(hold.holding(), true);
});
