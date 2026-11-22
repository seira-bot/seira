// Decides at build time whether the desktop app can send crash reports. A build with SEIRA_CRASH_REPORT_URL (an https
// address) gets electron/crash-report.json. A build without it (a fork, `pnpm dev`, a local build) gets no file, so the
// app starts no reporting and shows no switch. The file is ignored by git, and this script prints no address.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = path.join(root, "electron", "crash-report.json");

/** The config of a build, or null when the build has no valid https address. */
export function crashReportConfig(env) {
  const raw = String(env.SEIRA_CRASH_REPORT_URL ?? "").trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  const named = String(env.SEIRA_CRASH_REPORT_ENVIRONMENT ?? "").trim();
  return { url: url.href, environment: /^[A-Za-z0-9._-]{1,64}$/.test(named) ? named : "production" };
}

/** Writes or deletes the config file. Returns what it did: "written" or "removed". */
export function writeCrashReportConfig({ env = process.env, file = CONFIG_FILE } = {}) {
  const config = crashReportConfig(env);
  if (!config) {
    rmSync(file, { force: true });
    return "removed";
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config)}\n`);
  return "written";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeCrashReportConfig();
  console.log(result === "written" ? "crash reports: this build can send them" : "crash reports: this build has no report service, so it sends none");
}
