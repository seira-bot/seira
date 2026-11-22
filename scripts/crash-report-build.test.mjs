import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crashReportConfig, writeCrashReportConfig } from "./crash-report-build.mjs";

const folders = [];
const file = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "seira-crash-build-"));
  folders.push(folder);
  return path.join(folder, "electron", "crash-report.json");
};
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

describe("crashReportConfig", () => {
  it("takes an https address and names the environment, with production as the default", () => {
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "https://127.0.0.1:9/api/envelope" })).toEqual({ url: "https://127.0.0.1:9/api/envelope", environment: "production" });
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: " https://127.0.0.1:9/x ", SEIRA_CRASH_REPORT_ENVIRONMENT: "staging" })?.environment).toBe("staging");
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "https://127.0.0.1:9/x", SEIRA_CRASH_REPORT_ENVIRONMENT: "bad value!" })?.environment).toBe("production");
  });

  it("gives no config for no address, an address that is not https, or an address that is not valid", () => {
    expect(crashReportConfig({})).toBeNull();
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "" })).toBeNull();
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "http://127.0.0.1:9/x" })).toBeNull();
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "not a url" })).toBeNull();
    expect(crashReportConfig({ SEIRA_CRASH_REPORT_URL: "https://user:pass@127.0.0.1:9/x" })).toBeNull();
  });
});

describe("writeCrashReportConfig", () => {
  it("writes the config file when the build has an address", () => {
    const target = file();
    expect(writeCrashReportConfig({ env: { SEIRA_CRASH_REPORT_URL: "https://127.0.0.1:9/api/envelope", SEIRA_CRASH_REPORT_ENVIRONMENT: "beta" }, file: target })).toBe("written");
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ url: "https://127.0.0.1:9/api/envelope", environment: "beta" });
  });

  it("deletes a file from an earlier build when this build has no address (AC-54)", () => {
    const target = file();
    writeCrashReportConfig({ env: { SEIRA_CRASH_REPORT_URL: "https://127.0.0.1:9/x" }, file: target });
    expect(fs.existsSync(target)).toBe(true);
    expect(writeCrashReportConfig({ env: {}, file: target })).toBe("removed");
    expect(fs.existsSync(target)).toBe(false);
    expect(writeCrashReportConfig({ env: { SEIRA_CRASH_REPORT_URL: "http://127.0.0.1:9/x" }, file: target })).toBe("removed");
  });
});
