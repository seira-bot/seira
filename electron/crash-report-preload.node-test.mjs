import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { CRASH_REPORTS_ARG } from "./crash-report.mjs";

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const MAIN = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const LOCAL = "http://127.0.0.1:8799";

function page(origin, answer, { endpoint = true } = {}) {
  let bridge;
  const sent = [], invoked = [], asked = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "linux", argv: [`--seira-local-origin=${LOCAL}`, "--seira-company-desktop=1", ...(endpoint ? [CRASH_REPORTS_ARG] : [])] },
    location: { origin }, navigator: { userActivation: { isActive: false } }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send: (...args) => sent.push(args), invoke: (...args) => { invoked.push(args); return Promise.resolve(); },
        sendSync: (channel) => { asked.push(channel); if (channel === "desktop-crash-reports:read") { if (answer instanceof Error) throw answer; return answer; } return undefined; } } }),
  });
  return { crashReports: bridge.crashReports, sent, invoked, asked };
}

test("this computer's page gets the crash report bridge only when the build has an endpoint", () => {
  const on = page(LOCAL, true);
  assert.equal(on.crashReports.available, true);
  assert.deepEqual(on.asked, [], "the page loads without a sync call to main");
  assert.equal(on.crashReports.enabled(), true);
  assert.equal(on.crashReports.enabled(), true);
  assert.deepEqual(on.asked, ["desktop-crash-reports:read"], "the switch is read once, on first use");
  assert.equal(page(LOCAL, false).crashReports.enabled(), false);
  for (const answer of [true, false, null]) {
    const off = page(LOCAL, answer, { endpoint: false });
    assert.deepEqual({ ...off.crashReports }, { available: false });
    assert.deepEqual(off.asked, []);
  }
});

test("AC-05: a switch value that cannot be read counts as off", () => {
  for (const answer of [null, undefined, "yes", 1, new Error("no handler")]) assert.equal(page(LOCAL, answer).crashReports.enabled(), false);
});

test("a server added in the Server menu and My Cloud get no crash report bridge at all", () => {
  assert.equal(page("https://bots.example.test", true).crashReports, undefined);
  assert.equal(page("https://home-7f3k2.fly.dev", true).crashReports, undefined);
});

test("the bridge cuts what it sends and sends only the fields main reads", () => {
  const { crashReports, sent, invoked } = page(LOCAL, true);
  crashReports.set("yes");
  assert.deepEqual(invoked, [["desktop-crash-reports:set", false]], "only true turns it on");
  assert.equal(crashReports.enabled(), false);
  crashReports.report({ kind: "renderer-error", errorName: "TypeError", message: "m".repeat(30000), stack: "s", page: "chat", extra: "canary", debugIds: { "a.js": "id", "b.js": 5 } });
  const [channel, payload] = sent.at(-1);
  assert.equal(channel, "desktop-crash-reports:renderer");
  assert.deepEqual(Object.keys(payload).sort(), ["debugIds", "errorName", "kind", "message", "page", "stack"]);
  assert.equal(payload.message.length, 20000);
  assert.deepEqual({ ...payload.debugIds }, { "a.js": "id" });
  assert.doesNotThrow(() => crashReports.report(null));
  crashReports.page("settings");
  assert.deepEqual(sent.at(-1), ["desktop-crash-reports:page", "settings"]);
  assert.doesNotThrow(() => crashReports.page({}));
});

test("main wires crash reports: the module, the hang hook, the server messages and the line budget", () => {
  assert.match(MAIN, /from "\.\/crash-report\.mjs"/);
  assert.match(MAIN, /createCrashReports\(\{/);
  assert.match(MAIN, /onHang: /);
  assert.match(MAIN, /crashReports\.receive\(proc, message\)/);
  assert.match(MAIN, /crashReports\.serverExit\(proc, code\)/);
  assert.match(MAIN, /crashReports\.stopping\(proc\)/);
  assert.match(MAIN, /crashReportIds: crashReports\.crashReportIds\(\)/);
  assert.equal(MAIN.match(/\.\.\.\(crashReports\.available \? \[CRASH_REPORTS_ARG\] : \[\]\)/g)?.length, 2, "the main window and the rail get the flag");
  assert.ok(MAIN.split("\n").length <= 3135 + 1, "main.mjs stays inside the file size limit");
});
