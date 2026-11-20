import assert from "node:assert/strict";
import { test } from "node:test";

import { createStartupTimeline } from "./startup-timeline.mjs";

function setup(env = {}) {
  let clock = 0;
  const lines = [];
  const files = [];
  const timeline = createStartupTimeline({
    now: () => clock,
    env,
    writeFile: (file, text) => files.push([file, text]),
  });
  return { timeline, lines, files, at: (ms) => { clock = ms; }, log: (line) => lines.push(line) };
}

test("the log line lists the marks in the order they were recorded", () => {
  const t = setup();
  t.at(100.4); t.timeline.start(t.log);
  t.at(250.6); t.timeline.mark("splash-shown");
  t.at(900); t.timeline.finish("window-shown");
  assert.deepEqual(t.lines, ["startup timeline app-ready=100ms splash-shown=251ms window-shown=900ms"]);
});

test("a second mark with the same name is ignored", () => {
  const t = setup();
  t.timeline.start(t.log);
  t.at(10); t.timeline.mark("proxy");
  t.at(20); t.timeline.mark("proxy");
  assert.equal(t.timeline.snapshot().proxy, 10);
});

test("finish runs once and later marks are ignored", () => {
  const t = setup({ SEIRA_STARTUP_TIMELINE: "/tmp/timeline.json" });
  t.timeline.start(t.log);
  t.at(5); t.timeline.finish("window-shown");
  t.at(6); t.timeline.mark("late");
  t.timeline.finish("window-shown");
  t.timeline.finish("other");
  assert.equal(t.lines.length, 1);
  assert.equal(t.files.length, 1);
  assert.equal("late" in t.timeline.snapshot(), false);
  assert.equal("other" in t.timeline.snapshot(), false);
});

test("an absolute path receives the JSON once", () => {
  const t = setup({ SEIRA_STARTUP_TIMELINE: "/tmp/timeline.json" });
  t.at(1); t.timeline.start(t.log);
  t.at(2); t.timeline.finish("window-shown");
  assert.deepEqual(t.files, [["/tmp/timeline.json", JSON.stringify({ marks: { "app-ready": 1, "window-shown": 2 } })]]);
});

test("an empty, missing or relative path writes nothing", () => {
  for (const env of [{}, { SEIRA_STARTUP_TIMELINE: "" }, { SEIRA_STARTUP_TIMELINE: "timeline.json" }, { SEIRA_STARTUP_TIMELINE: "./a/b.json" }]) {
    const t = setup(env);
    t.timeline.start(t.log);
    t.timeline.finish("window-shown");
    assert.equal(t.files.length, 0);
    assert.equal(t.lines.length, 1);
  }
});

test("a throwing log or file write does not escape finish", () => {
  const timeline = createStartupTimeline({
    now: () => 1,
    env: { SEIRA_STARTUP_TIMELINE: "/tmp/timeline.json" },
    writeFile: () => { throw new Error("disk full"); },
  });
  timeline.start(() => { throw new Error("log closed"); });
  assert.doesNotThrow(() => timeline.finish("window-shown"));
});
