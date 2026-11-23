import assert from "node:assert/strict";
import test from "node:test";

import { loadCrashReportConfig } from "./crash-report-config.mjs";

const file = (value) => () => (typeof value === "string" ? value : JSON.stringify(value));
const missing = () => { throw Object.assign(new Error("no file"), { code: "ENOENT" }); };
const packaged = { isPackaged: true };
const debug = { isPackaged: false };

test("AC-54: no file, an unreadable file or a file without a valid https url keeps crash reporting off", () => {
  for (const read of [missing, file("{not json"), file({}), file({ url: 42 }), file({ url: "http://reports.example.test/in" }),
    file({ url: "https://user:secret@reports.example.test/in" }), file({ url: "ftp://reports.example.test/in" }), file({ url: "not a url" }), file("null"), file("[]")]) {
    assert.equal(loadCrashReportConfig({ app: packaged, env: {}, read }), null);
    assert.equal(loadCrashReportConfig({ app: debug, env: {}, read }), null);
  }
});

test("a build with an https url reports to it, in the environment the build named", () => {
  const read = file({ url: "https://reports.example.test/in", environment: "production" });
  assert.deepEqual(loadCrashReportConfig({ app: packaged, env: {}, read }), { url: "https://reports.example.test/in", environment: "production" });
  assert.equal(loadCrashReportConfig({ app: packaged, env: {}, read: file({ url: "https://reports.example.test/in" }) }).environment, "production");
  assert.equal(loadCrashReportConfig({ app: packaged, env: {}, read: file({ url: "https://reports.example.test/in", environment: "Bad Env!" }) }).environment, "production");
  assert.equal(loadCrashReportConfig({ app: packaged, env: {}, read: file({ url: "https://reports.example.test/in", environment: "staging" }) }).environment, "staging");
});

test("AC-55: a debug build reports only to a loopback url from its environment, whatever the file says", () => {
  const read = file({ url: "https://reports.example.test/in", environment: "production" });
  for (const url of ["http://127.0.0.1:4010/in", "http://localhost:4010/in", "http://[::1]:4010/in", "https://127.0.0.1:4010/in"]) {
    const config = loadCrashReportConfig({ app: debug, env: { SEIRA_CRASH_REPORT_URL: url }, read });
    assert.equal(new URL(config.url).origin, new URL(url).origin, url);
    assert.equal(config.environment, "development");
    assert.equal(loadCrashReportConfig({ app: debug, env: { SEIRA_CRASH_REPORT_URL: url }, read: missing }) !== null, true, "no file is needed");
  }
});

test("AC-55: a debug build ignores an environment value that is not loopback", () => {
  const read = file({ url: "https://reports.example.test/in", environment: "production" });
  for (const url of ["https://reports.example.test/other", "http://127.0.0.1.example.test/in", "http://10.0.0.5:4010/in", "http://user:pw@127.0.0.1/in", "ftp://127.0.0.1/in", "garbage", "http://localhost.example.test/in"]) {
    const config = loadCrashReportConfig({ app: debug, env: { SEIRA_CRASH_REPORT_URL: url }, read });
    assert.equal(config.url, "https://reports.example.test/in", url);
    assert.equal(loadCrashReportConfig({ app: debug, env: { SEIRA_CRASH_REPORT_URL: url }, read: missing }), null, url);
  }
});

test("AC-55: a packaged app ignores the environment value", () => {
  const env = { SEIRA_CRASH_REPORT_URL: "http://127.0.0.1:4010/in" };
  assert.equal(loadCrashReportConfig({ app: packaged, env, read: missing }), null);
  assert.equal(loadCrashReportConfig({ app: packaged, env, read: file({ url: "https://reports.example.test/in" }) }).url, "https://reports.example.test/in");
  assert.equal(loadCrashReportConfig({ app: {}, env, read: missing }) !== null, true, "an app that does not say it is packaged is a debug build");
});
