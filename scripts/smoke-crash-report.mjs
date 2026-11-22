// Real-Electron smoke test of the crash report client (AC-12, AC-13, AC-41, AC-46, AC-55).
// Run on a Linux host with xvfb: pnpm smoke:crash-report
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const childScript = path.join(root, "scripts", "smoke-crash-report.electron.mjs");
const PHASE_TIMEOUT_MS = 90_000;

const received = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/envelope") received.push({ at: Date.now(), body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const dir = mkdtempSync(path.join(tmpdir(), "seira-crash-smoke-"));
mkdirSync(path.join(dir, "dumps"), { recursive: true });
const canary = `CANARY-MEMORY-${randomBytes(12).toString("hex")}`;

function dumpFiles(folder = path.join(dir, "dumps"), found = []) {
  let entries = [];
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) dumpFiles(file, found);
    else if (entry.name.toLowerCase().endsWith(".dmp")) found.push(file);
  }
  return found;
}

function runPhase(phase, extraEnv) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      SMOKE_CRASH_DIR: dir,
      SEIRA_DATA_DIR: path.join(dir, "seira-dev"),
      SEIRA_PORT: "18799",
      ...extraEnv,
    };
    const startedAt = Date.now();
    const child = spawn("xvfb-run", ["-a", electronBinary, "--no-sandbox", childScript, phase], { env, cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, PHASE_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      resolve({ code, signal, timedOut, startedAt, endedAt: Date.now(), output });
    });
  });
}

function parse(entry) {
  const lines = entry.body.split("\n").filter((line) => line !== "");
  let item = null;
  let event = null;
  try { item = JSON.parse(lines[1]); event = JSON.parse(lines[2]); } catch {}
  return { lines, item, event, tags: event?.tags ?? {} };
}

const results = [];
const verdict = (ac, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${ac} ${detail}`); };
const loopbackEnv = { SEIRA_CRASH_REPORT_URL: `http://127.0.0.1:${port}/api/envelope` };
const tail = (run) => run.output.trim().split("\n").slice(-8).join("\n");

try {
  // Phase 1: renderer crash.
  let mark = received.length;
  const renderer = await runPhase("renderer", loopbackEnv);
  const rendererNew = received.slice(mark);
  const r = rendererNew[0] ? parse(rendererNew[0]) : null;
  const shapeOk = !!r && r.lines.length === 3 && r.item?.type === "event" && !/attachment|minidump/i.test(rendererNew[0].body);
  verdict("AC-13", rendererNew.length === 1 && r?.tags.kind === "native" && r?.tags.process === "renderer" && typeof r?.tags.reason === "string" && !renderer.timedOut,
    `envelopes=${rendererNew.length} tags=${JSON.stringify(r?.tags ?? {})} child_exit=${renderer.code ?? renderer.signal}`);
  verdict("AC-46 (renderer)", shapeOk, `lines=${r?.lines.length ?? "none"} item_type=${r?.item?.type ?? "none"} attachment_or_minidump_text=${rendererNew[0] ? /attachment|minidump/i.test(rendererNew[0].body) : "n/a"}`);
  if (renderer.timedOut || rendererNew.length !== 1) console.log(tail(renderer));

  // Phase 2: main process crash.
  mark = received.length;
  const crash = await runPhase("main-crash", { ...loopbackEnv, SMOKE_CANARY: canary });
  const dumpsBefore = dumpFiles().length;
  const abnormal = !crash.timedOut && (crash.signal !== null || (crash.code !== null && crash.code !== 0));
  verdict("AC-12 (crash half)", abnormal && dumpsBefore >= 1 && received.length === mark,
    `child_exit=${crash.code ?? crash.signal} dumps_after_crash=${dumpsBefore} new_envelopes=${received.length - mark}`);
  if (!abnormal || dumpsBefore < 1) console.log(tail(crash));

  // Phase 3: restart.
  mark = received.length;
  const restart = await runPhase("restart", loopbackEnv);
  const restartNew = received.slice(mark);
  const m = restartNew[0] ? parse(restartNew[0]) : null;
  const dumpsAfter = dumpFiles().length;
  const canaryFound = received.some((entry) => entry.body.includes(canary));
  const seconds = restartNew[0] ? Math.round((restartNew[0].at - restart.startedAt) / 100) / 10 : null;
  verdict("AC-12", restartNew.length === 1 && m?.tags.kind === "native" && m?.tags.process === "main" && m?.tags.reason === "crashed" && seconds !== null && seconds <= 60,
    `envelopes=${restartNew.length} tags=${JSON.stringify(m?.tags ?? {})} seconds_to_report=${seconds}`);
  verdict("AC-41", !canaryFound, `canary_found=${canaryFound ? "yes" : "no"} bodies_checked=${received.length}`);
  verdict("AC-46", dumpsAfter === 0 && !!m && m.lines.length === 3 && m.item?.type === "event" && !/attachment|minidump/i.test(restartNew[0].body),
    `dumps_before=${dumpsBefore} dumps_after=${dumpsAfter} lines=${m?.lines.length ?? "none"}`);
  if (restartNew.length !== 1) console.log(tail(restart));

  // Phase 4: a non-loopback endpoint is refused.
  mark = received.length;
  const foreign = await runPhase("foreign-url", { SEIRA_CRASH_REPORT_URL: "http://192.0.2.1/api/envelope" });
  verdict("AC-55", received.length === mark && !foreign.timedOut && foreign.code === 0,
    `loopback_requests=${received.length - mark} child_exit=${foreign.code ?? foreign.signal} timed_out=${foreign.timedOut}`);
  if (foreign.timedOut || foreign.code !== 0) console.log(tail(foreign));
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
