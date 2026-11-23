import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRemoteVisor, REMOTE_KILL_GRACE_MS, REMOTE_LINE_LIMIT, REMOTE_READY_MS } from "./glance-remote-visor.mjs";

function world(extra = {}) {
  const spawns = [], timers = [], fails = [], acts = [], made = [];
  const make = () => {
    const child = Object.assign(new EventEmitter(), { written: [], kills: [], exitCode: null, signalCode: null, ended: 0 });
    child.stdin = Object.assign(new EventEmitter(), { write: (s) => child.written.push(JSON.parse(s)), end: () => child.ended++ });
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.kill = (sig) => child.kills.push(sig ?? "SIGTERM");
    return child;
  };
  const remote = createRemoteVisor({
    spawn: (...a) => { const c = make(); spawns.push({ args: a, child: c }); return c; },
    execPath: "/opt/seira", appArgs: ["/app"], switches: ["--no-sandbox"], env: { A: "1", ELECTRON_RUN_AS_NODE: "1" },
    onAct: async (act) => { acts.push(act); return act.ok ?? true; }, onFail: () => fails.push(1),
    setTimer: (fn, ms) => { const t = { fn, ms, off: false, unref() {} }; timers.push(t); return t; }, clearTimer: (t) => { t.off = true; },
    folder: "/tmp-x/glance-helper", makeFolder: (f) => { made.push([spawns.length, f]); },
    ...extra,
  });
  const child = () => spawns.at(-1).child;
  const emit = (obj) => child().stdout.emit("data", `${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  return { remote, spawns, timers, fails, acts, child, emit, made };
}
const tick = () => new Promise((r) => setImmediate(r));

test("AC-01 AC-02 the helper starts with the X11 switch and the given args, without ELECTRON_RUN_AS_NODE", () => {
  const w = world();
  assert.equal(w.spawns.length, 0);
  w.remote.render({ entries: [] });
  const [exec, args, options] = w.spawns[0].args;
  assert.equal(exec, "/opt/seira");
  assert.deepEqual(args, ["/app", "--seira-glance-visor=/tmp-x/glance-helper", "--ozone-platform=x11", "--no-sandbox"]);
  assert.deepEqual(options.env, { A: "1" });
  assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
});

test("a render waits for ready, and only the latest command is sent", () => {
  const w = world();
  w.remote.render({ n: 1 });
  w.remote.render({ n: 2 });
  assert.equal(w.child().written.length, 0);
  w.emit({ t: "ready" });
  assert.deepEqual(w.child().written, [{ t: "render", payload: { n: 2 } }]);
  w.remote.hide();
  assert.deepEqual(w.child().written.at(-1), { t: "hide" });
  assert.equal(w.remote.visible(), false);
  w.remote.render({ n: 3 });
  assert.equal(w.remote.visible(), true);
  assert.equal(w.remote.contents(), null);
  assert.equal(w.remote.setSize({ width: 1, height: 1 }), false);
});

test("AC-05 an act line goes to onAct and the answer goes back", async () => {
  const w = world();
  w.remote.render({});
  w.emit({ t: "ready" });
  w.emit({ t: "act", id: "7", act: { ok: false } });
  await tick();
  assert.deepEqual(w.acts, [{ ok: false }]);
  assert.deepEqual(w.child().written.at(-1), { t: "acted", id: "7", ok: false });
  w.emit({ t: "act", id: "8", act: {} });
  await tick();
  assert.deepEqual(w.child().written.at(-1), { t: "acted", id: "8", ok: true });
});

test("AC-06 bad, unknown and oversized lines are ignored", async () => {
  const w = world();
  w.remote.render({});
  w.emit("not json");
  w.emit({ t: "explode" });
  w.emit({ t: "act", id: 5, act: {} });
  w.emit(JSON.stringify({ t: "act", id: "1", act: "x".repeat(REMOTE_LINE_LIMIT) }));
  await tick();
  assert.equal(w.acts.length, 0);
  assert.equal(w.child().written.length, 0);
  assert.equal(w.fails.length, 0);
});

test("AC-04 no ready in time kills the helper and reports once", () => {
  const w = world();
  w.remote.render({});
  const wait = w.timers.find((t) => t.ms === REMOTE_READY_MS);
  wait.fn();
  assert.deepEqual(w.child().kills, ["SIGTERM"]);
  assert.equal(w.fails.length, 1);
  w.timers.find((t) => t.ms === REMOTE_KILL_GRACE_MS).fn();
  assert.deepEqual(w.child().kills, ["SIGTERM", "SIGKILL"]);
  w.child().emit("exit", 1);
  assert.equal(w.fails.length, 1);
});

test("AC-09 a helper that ends after the stop signal is not killed hard", () => {
  const w = world();
  w.remote.render({});
  w.timers.find((t) => t.ms === REMOTE_READY_MS).fn();
  w.child().exitCode = 0;
  w.timers.find((t) => t.ms === REMOTE_KILL_GRACE_MS).fn();
  assert.deepEqual(w.child().kills, ["SIGTERM"]);
});

test("AC-04 ready in time stops the wait", () => {
  const w = world();
  w.remote.render({});
  w.emit({ t: "ready" });
  assert.equal(w.timers[0].off, true);
});

test("AC-04 an unexpected exit or error reports once", () => {
  const w = world();
  w.remote.render({});
  w.emit({ t: "ready" });
  w.child().emit("exit", 1);
  w.child().emit("error", new Error("x"));
  assert.equal(w.fails.length, 1);
});

test("AC-08 close ends the input, kills the helper and does not report", () => {
  const w = world();
  w.remote.render({});
  w.emit({ t: "ready" });
  const child = w.child();
  w.remote.close();
  assert.equal(child.ended, 1);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("exit", 0);
  assert.equal(w.fails.length, 0);
  assert.equal(w.remote.visible(), false);
});

test("a write to a closed pipe does not throw", () => {
  const w = world();
  w.remote.render({});
  w.emit({ t: "ready" });
  w.child().stdin.write = () => { throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); };
  assert.doesNotThrow(() => w.remote.render({ n: 1 }));
});

test("AC-09 the folder is made with the given path before spawn and passed as the flag value", () => {
  const w = world();
  w.remote.render({});
  assert.deepEqual(w.made, [[0, "/tmp-x/glance-helper"]]);
  assert.ok(w.spawns[0].args[1].includes("--seira-glance-visor=/tmp-x/glance-helper"));
});

test("AC-09 a second helper after a failure reuses the same folder", () => {
  const w = world();
  w.remote.render({});
  w.child().emit("exit", 1, null);
  assert.equal(w.fails.length, 1);
  const second = world();
  second.remote.render({});
  assert.deepEqual(second.made, w.made);
  assert.ok(second.spawns[0].args[1].includes("--seira-glance-visor=/tmp-x/glance-helper"));
});

test("AC-09 a makeFolder error reports a failure once and spawns nothing", () => {
  const w = world({ makeFolder: () => { throw new Error("no space"); } });
  w.remote.render({});
  w.remote.render({});
  assert.equal(w.spawns.length, 0);
  assert.equal(w.fails.length, 1);
});

test("AC-09 no folder is removed or made again on close or exit", () => {
  const w = world();
  w.remote.render({});
  const child = w.child();
  w.remote.close();
  child.emit("exit", 0, null);
  assert.equal(w.made.length, 1);
});
