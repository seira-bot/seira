import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionWorkspaces, WORKSPACES_MESSAGE, WORKSPACE_SWITCH_MESSAGE, WORKSPACE_SWITCH_RESULT_MESSAGE } from "./companion-workspaces.mjs";

function setup({ facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "ready" }], settling = null } = {}) {
  const w = { facts, settling, calls: [], sent: [], running: true, order: [] };
  // The fake keeps the same rule as the real profiles: each turn change names its cause (a request object, or none for the rail),
  // and `takenBy` answers who took the turn of a request: undefined while nobody did, null for the rail, else the request.
  let holder = null;
  const taken = new WeakMap();
  const objectOrNull = (value) => (value !== null && typeof value === "object" ? value : null);
  w.refuses = (id, hurryTurn) => hurryTurn !== undefined && !(w.settling && w.settling.id === id && w.settling.turn === hurryTurn);
  w.bump = (cause) => { const before = holder; holder = objectOrNull(cause); if (before && !taken.has(before)) taken.set(before, holder); };
  w.profiles = {
    phoneFacts: () => w.facts,
    settling: () => w.settling,
    // A hurry names the wait it means (its turn). Like the real profiles, the fake refuses it, and changes no turn, unless that
    // wait is still the waiting one.
    open: async (id, cause, hurryTurn) => { if (w.refuses(id, hurryTurn)) return false; w.bump(cause); w.order.push("open"); w.calls.push(["open", id]); },
    computer: async (cause, hurryTurn) => { if (w.refuses(null, hurryTurn)) return false; w.bump(cause); w.calls.push(["computer"]); },
    cancel: (cause) => { w.bump(cause); w.calls.push(["cancel"]); },
    takenBy: (cause) => (objectOrNull(cause) && taken.has(cause) ? taken.get(cause) : undefined),
  };
  w.module = createCompanionWorkspaces({ profiles: w.profiles, post: (message) => { w.sent.push(message); return w.running; }, settled: async () => { w.order.push("settled"); await w.hold; }, log: (line) => (w.logs ??= []).push(line) });
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

const OPERATION = "0123456789abcdef0123456789abcdef";
const results = (w) => w.sent.filter((message) => message.type === WORKSPACE_SWITCH_RESULT_MESSAGE);
const askWith = async (w, action, id, operation) => { w.module.receive({ type: WORKSPACE_SWITCH_MESSAGE, action, id, operation }); await new Promise((resolve) => setImmediate(resolve)); };

test("a switch that names an operation is answered with how it ended: done once the workspace opened", async () => {
  const w = setup();
  await askWith(w, "open", "work", OPERATION);
  assert.deepEqual(results(w), [{ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id: OPERATION, outcome: "done" }]);
});

test("a cancel and a hurry end as done, and a request that did nothing ends as failed", async () => {
  const cancel = setup({ settling: { id: "work", name: "Scout" } });
  await askWith(cancel, "cancel", "local", OPERATION);
  assert.equal(results(cancel)[0].outcome, "done");
  const hurry = setup({ facts: [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }], settling: { id: "work", name: "Scout" } });
  await askWith(hurry, "hurry", "work", OPERATION);
  assert.equal(results(hurry)[0].outcome, "done");
  const wrong = setup({ settling: { id: "home", name: "Scout" } });
  await askWith(wrong, "hurry", "work", OPERATION);
  await askWith(wrong, "open", "nope", OPERATION);
  assert.deepEqual(results(wrong).map((message) => message.outcome), ["failed", "failed"]);
  const unavailable = setup({ facts: [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }] });
  await askWith(unavailable, "open", "work", OPERATION);
  assert.equal(results(unavailable)[0].outcome, "failed");
});

test("a workspace that did not open ends as failed, one that a newer switch took over as superseded, and a crash as failed", async () => {
  const w = setup();
  w.profiles.open = async () => false;
  await askWith(w, "open", "work", OPERATION);
  w.profiles.open = async () => null;
  await askWith(w, "open", "work", OPERATION);
  w.profiles.open = async () => { throw new Error("no way"); };
  await askWith(w, "open", "work", OPERATION);
  assert.deepEqual(results(w).map((message) => message.outcome), ["failed", "superseded", "failed"]);
  assert.match(w.logs.join("\n"), /open failed \(no way\)/);
});

test("the answer comes after the facts, so the phone reads the new list before it reads the result", async () => {
  const w = setup();
  w.profiles.open = async () => { w.facts = [{ id: "local", current: false, state: "ready" }, { id: "work", current: true, state: "ready" }]; };
  await askWith(w, "open", "work", OPERATION);
  assert.deepEqual(w.sent.map((message) => message.type), [WORKSPACES_MESSAGE, WORKSPACE_SWITCH_RESULT_MESSAGE]);
});

test("a request with no operation id, or one that is not an id, sends no result and works as before", async () => {
  const w = setup();
  for (const operation of [undefined, 7, "", "short", "G".repeat(32), "../etc/passwd", OPERATION.toUpperCase()]) await askWith(w, "open", "work", operation);
  assert.equal(results(w).length, 0);
  assert.equal(w.calls.length, 7);
});

test("a companion that is gone does not break the switch: the result is dropped and logged only when it throws", async () => {
  const w = setup();
  w.running = false;
  await askWith(w, "open", "work", OPERATION);
  assert.deepEqual(w.calls, [["open", "work"]]);
  const broken = setup();
  const module = createCompanionWorkspaces({ profiles: broken.profiles, post: () => { throw new Error("pipe closed"); }, log: (line) => (broken.logs ??= []).push(line) });
  module.receive({ type: WORKSPACE_SWITCH_MESSAGE, action: "open", id: "work", operation: OPERATION });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(broken.logs.join("\n"), /could not report a switch \(pipe closed\)/);
});

// A result names the switch that ended, and only that one.
const OP_A = "a".repeat(32), OP_B = "b".repeat(32), OP_C = "c".repeat(32), OP_H = "d".repeat(32);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const FACTS_3 = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "ready" }, { id: "home", current: false, state: "ready" }];
/** Each `open(id)` waits for its own gate, so a test ends each switch when it wants. */
function held() {
  const w = setup({ facts: FACTS_3 });
  w.gates = [];
  w.profiles.open = async (id, cause, hurryTurn) => { if (w.refuses(id, hurryTurn)) return false; w.bump(cause); const g = gate(); w.gates.push({ id, ...g }); return g.promise; };
  w.rail = () => w.bump(undefined); // the rail starts or cancels a switch itself: no phone request is its cause
  w.start = async (action, id, operation) => { w.module.receive({ type: WORKSPACE_SWITCH_MESSAGE, action, id, operation }); await tick(); };
  return w;
}
const reported = (w) => results(w).map((message) => [message.id, message.outcome]);

test("a cancel that cancelled the waiting switch ends that switch as cancelled, by its id", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.settling = { id: "work", name: "Scout" };
  await w.start("cancel", "local", OP_C);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_C, "done"], [OP_A, "cancelled"]]);
});

test("a later cancel that cancelled nothing does not change a switch that ended otherwise", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  await w.start("open", "home", OP_B);
  w.gates[0].resolve(null);
  await tick();
  w.settling = null;
  await w.start("cancel", "local", OP_C);
  assert.deepEqual(reported(w), [[OP_A, "superseded"], [OP_C, "done"]]);
  assert.deepEqual(w.calls.filter(([name]) => name === "cancel"), [], "nothing waited, so nothing was cancelled");
});

test("the first request that took the turn is the cause, so a cancel after a newer switch does not turn superseded into cancelled", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  await w.start("open", "home", OP_B);
  w.settling = { id: "home", name: "Scout" };
  await w.start("cancel", "local", OP_C);
  w.gates[0].resolve(null);
  w.gates[1].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_C, "done"], [OP_A, "superseded"], [OP_B, "cancelled"]]);
});

test("a switch that the rail took over ends as superseded, and a cancel of the rail's own switch names no phone switch", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_A, "superseded"]]);
  w.settling = { id: "home", name: "Scout" };
  await w.start("cancel", "local", OP_C);
  assert.deepEqual(reported(w), [[OP_A, "superseded"], [OP_C, "done"]]);
});

test("a hurry that fails ends the hurried switch as failed, and does not touch a switch for another workspace", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.settling = { id: "work", name: "Scout" };
  await w.start("hurry", "work", OP_H);
  await w.start("open", "home", OP_B);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [], "the hurried switch waits for the hurry to end");
  w.gates[1].resolve(false);
  await tick();
  assert.deepEqual(reported(w), [[OP_H, "failed"], [OP_A, "failed"]]);
  assert.equal(results(w).some((message) => message.id === OP_B), false, "the switch for another workspace got no result");
});

test("a hurry that reports before the hurried switch does ends it with the hurry's outcome when its own end comes", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.settling = { id: "work", name: "Scout" };
  await w.start("hurry", "work", OP_H);
  w.gates[1].resolve(true);
  await tick();
  assert.deepEqual(reported(w), [[OP_H, "done"]]);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_H, "done"], [OP_A, "done"]]);
});

test("a hurry that a newer switch takes over ends the hurried switch as that one ends", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.settling = { id: "work", name: "Scout" };
  await w.start("hurry", "work", OP_H);
  await w.start("open", "home", OP_B);
  w.gates[0].resolve(null);
  w.gates[1].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_H, "superseded"], [OP_A, "superseded"]]);
});

test("a rail action that replaced a phone switch is the cause, so a later phone cancel does not take the credit", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.rail();
  w.settling = { id: "home", name: "Scout" };
  await w.start("cancel", "local", OP_C);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_C, "done"], [OP_A, "superseded"]]);
});

test("a rail action that replaced a phone switch is the cause, so a later phone open for the same workspace does not carry it on", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  w.rail();
  await w.start("open", "work", OP_B);
  w.gates[0].resolve(null);
  await tick();
  assert.deepEqual(reported(w), [[OP_A, "superseded"]], "the first switch ends now and does not wait for the later request");
  w.gates[1].resolve(true);
  await tick();
  assert.deepEqual(reported(w), [[OP_A, "superseded"], [OP_B, "done"]]);
});

test("phone and rail actions in a row: each switch ends by its own cause and operation id", async () => {
  const w = held();
  await w.start("open", "work", OP_A);
  await w.start("open", "home", OP_B);
  w.rail();
  w.settling = { id: "home", name: "Scout" };
  await w.start("cancel", "local", OP_C);
  for (const g of w.gates) g.resolve(null);
  await tick();
  assert.deepEqual(reported(w).sort(), [[OP_A, "superseded"], [OP_B, "superseded"], [OP_C, "done"]].sort());
});

test("a hurry names the wait it means, and the profiles refuse it after the wait when another switch replaced that wait", async () => {
  const facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }, { id: "home", current: false, state: "ready" }];
  const w = setup({ facts, settling: { id: "work", name: "Scout", turn: 1 } });
  let release;
  w.hold = new Promise((resolve) => { release = resolve; });
  await askWith(w, "hurry", "work", OP_H);
  w.settling = { id: "home", name: "Scout", turn: 2 }; // the rail started another switch during the wait
  release();
  await tick();
  assert.deepEqual(w.calls, [], "the hurry opened nothing");
  assert.deepEqual(reported(w), [[OP_H, "failed"]]);
});

test("a hurry names the wait it means: a new switch for the same workspace is another wait, so the hurry is refused", async () => {
  const facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }];
  const w = setup({ facts, settling: { id: "work", name: "Scout", turn: 1 } });
  let release;
  w.hold = new Promise((resolve) => { release = resolve; });
  await askWith(w, "hurry", "work", OP_H);
  w.settling = { id: "work", name: "Scout", turn: 2 };
  release();
  await tick();
  assert.deepEqual(w.calls, []);
  assert.deepEqual(reported(w), [[OP_H, "failed"]]);
  const none = setup({ facts, settling: { id: "work", name: "Scout", turn: 1 } });
  let free;
  none.hold = new Promise((resolve) => { free = resolve; });
  await askWith(none, "hurry", "work", OP_H);
  none.settling = null;
  free();
  await tick();
  assert.deepEqual(none.calls, [], "the switch ended during the wait, so nothing is hurried");
});

test("a hurry that finds the same wait after the wait still opens the workspace, and passes the turn it saw", async () => {
  const facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }];
  const w = setup({ facts, settling: { id: "work", name: "Scout", turn: 4 } });
  let release;
  w.hold = new Promise((resolve) => { release = resolve; });
  await askWith(w, "hurry", "work", OP_H);
  release();
  await tick();
  assert.deepEqual(w.calls, [["open", "work"]]);
  assert.deepEqual(reported(w), [[OP_H, "done"]]);
});

test("the turn a hurry carries is the one it saw before the wait, not one read again after it", async () => {
  const facts = [{ id: "local", current: true, state: "ready" }, { id: "work", current: false, state: "waiting" }];
  const w = setup({ facts, settling: { id: "work", name: "Scout", turn: 7 } });
  const seen = [];
  const open = w.profiles.open;
  w.profiles.open = async (id, cause, hurryTurn) => { seen.push(hurryTurn); return open(id, cause, hurryTurn); };
  let release;
  w.hold = new Promise((resolve) => { release = resolve; });
  await askWith(w, "hurry", "work", OP_H);
  w.settling = { id: "work", name: "Scout", turn: 8 }; // an older and a newer record look alike: same id, same name
  release();
  await tick();
  assert.deepEqual(seen, [7]);
  assert.deepEqual(w.calls, [], "the profiles refused it");
  assert.deepEqual(reported(w), [[OP_H, "failed"]]);
  const plain = setup();
  const turns = [];
  const plainOpen = plain.profiles.open;
  plain.profiles.open = async (id, cause, hurryTurn) => { turns.push(hurryTurn); return plainOpen(id, cause, hurryTurn); };
  await askWith(plain, "open", "work", OP_A);
  assert.deepEqual(turns, [undefined], "an open names no wait to hurry");
});
