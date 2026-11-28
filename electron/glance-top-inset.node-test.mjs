import assert from "node:assert/strict";
import test from "node:test";
import { resolveTopInset, TOP_INSET_MAX, PROBE_WAIT_MS } from "./glance-top-inset.mjs";

const wrong = { bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
const hypr = { HYPRLAND_INSTANCE_SIGNATURE: "sig" };
const sway = { SWAYSOCK: "/run/sway.sock" };
const monitors = (...list) => JSON.stringify(list.map(([x, y, top, focused = false]) => ({ x, y, focused, reserved: [0, top, 0, 0] })));
const fixed = (out) => { const calls = []; const run = async (cmd, args) => { calls.push([cmd, ...args]); return out; }; run.calls = calls; return run; };
const never = () => new Promise(() => {});

test("non-linux and a real work area give 0 without probing", async () => {
  const run = fixed(monitors([0, 0, 35]));
  assert.equal(await resolveTopInset({ platform: "darwin", env: { ...hypr, SEIRA_GLANCE_TOP_INSET: "20" }, display: wrong, run }), 0);
  assert.equal(await resolveTopInset({ platform: "win32", env: hypr, display: wrong, run }), 0);
  const real = { bounds: wrong.bounds, workArea: { ...wrong.workArea, y: 30 } };
  assert.equal(await resolveTopInset({ platform: "linux", env: { ...hypr, SEIRA_GLANCE_TOP_INSET: "20" }, display: real, run }), 0);
  assert.deepEqual(run.calls, []);
});

test("SEIRA_GLANCE_TOP_INSET beats probing; invalid values are ignored", async () => {
  const run = fixed(monitors([0, 0, 35]));
  assert.equal(await resolveTopInset({ platform: "linux", env: { ...hypr, SEIRA_GLANCE_TOP_INSET: "50" }, display: wrong, run }), 50);
  assert.equal(await resolveTopInset({ platform: "linux", env: { SEIRA_GLANCE_TOP_INSET: "0" }, display: wrong, run }), 0);
  assert.equal(await resolveTopInset({ platform: "linux", env: { SEIRA_GLANCE_TOP_INSET: String(TOP_INSET_MAX) }, display: wrong, run }), TOP_INSET_MAX);
  assert.deepEqual(run.calls, []);
  for (const bad of ["-1", "401", "1e6", "3.5", "abc", "", " ", "0x10"]) {
    assert.equal(await resolveTopInset({ platform: "linux", env: { ...hypr, SEIRA_GLANCE_TOP_INSET: bad }, display: wrong, run }), 35, bad);
  }
  assert.equal(await resolveTopInset({ platform: "linux", env: { SEIRA_GLANCE_TOP_INSET: "abc" }, display: wrong, run }), 0);
});

test("Hyprland: reserved top of the monitor that matches the display", async () => {
  const run = fixed(monitors([0, 0, 35]));
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: wrong, run }), 35);
  assert.deepEqual(run.calls, [["hyprctl", "monitors", "-j"]]);
});

test("Hyprland: two monitors with different reserved values", async () => {
  const run = fixed(monitors([0, 0, 35, true], [1920, 0, 60]));
  const second = { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: second, run }), 60);
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: wrong, run }), 35);
});

test("Hyprland: no matching monitor falls back to the focused one", async () => {
  const run = fixed(monitors([0, 0, 35], [3000, 0, 60, true]));
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: wrong, run }), 35);
  const odd = { bounds: { x: 100, y: 100, width: 800, height: 600 }, workArea: { x: 100, y: 100, width: 800, height: 600 } };
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: odd, run }), 60);
});

test("Hyprland: an out-of-range or odd reserved value gives null", async () => {
  for (const top of [-5, 9999, 12.5, "x", null]) {
    assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: wrong, run: fixed(JSON.stringify([{ x: 0, y: 0, focused: true, reserved: [0, top, 0, 0] }])) }), null, String(top));
  }
  assert.equal(await resolveTopInset({ platform: "linux", env: hypr, display: wrong, run: fixed(JSON.stringify([{ x: 0, y: 0, focused: true }])) }), null);
});

const workspaces = (...list) => JSON.stringify(list.map(([x, y, focused, visible = true]) => ({ focused, visible, rect: { x, y, width: 1920, height: 1100 } })));

test("Sway: the focused workspace's rect.y minus the output y", async () => {
  const run = fixed(workspaces([0, 28, true]));
  assert.equal(await resolveTopInset({ platform: "linux", env: sway, display: wrong, run }), 28);
  assert.deepEqual(run.calls, [["swaymsg", "-t", "get_workspaces"]]);
});

test("Sway: two outputs pick the workspace on the display; a plain output gives 0", async () => {
  const run = fixed(workspaces([0, 28, true], [1920, 40, false]));
  const second = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  assert.equal(await resolveTopInset({ platform: "linux", env: sway, display: second, run }), 40);
  assert.equal(await resolveTopInset({ platform: "linux", env: sway, display: wrong, run: fixed(workspaces([0, 0, true])) }), 0);
  const offset = { bounds: { x: 0, y: 100, width: 1920, height: 1080 }, workArea: { x: 0, y: 100, width: 1920, height: 1080 } };
  assert.equal(await resolveTopInset({ platform: "linux", env: sway, display: offset, run: fixed(workspaces([0, 130, true])) }), 30);
});

test("Hyprland is tried before Sway", async () => {
  const run = fixed(monitors([0, 0, 35]));
  assert.equal(await resolveTopInset({ platform: "linux", env: { ...hypr, ...sway }, display: wrong, run }), 35);
  assert.equal(run.calls.length, 1);
});

test("a failing probe, bad JSON, a missing binary or a timeout give null, never 0, and never throw", async () => {
  const base = { platform: "linux", display: wrong };
  assert.equal(await resolveTopInset({ ...base, env: hypr, run: async () => { throw new Error("ENOENT"); } }), null);
  assert.equal(await resolveTopInset({ ...base, env: hypr, run: fixed("not json") }), null);
  assert.equal(await resolveTopInset({ ...base, env: hypr, run: fixed("{}") }), null);
  assert.equal(await resolveTopInset({ ...base, env: sway, run: fixed("[]") }), null);
  assert.equal(await resolveTopInset({ ...base, env: hypr, run: () => { throw new Error("sync"); } }), null);
  assert.equal(await resolveTopInset({ ...base, env: hypr, run: never, timeoutMs: 20 }), null);
});

test("no compositor to ask is a real 0", async () => {
  assert.equal(await resolveTopInset({ platform: "linux", env: {}, display: wrong, run: fixed("x") }), 0);
});

test("the probe waits 1500 ms by default", () => {
  assert.equal(PROBE_WAIT_MS, 1500);
});

test("a failing Hyprland probe still lets Sway answer", async () => {
  const run = async (cmd) => { if (cmd === "hyprctl") throw new Error("x"); return workspaces([0, 28, true]); };
  assert.equal(await resolveTopInset({ platform: "linux", env: { ...hypr, ...sway }, display: wrong, run }), 28);
});
