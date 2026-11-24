// Never log Tailscale's raw stderr (it can contain auth keys and node names): failures are classified into a closed set.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { tailscaleCandidates, tailscaleEnvironment } from "../companion/src/listener.ts";
import { readTailscaleStatusJson, tailnetInterfaceAddresses, tailnetOrigin } from "../electron/tailnet.mjs";

export interface TailscaleStatus {
  cli: string;
  dnsName: string | null;
  addresses: string[];
  backendState: string;
  /** The tailnet hands out HTTPS certificates (`CertDomains`, or `https` in `Self.CapMap`, in `tailscale status --json`). */
  httpsEnabled: boolean;
}

export type TailscaleFailure =
  | "not-installed"
  | "not-logged-in"
  | "not-running"
  | "no-magicdns"
  | "needs-operator"
  | "https-not-enabled"
  | "other-server"
  | "port-taken"
  | "funnel-open"
  | "serve-unreadable"
  | "unknown";

export function classifyTailscaleStderr(text: string): TailscaleFailure {
  const t = text.toLowerCase();
  if (/listener already exists/.test(t)) return "port-taken";
  if (/not logged in|logged out|needs login|please log in/.test(t)) return "not-logged-in";
  if (/is tailscale running|tailscaled is not running|connection refused|failed to connect to local tailscaled/.test(t)) return "not-running";
  if (/access denied|permission denied|operator|must be root|not permitted/.test(t)) return "needs-operator";
  if (/https is not enabled|enable https|cert|tls certs/.test(t)) return "https-not-enabled";
  if (/magicdns/.test(t)) return "no-magicdns";
  return "unknown";
}

export function explainTailscaleFailure(reason: TailscaleFailure): string {
  switch (reason) {
    case "not-installed":
      return "Tailscale is not installed: https://tailscale.com/download";
    case "not-logged-in":
      return "Tailscale is installed but not signed in: run `tailscale up` (or sign in from the Tailscale app)";
    case "not-running":
      return "Tailscale is not running: start it, then try again";
    case "no-magicdns":
      return "this machine has no MagicDNS name: enable MagicDNS in the tailnet's DNS settings";
    case "needs-operator":
      return "Tailscale refused: on Linux run `sudo tailscale set --operator=$USER` once, then try again";
    case "https-not-enabled":
      return "HTTPS certificates are off for this tailnet: enable them at https://login.tailscale.com/admin/dns (HTTPS Certificates), then try again";
    case "other-server":
      return "this machine's tailnet name already fronts a different Seira server: stop that one, or pass --port for this one";
    case "port-taken":
      return "another tailscale serve rule or session already uses this port; run `tailscale serve status` to see it";
    case "funnel-open":
      return "Tailscale Funnel is on for a port that reaches this server, so the internet could reach it: turn Funnel off for that port (run `tailscale funnel status` to see it), then try again";
    case "serve-unreadable":
      return "Seira could not read the Tailscale Serve settings, so it cannot tell whether Funnel opens this server to the internet: run `tailscale serve status`, fix what it reports, then try again";
    default:
      return "Tailscale reported an error; run `tailscale status` and `tailscale serve status` to see it";
  }
}

function run(cli: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, env: tailscaleEnvironment() },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? null : 0;
        resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
  });
}

/** `tailscale serve status --json` (ServeConfig), or null when it cannot be read. */
export async function readTailscaleServeConfig(cli: string): Promise<unknown> {
  const result = await run(cli, ["serve", "status", "--json"], 10_000);
  if (!result.ok) return null;
  try {
    const config: unknown = JSON.parse(result.stdout);
    // An empty setup prints `{}`. Anything that is not an object is not a ServeConfig, so it counts as unreadable.
    return typeof config === "object" && config !== null && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

const funnelOn = (config: unknown, hostPort: string): boolean => field(field(config, "AllowFunnel"), hostPort) === true;

/**
 * What a ServeConfig says about one HTTPS port. `ours`: a rule from `tailscale serve --bg` proxies it to this server.
 * `taken`: another rule, or a foreground session, uses it. Tailscale 1.104 refuses a second listener on such a port.
 * `funnel`: Tailscale Funnel is on for the port, in the saved config or in a foreground session, so the internet can reach it.
 * Seira never uses such a port, whatever its target, because it tells people that only their tailnet can reach them.
 */
export function servePortState(config: unknown, dnsName: string, httpsPort: number, localPort: number): "free" | "ours" | "taken" | "funnel" {
  const key = String(httpsPort);
  const hostPort = `${dnsName}:${httpsPort}`;
  const sessions = field(config, "Foreground");
  const sessionList = typeof sessions === "object" && sessions !== null ? Object.values(sessions) : [];
  if (funnelOn(config, hostPort) || sessionList.some((session) => funnelOn(session, hostPort))) return "funnel";
  if (field(field(config, "TCP"), key) !== undefined) {
    const proxy = field(field(field(field(field(config, "Web"), `${dnsName}:${httpsPort}`), "Handlers"), "/"), "Proxy");
    const target = typeof proxy === "string" ? proxy.replace(/\/+$/, "") : "";
    const ours = [`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`, `127.0.0.1:${localPort}`, `localhost:${localPort}`];
    return ours.includes(target) ? "ours" : "taken";
  }
  return sessionList.some((session) => field(field(session, "TCP"), key) !== undefined) ? "taken" : "free";
}

/** True when a serve target (`http://127.0.0.1:8799`, `localhost:8799`, `http://[::1]:8799/`) is this server's own port on this machine. */
function targetsLocalServer(target: unknown, localPort: number): boolean {
  if (typeof target !== "string") return false;
  const text = target.trim();
  let url: URL | null = null;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`); } catch { /* not a URL */ }
  if (!url) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" || url.protocol === "https+insecure:" ? "443" : "80");
  return ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host) && port === String(localPort);
}

/**
 * The first port on which Tailscale Funnel, in the saved config or in a foreground session, forwards to this server,
 * on any port and any name, whether or not Seira would use that port. Null when none does. Funnel sends internet
 * traffic to its target, so a server that says only the tailnet can reach it must not start next to one.
 */
export function funnelPortToLocalServer(config: unknown, localPort: number): number | null {
  const sessions = field(config, "Foreground");
  const configs = [config, ...(typeof sessions === "object" && sessions !== null ? Object.values(sessions) : [])];
  for (const one of configs) {
    const open = field(one, "AllowFunnel");
    if (typeof open !== "object" || open === null) continue;
    for (const [hostPort, on] of Object.entries(open)) {
      if (on !== true) continue;
      const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
      const handlers = field(field(field(one, "Web"), hostPort), "Handlers");
      const proxied = typeof handlers === "object" && handlers !== null && Object.values(handlers).some((handler) => targetsLocalServer(field(handler, "Proxy"), localPort));
      if (proxied || targetsLocalServer(field(field(field(one, "TCP"), String(port)), "TCPForward"), localPort)) return Number.isInteger(port) ? port : 0;
    }
  }
  return null;
}

export function parseTailscaleStatus(cli: string, stdout: string): TailscaleStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const self = Reflect.get(Object(parsed), "Self");
  const dns = Reflect.get(Object(self), "DNSName");
  const ips = Reflect.get(Object(self), "TailscaleIPs");
  const state = Reflect.get(Object(parsed), "BackendState");
  return {
    cli,
    dnsName: typeof dns === "string" && dns ? dns.replace(/\.$/, "") : null,
    addresses: Array.isArray(ips) ? ips.filter((v): v is string => typeof v === "string") : [],
    backendState: typeof state === "string" ? state : "unknown",
    httpsEnabled: readTailscaleStatusJson(stdout)?.https === true,
  };
}

export async function tailscaleStatus(): Promise<{ status: TailscaleStatus } | { failure: TailscaleFailure }> {
  let sawCli = false;
  for (const cli of tailscaleCandidates()) {
    const result = await run(cli, ["status", "--json"], 5_000);
    if (!result.ok && !result.stdout && result.code === null) continue;
    sawCli = true;
    const status = parseTailscaleStatus(cli, result.stdout);
    if (status) {
      if (status.backendState === "NeedsLogin") return { failure: "not-logged-in" };
      if (status.backendState !== "Running") return { failure: "not-running" };
      return { status };
    }
    if (result.stderr) return { failure: classifyTailscaleStderr(result.stderr) };
  }
  return { failure: sawCli ? "unknown" : "not-installed" };
}

/** What keeps `tailscale serve` from fronting this server, while the tailnet itself still reaches it. */
const LISTEN_INSTEAD: Partial<Record<TailscaleFailure, [why: string, fix: string]>> = {
  "https-not-enabled": ["HTTPS certificates are off for this tailnet", "turn on HTTPS Certificates at https://login.tailscale.com/admin/dns and start again"],
  "needs-operator": ["Tailscale won't let this user run tailscale serve", "run `sudo tailscale set --operator=$USER` once and start again"],
  "other-server": ["the tailnet name's HTTPS address already fronts a different Seira server", "stop that server and start again"],
};

/**
 * When `tailscale serve` can't front this server, it listens on its own tailnet addresses instead, at
 * `http://<name>:<port>` (WireGuard encrypts it). Null when that would not help either: another failure, no MagicDNS
 * name, or no Tailscale interface here (userspace networking, as in most containers).
 */
export function tailnetListenFallback(failure: TailscaleFailure, status: TailscaleStatus, port: number, interfaces: NodeJS.Dict<Array<{ address: string }>> = networkInterfaces()):
  { origin: string; env: { SEIRA_TAILNET_NAME: string }; line: string } | null {
  const reason = LISTEN_INSTEAD[failure];
  const local = tailnetInterfaceAddresses(interfaces);
  const addresses = status.addresses.filter((address) => local.includes(address.toLowerCase()));
  if (!reason || !status.dnsName || addresses.length === 0) return null;
  const origin = tailnetOrigin(status.dnsName, port);
  return {
    origin,
    env: { SEIRA_TAILNET_NAME: status.dnsName },
    line: `tailscale: ${reason[0]}, so this server listens on ${origin} itself (only your tailnet can reach it, and WireGuard encrypts it). For an https:// address, ${reason[1]}.`,
  };
}

const FALLBACK_HTTPS_PORT = 8443;

/** Where a run records the HTTPS ports it serves on the tailnet, so each start keeps the addresses devices already use. */
export const tailscalePortsFile = (dataDir: string) => join(dataDir, "tailscale-https.json");

const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;

function savedTailscalePorts(dataDir: string): number[] | null {
  try {
    const { ports } = JSON.parse(readFileSync(tailscalePortsFile(dataDir), "utf8")) as { ports?: unknown };
    if (!Array.isArray(ports) || ports.length === 0 || ports.length > 4 || !ports.every(validPort) || new Set(ports).size !== ports.length) return null;
    return ports;
  } catch {
    return null;
  }
}

/**
 * The HTTPS ports to serve; the first is the address people see. Saved ports win and no listener is consulted. Without
 * them (a first start, or an upgrade from a version that saved nothing): 443 and 8443. Versions 0.1.189 to 0.1.191 moved
 * the address to 8443 when another program listened on 443 and kept no record, so no start can tell that a device uses
 * 8443. Serving both keeps those devices working, whether or not 443 is free now. The first start saves the ports.
 * `primaryBusy` tells whether another program listens on the first port on this server. That does not stop other
 * tailnet devices: tailscaled takes their traffic itself, and only its listener for connections from this server fails.
 */
export function chooseTailscaleHttpsPorts(dataDir: string, listening: Iterable<number>): { ports: number[]; primaryBusy: boolean; line: string | null } {
  const taken = new Set(listening);
  const saved = savedTailscalePorts(dataDir);
  if (saved) return { ports: saved, primaryBusy: taken.has(saved[0]!), line: null };
  const busy = taken.has(443);
  const why = busy ? "port 443 is in use by another program, so" : "so devices set up on an earlier version keep working,";
  return { ports: [443, FALLBACK_HTTPS_PORT], primaryBusy: busy, line: `tailscale: ${why} the server also answers on port ${FALLBACK_HTTPS_PORT}. To serve port 443 alone, save {"ports":[443]} in tailscale-https.json in the data folder.` };
}

/** Why Tailscale cannot give phones an HTTPS address now, or null when it can. */
export async function tailscaleHttpsProblem(probe: typeof tailscaleStatus = tailscaleStatus): Promise<string | null> {
  const result = await probe();
  if ("failure" in result) return explainTailscaleFailure(result.failure);
  return result.status.httpsEnabled ? null : explainTailscaleFailure("https-not-enabled");
}

/** Where a run that shares over Tailscale notes it, so the next start can turn off a share a crash left behind. */
export const tailscaleMarker = (dataDir: string) => join(dataDir, "tailscale-serve.marker");

const originFor = (dnsName: string, httpsPort: number) => (httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`);

/**
 * `tailscale serve` in the foreground, one process per HTTPS port: the share ends with this process. Before serving,
 * the tailnet must have HTTPS certificates (`CertDomains`), or serve waits on an enablement link forever; and the name
 * must not already front a different Seira server. Resolves once the first port has run for `settleMs` without exiting.
 * Another port that fails is skipped with one line; the first port decides the result. `origin` is the first port's.
 * A port that a `tailscale serve --bg` rule already proxies to this server is used as it is, and stays on at stop.
 * `serveConfig` must return the Serve settings; when it fails or returns no object, the result is `serve-unreadable` and nothing starts.
 */
export async function tailscaleServe(
  status: TailscaleStatus,
  localPort: number,
  options: { dataDir: string; httpsPorts?: number[]; settleMs?: number; spawnImpl?: typeof spawn; otherServer?: (origin: string) => Promise<boolean>; serveConfig: () => Promise<unknown>; log?: (line: string) => void },
): Promise<{ origin: string; origins: string[]; stop(): Promise<void> } | { failure: TailscaleFailure }> {
  const wanted = options.httpsPorts?.length ? options.httpsPorts : [443];
  if (!status.dnsName) return { failure: "no-magicdns" };
  if (!status.httpsEnabled) return { failure: "https-not-enabled" };
  const dnsName = status.dnsName;
  const running: Array<{ port: number; stop(): Promise<void> }> = [];
  const serving: number[] = [];
  const stopAll = () => Promise.all(running.map((one) => one.stop())).then(() => undefined);
  // Funnel can only be ruled out from the Serve settings. When they cannot be read, startup stops: the address would say
  // "only your tailnet can reach it" with nothing to back it. `null` from the reader means it failed.
  const config = await options.serveConfig().catch(() => null);
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    options.log?.("tailscale: Seira could not read the Tailscale Serve settings (tailscale serve status --json), so it cannot rule out that Tailscale Funnel opens this server to the internet. Seira does not start. Run tailscale serve status, fix what it reports, then start again.");
    return { failure: "serve-unreadable" };
  }
  const exposed = funnelPortToLocalServer(config, localPort);
  if (exposed !== null) {
    options.log?.(`tailscale: Tailscale Funnel is on for port ${exposed} and forwards to this server, so the internet could reach it. Seira does not start and leaves that setting as it is (to close it: tailscale funnel --https=${exposed} off).`);
    return { failure: "funnel-open" };
  }
  for (const httpsPort of wanted) {
    const state = servePortState(config, dnsName, httpsPort, localPort);
    if (state === "funnel") {
      const line = `tailscale: port ${httpsPort} is open to the internet through Tailscale Funnel, so Seira does not use it. Seira leaves that setting as it is (to close it: tailscale funnel --https=${httpsPort} off).`;
      if (serving.length === 0) { options.log?.(line); return { failure: "port-taken" }; }
      options.log?.(line);
      continue;
    }
    if (state === "ours") {
      serving.push(httpsPort);
      options.log?.(`tailscale: port ${httpsPort} already has a tailscale serve rule for this server, so Seira uses that rule and leaves it on.`);
      continue;
    }
    const started = state === "taken" ? { failure: "port-taken" as const } : await serveOnPort(status, localPort, httpsPort, options);
    if (!("failure" in started)) { running.push({ port: httpsPort, stop: started.stop }); serving.push(httpsPort); continue; }
    if (serving.length === 0) {
      if (started.failure === "port-taken") options.log?.(`tailscale: port ${httpsPort} is in use by another tailscale serve rule or session (run: tailscale serve status).`);
      return started;
    }
    options.log?.(`tailscale: port ${httpsPort} could not start (${explainTailscaleFailure(started.failure)}). The address on port ${wanted[0]} still works; the next start tries port ${httpsPort} again.`);
  }
  try {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(tailscalePortsFile(options.dataDir), JSON.stringify({ ports: wanted }), { mode: 0o600 });
    if (running.length > 0) writeFileSync(tailscaleMarker(options.dataDir), JSON.stringify({ cli: status.cli, httpsPorts: running.map((one) => one.port), localPort }), { mode: 0o600 });
  } catch (error) {
    await stopAll();
    throw error;
  }
  return {
    origin: originFor(dnsName, wanted[0]!),
    origins: serving.map((port) => originFor(dnsName, port)),
    async stop() {
      await stopAll();
      rmSync(tailscaleMarker(options.dataDir), { force: true });
    },
  };
}

async function serveOnPort(
  status: TailscaleStatus,
  localPort: number,
  httpsPort: number,
  options: { settleMs?: number; spawnImpl?: typeof spawn; otherServer?: (origin: string) => Promise<boolean> },
): Promise<{ stop(): Promise<void> } | { failure: TailscaleFailure }> {
  if (await (options.otherServer ?? (() => Promise.resolve(false)))(originFor(status.dnsName!, httpsPort))) return { failure: "other-server" };
  const child = (options.spawnImpl ?? spawn)(status.cli, ["serve", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], { stdio: ["ignore", "ignore", "pipe"], env: tailscaleEnvironment() });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const exited = new Promise<number | null>((done) => { child.once("exit", (code) => done(code)); child.once("error", () => done(-1)); });
  const early = await Promise.race([exited, new Promise<"running">((done) => setTimeout(() => done("running"), options.settleMs ?? 2_500))]);
  if (early !== "running") return { failure: early === -1 ? "not-installed" : classifyTailscaleStderr(stderr) };
  return {
    async stop() {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Turns off a share a run of ours left on (its marker says so), never one the person made. True when it did. */
export async function clearLeftoverTailscaleServe(dataDir: string): Promise<boolean> {
  let marker: { cli?: unknown; httpsPort?: unknown; httpsPorts?: unknown };
  try {
    marker = JSON.parse(readFileSync(tailscaleMarker(dataDir), "utf8"));
  } catch {
    return false;
  }
  const ports = Array.isArray(marker.httpsPorts) ? marker.httpsPorts : [marker.httpsPort];
  if (typeof marker.cli === "string") for (const port of ports.filter(validPort)) await run(marker.cli, ["serve", `--https=${port}`, "off"], 10_000);
  rmSync(tailscaleMarker(dataDir), { force: true });
  return true;
}
