#!/usr/bin/env -S node --experimental-strip-types
// Measures a released Seira server on this machine: install, start to healthy, idle memory and CPU, HTTP latency
// with oha, and the time Seira adds to a chat turn when the model answers at once. Each server gets a temporary
// data folder and port. No AI account is used. Needs only Node 24 and, for the HTTP part, oha on PATH.
//   node scripts/bench-server.ts [--version latest] [--seira CMD] [--runs 5] [--idle 180] [--turns 50] [--bots 10]
//     [--rounds 3] [--duration 20] [--rate 100] [--port 28799] [--out bench-server.json]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { arch, availableParallelism, cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    version: { type: "string", default: "latest" },
    seira: { type: "string" },
    runs: { type: "string", default: "5" },
    idle: { type: "string", default: "180" },
    turns: { type: "string", default: "50" },
    bots: { type: "string", default: "10" },
    rounds: { type: "string", default: "3" },
    duration: { type: "string", default: "20" },
    rate: { type: "string", default: "100" },
    port: { type: "string", default: "28799" },
    out: { type: "string", default: "bench-server.json" },
  },
});

const RUNS = Number(opt.runs), IDLE_S = Number(opt.idle), TURNS = Number(opt.turns), BOTS = Number(opt.bots);
const ROUNDS = Number(opt.rounds), DURATION_S = Number(opt.duration), RATE = Number(opt.rate), PORT = Number(opt.port);
const MOCK_PORT = PORT + 10;
const ROOT = mkdtempSync(join(tmpdir(), "seira-bench-"));
const CLK_TCK = 100;

type Stats = { p50: number; p95: number; p99: number; min: number; max: number; n: number };

function stats(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]!;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), min: round(sorted[0]!), max: round(sorted.at(-1)!), n: sorted.length };
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function duBytes(path: string): number {
  return Number(sh("du", ["-sb", path]).split(/\s+/)[0]);
}

function osName(): string {
  const line = readFileSync("/etc/os-release", "utf8").split("\n").find(l => l.startsWith("PRETTY_NAME="));
  return line ? line.slice(13).replace(/"/g, "") : "unknown";
}

function installRelease(): { seira: string; result: Record<string, unknown> } {
  const prefix = join(ROOT, "install");
  mkdirSync(prefix, { recursive: true });
  const spec = `@seira-bot/seira@${opt.version}`;
  const started = performance.now();
  sh("npm", ["install", "--prefix", prefix, "--cache", join(ROOT, "npm-cache"), "--no-audit", "--no-fund", "--loglevel", "error", spec]);
  const installMs = Math.round(performance.now() - started);
  const seira = join(prefix, "node_modules", ".bin", "seira");
  const pkg = JSON.parse(readFileSync(join(prefix, "node_modules", "@seira-bot", "seira", "package.json"), "utf8")) as { version: string };
  return {
    seira,
    result: {
      spec, version: pkg.version, installMs,
      installedBytes: duBytes(join(prefix, "node_modules")),
      packageBytes: duBytes(join(prefix, "node_modules", "@seira-bot", "seira")),
      downloadCacheBytes: duBytes(join(ROOT, "npm-cache")),
      packages: readdirSync(join(prefix, "node_modules")).filter(n => !n.startsWith(".")).length,
    },
  };
}

type Running = { child: ChildProcess; url: string; dataDir: string; startMs: number; log: string[] };

function writeBenchInstance(dataDir: string): void {
  const configFile = join(dataDir, "config.json");
  const current = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown> : {};
  const instances = { ...(current.instances as Record<string, unknown> | undefined), bench: {
    driver: "openai-compat", displayName: "Bench", environment: { BENCH_KEY: "bench" },
    config: { url: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKeyEnv: "BENCH_KEY", model: "bench-model" },
  } };
  writeFileSync(configFile, JSON.stringify({ ...current, instances }, null, 2));
}

async function answers(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
}

async function startServer(seira: string, dataDir: string): Promise<Running> {
  mkdirSync(dataDir, { recursive: true });
  const url = `http://127.0.0.1:${PORT}`;
  if (await answers(`${url}/api/health`)) throw new Error(`port ${PORT} already answers`);
  const log: string[] = [];
  const started = performance.now();
  const child = spawn(seira, ["serve", "--port", String(PORT), "--data-dir", dataDir], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SEIRA_DATA_DIR: dataDir, SEIRA_PORT: String(PORT), SEIRA_WEBHOOK_PORT: String(PORT + 1) },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { log.push(chunk.toString()); if (log.length > 200) log.shift(); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${log.join("").slice(-2_000)}`);
    if (await answers(`${url}/api/health`)) return { child, url, dataDir, startMs: Math.round(performance.now() - started), log };
    await delay(20);
  }
  throw new Error(`server not healthy in 120 s: ${log.join("").slice(-2_000)}`);
}

function groupPids(pgid: number): number[] {
  const pids: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) pids.push(Number(name));
    } catch { /* exited */ }
  }
  return pids;
}

function groupRssBytes(pgid: number): number {
  let kb = 0;
  for (const pid of groupPids(pgid)) {
    try { kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0); } catch { /* exited */ }
  }
  return kb * 1024;
}

function groupCpuTicks(pgid: number): number {
  let ticks = 0;
  for (const pid of groupPids(pgid)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(fields[11]) + Number(fields[12]);
    } catch { /* exited */ }
  }
  return ticks;
}

async function stopServer(running: Running): Promise<void> {
  const pgid = running.child.pid!;
  try { process.kill(-pgid, "SIGTERM"); } catch { /* gone */ }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && groupPids(pgid).length) await delay(50);
  if (groupPids(pgid).length) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
  while (await answers(`${running.url}/api/health`)) await delay(50);
}

async function measureStarts(seira: string): Promise<Record<string, unknown>> {
  const cold: number[] = [], warm: number[] = [];
  const warmDir = join(ROOT, "warm");
  for (let i = 0; i < RUNS; i++) {
    const running = await startServer(seira, join(ROOT, `cold-${i}`));
    cold.push(running.startMs);
    await stopServer(running);
  }
  await stopServer(await startServer(seira, warmDir));
  for (let i = 0; i < RUNS; i++) {
    const running = await startServer(seira, warmDir);
    warm.push(running.startMs);
    await stopServer(running);
  }
  return { coldStartMs: stats(cold), warmStartMs: stats(warm) };
}

type MockLog = { requests: Array<{ at: number; path: string; endAt?: number }> };

function startMock(): Promise<{ server: Server; log: MockLog }> {
  const log: MockLog = { requests: [] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const entry: MockLog["requests"][number] = { at: performance.now(), path: req.url ?? "" };
    log.requests.push(entry);
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      if (req.method === "GET" && entry.path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "bench-model", object: "model", owned_by: "bench" }] }));
        entry.endAt = performance.now();
        return;
      }
      if (!entry.path.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const stream = (() => { try { return (JSON.parse(body) as { stream?: boolean }).stream === true; } catch { return false; } })();
      const id = `chatcmpl-${log.requests.length}`, created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", created, model: "bench-model", usage,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }));
        entry.endAt = performance.now();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "bench-model", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: "OK" }, null));
      res.write(chunk({}, "stop", { usage }));
      res.end("data: [DONE]\n\n");
      entry.endAt = performance.now();
    });
  });
  return new Promise(done => server.listen(MOCK_PORT, "127.0.0.1", () => done({ server, log })));
}

type TurnEvents = { started: Map<string, number>; completed: Map<string, number> };

function followEvents(url: string, abort: AbortSignal): TurnEvents {
  const events: TurnEvents = { started: new Map(), completed: new Map() };
  void (async () => {
    const decoder = new TextDecoder();
    while (!abort.aborted) {
      try {
        const response = await fetch(`${url}/api/events?window=1`, { headers: { origin: url }, signal: abort });
        let buffered = "";
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffered += decoder.decode(chunk, { stream: true });
          for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
            const data = buffered.slice(0, end).split("\n").find(line => line.startsWith("data: "));
            buffered = buffered.slice(end + 2);
            if (!data) continue;
            const frame = JSON.parse(data.slice(6)) as { kind?: string; event?: { type?: string; threadId?: string } };
            const threadId = frame.event?.threadId;
            if (frame.kind !== "runtime" || !threadId) continue;
            if (frame.event?.type === "turn.started" && !events.started.has(threadId)) events.started.set(threadId, performance.now());
            if (frame.event?.type === "turn.completed") events.completed.set(threadId, performance.now());
          }
        }
      } catch { /* closed */ }
      if (!abort.aborted) await delay(100);
    }
  })();
  return events;
}

async function api(url: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function newBotThread(url: string, name: string): Promise<{ botId: string; threadId: string }> {
  const created = await api(url, "POST", "/api/bots", { name, modelSelection: { instanceId: "bench", model: "bench-model" } });
  const botId = String(created.bot.id);
  const task = await api(url, "POST", `/api/bots/${botId}/tasks`, { title: "Bench" });
  return { botId, threadId: String(task.task.threadId) };
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) return false; await delay(2); }
  return true;
}

async function measureTurns(running: Running, mock: MockLog): Promise<Record<string, unknown>> {
  const abort = new AbortController();
  const events = followEvents(running.url, abort.signal);
  await delay(500);
  const { botId, threadId } = await newBotThread(running.url, "Bench sequential");
  const toStart: number[] = [], toModel: number[] = [], modelToDone: number[] = [], total: number[] = [];
  let failed = 0;
  for (let i = 0; i <= TURNS; i++) {
    events.started.delete(threadId); events.completed.delete(threadId);
    const before = mock.requests.length;
    const sent = performance.now();
    await api(running.url, "POST", `/api/bots/${botId}/messages`, { text: `Turn ${i}: reply OK.`, threadId });
    if (!await waitFor(() => events.completed.has(threadId), 60_000)) { failed++; continue; }
    if (i === 0) continue;
    const call = mock.requests.slice(before).find(r => r.path.endsWith("/chat/completions"));
    total.push(events.completed.get(threadId)! - sent);
    if (events.started.has(threadId)) toStart.push(events.started.get(threadId)! - sent);
    if (call) {
      toModel.push(call.at - sent);
      if (call.endAt) modelToDone.push(events.completed.get(threadId)! - call.endAt);
    }
    await delay(50);
  }
  const sequential = { turns: TURNS, failed, sendToStartMs: stats(toStart), sendToModelRequestMs: stats(toModel),
    modelDoneToTurnDoneMs: stats(modelToDone), sendToTurnDoneMs: stats(total) };

  const targets: Array<{ botId: string; threadId: string }> = [];
  for (let i = 0; i < BOTS; i++) targets.push(await newBotThread(running.url, `Bench parallel ${i + 1}`));
  const rounds: Array<Record<string, unknown>> = [];
  for (let round = 1; round <= ROUNDS; round++) {
    for (const t of targets) { events.started.delete(t.threadId); events.completed.delete(t.threadId); }
    const sent = new Map<string, number>();
    const roundStart = performance.now();
    await Promise.all(targets.map(async (t) => {
      sent.set(t.threadId, performance.now());
      await api(running.url, "POST", `/api/bots/${t.botId}/messages`, { text: `Round ${round}: reply OK.`, threadId: t.threadId });
    }));
    await waitFor(() => targets.every(t => events.completed.has(t.threadId)), 120_000);
    const done = targets.filter(t => events.completed.has(t.threadId));
    rounds.push({ round, completed: done.length, roundMs: Math.round(Math.max(...done.map(t => events.completed.get(t.threadId)!)) - roundStart),
      sendToTurnDoneMs: stats(done.map(t => events.completed.get(t.threadId)! - sent.get(t.threadId)!)) });
    await delay(500);
  }
  abort.abort();
  const modelRequests: Record<string, number> = {};
  for (const r of mock.requests) modelRequests[r.path] = (modelRequests[r.path] ?? 0) + 1;
  return { sequential, parallel: { bots: BOTS, rounds }, modelRequests };
}

function oha(args: string[]): Record<string, unknown> | null {
  try {
    const out = JSON.parse(sh("oha", ["--no-tui", "--output-format", "json", ...args])) as {
      summary: { successRate: number; total: number; requestsPerSec: number };
      latencyPercentiles: Record<string, number>; statusCodeDistribution: Record<string, number>;
    };
    const ms = (s: number | undefined) => s === undefined ? null : Math.round(s * 1_000_000) / 1_000;
    return { requestsPerSec: Math.round(out.summary.requestsPerSec), successRate: out.summary.successRate,
      p50Ms: ms(out.latencyPercentiles.p50), p95Ms: ms(out.latencyPercentiles.p95), p99Ms: ms(out.latencyPercentiles.p99),
      status: out.statusCodeDistribution };
  } catch (error) {
    return { error: String(error).slice(0, 300) };
  }
}

async function measureHttp(url: string): Promise<Record<string, unknown>> {
  const ohaVersion = (() => { try { return sh("oha", ["--version"]); } catch { return null; } })();
  if (!ohaVersion) return { skipped: "oha not on PATH" };
  const duration = `${DURATION_S}s`;
  const bots = ((await api(url, "GET", "/api/bots?messages=0")).bots as unknown[]).length;
  const result: Record<string, unknown> = { tool: ohaVersion, durationS: DURATION_S, bots };
  for (const [name, path] of [["health", "/api/health"], ["botList", "/api/bots?messages=0"]] as const) {
    result[name] = {
      path,
      max: { connections: 50, ...oha(["-z", duration, "-c", "50", "-H", `origin: ${url}`, `${url}${path}`]) },
      fixedRate: { rate: RATE, connections: 10, ...oha(["-z", duration, "-c", "10", "-q", String(RATE), "--latency-correction", "-H", `origin: ${url}`, `${url}${path}`]) },
    };
  }
  return result;
}

function groupProcesses(pgid: number): Array<{ command: string; rssBytes: number }> {
  return groupPids(pgid).map((pid) => {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
      return { command: args.slice(0, 2).map(a => a.split("/").slice(-2).join("/")).join(" "), rssBytes: rssKb * 1024 };
    } catch { return { command: "exited", rssBytes: 0 }; }
  });
}

async function measureIdle(running: Running): Promise<Record<string, unknown>> {
  const pgid = running.child.pid!;
  const timeline: Array<{ second: number; rssBytes: number; cpuPercent: number }> = [];
  const rssAtHealthy = groupRssBytes(pgid);
  let ticks = groupCpuTicks(pgid);
  for (let second = 10; second <= IDLE_S; second += 10) {
    await delay(10_000);
    const now = groupCpuTicks(pgid);
    timeline.push({ second, rssBytes: groupRssBytes(pgid), cpuPercent: Math.round((now - ticks) / CLK_TCK / 10 * 1000) / 10 });
    ticks = now;
  }
  const window = (from: number, to: number) => {
    const rows = timeline.filter(r => r.second > from && r.second <= to);
    return rows.length ? Math.round(rows.reduce((sum, r) => sum + r.cpuPercent, 0) / rows.length * 10) / 10 : null;
  };
  const steady = timeline.filter(r => r.second > IDLE_S - 60);
  return {
    idleSeconds: IDLE_S, rssAtHealthyBytes: rssAtHealthy, rssPeakBytes: Math.max(rssAtHealthy, ...timeline.map(r => r.rssBytes)),
    rssSteadyBytes: Math.round(steady.reduce((sum, r) => sum + r.rssBytes, 0) / Math.max(1, steady.length)),
    cpuPercentFirst60s: window(0, 60), cpuPercentSteady: window(IDLE_S - 60, IDLE_S),
    processes: groupProcesses(pgid), timeline,
  };
}

function markdown(r: any): string {
  const mb = (b: number | undefined) => b === undefined ? "—" : `${Math.round(b / 1024 / 1024)} MB`;
  const s = (ms: number | undefined) => ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
  const ms = (v: number | null | undefined) => v === null || v === undefined ? "—" : `${Math.round(v)} ms`;
  const h = r.host, seq = r.turns?.sequential, par = r.turns?.parallel?.rounds as any[] | undefined;
  const lastRound = par?.at(-1);
  const rows: Array<[string, string]> = [
    ["Install (npm, cold cache)", `${s(r.install?.installMs)}, ${mb(r.install?.downloadCacheBytes)} download, ${mb(r.install?.installedBytes)} on disk`],
    ["Start to healthy, new data folder (p50)", s(r.start?.coldStartMs?.p50)],
    ["Start to healthy, existing data folder (p50)", s(r.start?.warmStartMs?.p50)],
    ["Memory at idle (RSS, all processes)", mb(r.idle?.rssSteadyBytes)],
    ["CPU at idle (one core = 100%)", `${r.idle?.cpuPercentSteady ?? "—"}%`],
    ["Seira time per chat turn, instant model (p50 / p95)", `${ms(seq?.sendToTurnDoneMs?.p50)} / ${ms(seq?.sendToTurnDoneMs?.p95)}`],
    [`${r.turns?.parallel?.bots ?? "?"} bots at once, all turns done (last round)`, ms(lastRound?.roundMs)],
    ["`/api/health` at max load (req/s, p99)", `${r.http?.health?.max?.requestsPerSec ?? "—"} req/s, ${ms(r.http?.health?.max?.p99Ms)}`],
    [`\`/api/health\` at ${r.http?.health?.fixedRate?.rate ?? "?"} req/s (p50 / p99)`, `${ms(r.http?.health?.fixedRate?.p50Ms)} / ${ms(r.http?.health?.fixedRate?.p99Ms)}`],
    [`List of ${r.http?.bots ?? "?"} bots at max load (req/s, p99)`, `${r.http?.botList?.max?.requestsPerSec ?? "—"} req/s, ${ms(r.http?.botList?.max?.p99Ms)}`],
  ];
  return [
    `Seira ${r.seiraVersion} · ${h.os} · ${h.vcpus} vCPU ${h.cpu} · ${mb(h.memoryBytes)} RAM · Node ${h.node} · ${String(r.date).slice(0, 10)}`,
    "",
    "| Measure | Result |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
  ].join("\n");
}

const report: Record<string, unknown> = {
  benchmark: "seira-server", date: new Date().toISOString(),
  host: { os: osName(), kernel: release(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", vcpus: availableParallelism(),
    memoryBytes: totalmem(), node: process.version },
};

try {
  let seira = opt.seira;
  if (!seira) {
    const installed = installRelease();
    seira = installed.seira;
    report.install = installed.result;
  }
  report.seiraVersion = sh(seira, ["--version"]);
  console.error(`seira ${report.seiraVersion}: start x${RUNS} cold and warm`);
  report.start = await measureStarts(seira);

  const { server: mockServer, log: mockLog } = await startMock();
  const dataDir = join(ROOT, "main");
  await stopServer(await startServer(seira, dataDir));
  writeBenchInstance(dataDir);
  const running = await startServer(seira, dataDir);
  try {
    console.error(`idle ${IDLE_S} s`);
    report.idle = await measureIdle(running);
    console.error(`turns: ${TURNS} sequential, ${BOTS} bots x ${ROUNDS} rounds`);
    report.turns = await measureTurns(running, mockLog);
    report.rssAfterTurnsBytes = groupRssBytes(running.child.pid!);
    console.error(`http: ${DURATION_S} s per run`);
    report.http = await measureHttp(running.url);
  } finally {
    await stopServer(running);
    mockServer.close();
  }
} catch (error) {
  report.error = String(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  writeFileSync(opt.out!, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.error) writeFileSync(opt.out!.replace(/\.json$/, "") + ".md", markdown(report));
  console.log(JSON.stringify(report, null, 2));
  rmSync(ROOT, { recursive: true, force: true });
}
