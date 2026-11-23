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
  | "unknown";

export function classifyTailscaleStderr(text: string): TailscaleFailure {
  const t = text.toLowerCase();
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
 * them: 443, plus 8443 when another program listens on 443, so devices set up on either address keep working.
 * `primaryBusy` tells whether another program listens on the first port on this server. That does not stop other
 * tailnet devices: tailscaled takes their traffic itself, and only its listener for connections from this server fails.
 */
export function chooseTailscaleHttpsPorts(dataDir: string, listening: Iterable<number>): { ports: number[]; primaryBusy: boolean; line: string | null } {
  const taken = new Set(listening);
  const saved = savedTailscalePorts(dataDir);
  if (saved) return { ports: saved, primaryBusy: taken.has(saved[0]!), line: null };
  if (!taken.has(443)) return { ports: [443], primaryBusy: false, line: null };
  return { ports: [443, FALLBACK_HTTPS_PORT], primaryBusy: true, line: `tailscale: port 443 is in use by another program, so the server also answers on port ${FALLBACK_HTTPS_PORT}, for devices set up with that address.` };
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
 */
export async function tailscaleServe(
  status: TailscaleStatus,
  localPort: number,
  options: { dataDir: string; httpsPorts?: number[]; settleMs?: number; spawnImpl?: typeof spawn; otherServer?: (origin: string) => Promise<boolean>; log?: (line: string) => void },
): Promise<{ origin: string; origins: string[]; stop(): Promise<void> } | { failure: TailscaleFailure }> {
  const wanted = options.httpsPorts?.length ? options.httpsPorts : [443];
  if (!status.dnsName) return { failure: "no-magicdns" };
  if (!status.httpsEnabled) return { failure: "https-not-enabled" };
  const dnsName = status.dnsName;
  const running: Array<{ port: number; stop(): Promise<void> }> = [];
  const stopAll = () => Promise.all(running.map((one) => one.stop())).then(() => undefined);
  for (const httpsPort of wanted) {
    const started = await serveOnPort(status, localPort, httpsPort, options);
    if (!("failure" in started)) { running.push({ port: httpsPort, stop: started.stop }); continue; }
    if (running.length === 0) return started;
    options.log?.(`tailscale: port ${httpsPort} could not start (${explainTailscaleFailure(started.failure)}). The address on port ${wanted[0]} still works; the next start tries port ${httpsPort} again.`);
  }
  try {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(tailscalePortsFile(options.dataDir), JSON.stringify({ ports: wanted }), { mode: 0o600 });
    writeFileSync(tailscaleMarker(options.dataDir), JSON.stringify({ cli: status.cli, httpsPorts: running.map((one) => one.port), localPort }), { mode: 0o600 });
  } catch (error) {
    await stopAll();
    throw error;
  }
  return {
    origin: originFor(dnsName, wanted[0]!),
    origins: running.map((one) => originFor(dnsName, one.port)),
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
