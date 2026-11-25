// `seira serve --tunnel`: every public request arrives over an IPC listener, so request-auth always demands a paired session.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { ensurePrivateDir } from "./data-dir.ts";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FRIENDLY_MESSAGES } from "../electron/companion-account-messages.mjs";
import {
  COMPANION_ACCOUNT_EMAIL_FIELD,
  COMPANION_INSTALLATION_ID_FIELD,
  createCompanionAccountService,
  resolveCompanionControlPlaneURL,
  resolveServerControlPlaneURL,
  type CompanionAccountService,
  type CompanionAccountState,
  type CredentialDocument,
} from "../electron/companion-account-service.mjs";
import {
  cleanupCompanionOriginEndpoint,
  createCompanionOriginEndpoint,
  MANAGED_COMPANION_ORIGIN_PORT,
  type CompanionOriginEndpoint,
} from "../electron/companion-origin-gateway.mjs";
import { ControlPlaneError, createControlPlaneClient, type ControlPlaneClient } from "../electron/control-plane-client.mjs";
import {
  createManagedCompanionTunnel,
  managedCompanionTunnelAccess,
  resolveCloudflaredBinary,
  serverTunnelEndpointAllowed,
  stagedCloudflaredPath,
  type ManagedTunnelAccess,
  type ManagedTunnelState,
} from "../electron/managed-companion-tunnel.mjs";
import { cloudOriginFor } from "../electron/cloud-signin.mjs";
import { createSeiraCloudSignIn } from "../electron/seira-cloud-sign-in.mjs";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";
import { writeFileAtomic } from "./atomic.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const TUNNEL_CREDENTIALS_FILE = "tunnel-account.json";
export const TUNNEL_RUNTIME_DIR = "tunnel-runtime";

export type { CompanionOriginEndpoint, ManagedTunnelAccess, ManagedTunnelState };

export interface TunnelCredentials {
  file: string;
  /** `unavailable`: the file exists but is unreadable, and nothing may be written over it. */
  status: "ok" | "empty" | "unavailable";
  read(): CredentialDocument;
  update(
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ): Promise<unknown>;
}

function plainDocument(value: unknown): CredentialDocument | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const document: CredentialDocument = {};
  for (const [key, entry] of Object.entries(value)) document[key] = entry;
  return document;
}

export function openTunnelCredentials(dataDir: string): TunnelCredentials {
  const file = join(dataDir, TUNNEL_CREDENTIALS_FILE);
  let initial: CredentialDocument = {};
  let status: TunnelCredentials["status"] = "empty";
  if (existsSync(file)) {
    try {
      // A file someone loosened (or an old umask) is tightened, not trusted as is.
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
      const parsed = plainDocument(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed) throw new Error("not a JSON object");
      initial = parsed;
      status = "ok";
    } catch {
      status = "unavailable";
    }
  }
  const persist = (next: CredentialDocument) => {
    ensurePrivateDir(dataDir);
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  };
  const state = createSecureCredentialState(initial, persist, { writable: status !== "unavailable" });
  return {
    file,
    status,
    read: () => state.read(),
    update: (derive, afterPersist) => state.update(derive, afterPersist),
  };
}

export interface TunnelAccountSummary {
  email: string | null;
  address: string | null;
  installationId: string | null;
}

function stringField(document: CredentialDocument, field: string): string | null {
  const value = document[field];
  return typeof value === "string" && value ? value : null;
}

export function describeTunnelAccount(document: CredentialDocument): TunnelAccountSummary {
  return {
    email: stringField(document, COMPANION_ACCOUNT_EMAIL_FIELD),
    address: managedCompanionTunnelAccess(document)?.endpoint ?? null,
    installationId: stringField(document, COMPANION_INSTALLATION_ID_FIELD),
  };
}

/** True once `seira login` has signed this machine in to a Seira account. It reads the file each time, since `login` runs in another process. */
export function signedInToSeira(dataDir: string): boolean {
  return describeTunnelAccount(openTunnelCredentials(dataDir).read()).email !== null;
}

/** The saved access, or null when its address is not one this server may use. */
export function tunnelAccess(document: CredentialDocument, env: NodeJS.ProcessEnv = process.env): ManagedTunnelAccess | null {
  const access = managedCompanionTunnelAccess(document);
  return access && serverTunnelEndpointAllowed(access.endpoint, env) ? access : null;
}

export interface TunnelAddressRefusal {
  code: "endpoint_capacity" | "endpoint_limit" | "control_plane_unavailable";
  message: string;
}

/** A friendly text with its "{wait}" filled in, and the error reference that can follow it. */
const friendlyText = (template: string) =>
  new RegExp(`^${template.split("{wait}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}(?: Reference: .+\\.)?$`);
const ADDRESS_REFUSALS = [
  { code: "endpoint_capacity", problem: "busy", text: friendlyText(FRIENDLY_MESSAGES.endpoint_capacity) },
  { code: "endpoint_limit", problem: "limit", text: friendlyText(FRIENDLY_MESSAGES.endpoint_limit) },
] as const;

/** FR-221: why the control plane gave this signed-in machine no seira.run address, read from the state that
 * `account.service.retry()` returns. Null when an address is there, nobody is signed in, or the failure is another kind. */
export function tunnelAddressRefusal(state: CompanionAccountState): TunnelAddressRefusal | null {
  if (state.status !== "error" || state.endpoint) return null;
  if (state.problem === "unreachable") return { code: "control_plane_unavailable", message: FRIENDLY_MESSAGES.control_plane_unavailable };
  const message = state.message ?? "";
  const refusal = ADDRESS_REFUSALS.find((entry) => entry.problem === state.problem && entry.text.test(message));
  return refusal ? { code: refusal.code, message } : null;
}

/** Refuses an address outside the allowed zones before the caller stores its connector token or starts a connector. */
function withEndpointCheck(client: ControlPlaneClient, env: NodeJS.ProcessEnv): ControlPlaneClient {
  return {
    ...client,
    async ensureEndpoint(credential, options) {
      const provision = await client.ensureEndpoint(credential, options);
      if (!serverTunnelEndpointAllowed(provision.endpoint.url, env)) throw new ControlPlaneError("invalid_response");
      return provision;
    },
  };
}

export function platformName(platform: NodeJS.Platform = process.platform): "darwin" | "windows" | "linux" {
  return platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
}

export interface TunnelAccount {
  service: CompanionAccountService;
  credentials: TunnelCredentials;
  controlPlane: string;
}

export interface TunnelRecovery {
  running(): RunningTunnel | null;
}

const STOPPED_TUNNEL: ManagedTunnelState = { status: "stopped", ready: false };

/** A server's operator owns its environment, so SEIRA_CONTROL_PLANE_URL is always honoured here (the desktop: dev builds only). */
export function createTunnelAccount(options: {
  dataDir: string;
  version: string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  machineName?: string;
  recovery?: TunnelRecovery;
  /** `login --relay`: sign in without reserving a public address; phones reach this machine through Seira Relay. */
  relayOnly?: boolean;
  /** Services treated as live; tests only. */
  liveServices?: readonly string[];
  log?: (line: string) => void;
  clock?: {
    setTimer: (callback: () => void, milliseconds: number) => unknown;
    clearTimer: (handle: unknown) => void;
    now: () => number;
  };
}): TunnelAccount {
  const env = options.env ?? process.env;
  const credentials = openTunnelCredentials(options.dataDir);
  const controlPlane = resolveServerControlPlaneURL({ environment: env, ...(options.liveServices ? { live: options.liveServices } : {}) });
  const machineName = options.machineName ?? hostname();
  const cloudSignIn = createSeiraCloudSignIn({
    origin: cloudOriginFor(env),
    identity: { deviceName: machineName, platform: process.platform, appVersion: options.version },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const client = controlPlane
    ? withEndpointCheck(createControlPlaneClient({ baseURL: controlPlane, fetchImpl: options.fetchImpl, cloudSignIn }), env)
    : null;
  const recovery = options.recovery;
  const service = createCompanionAccountService({
    client,
    readCredentials: () => credentials.read(),
    updateCredentials: (derive, afterPersist) => credentials.update(derive, afterPersist),
    identity: { name: machineName, platform: platformName(), appVersion: options.version, kind: "server" },
    newClientInstanceId: () => randomUUID(),
    ...(options.log ? { log: options.log } : {}),
    ...(options.relayOnly ? { onDemand: true, managedEndpointNeeded: async () => false, relay: { capable: () => true, legacyDevices: async () => 0 } } : {}),
    ...(recovery
      ? {
          autoRecover: true,
          companionIsOn: () => recovery.running() !== null,
          managedConnectionState: () => recovery.running()?.state() ?? STOPPED_TUNNEL,
          activatePersistedEndpoint: async () => {
            const tunnel = recovery.running();
            const access = tunnelAccess(credentials.read(), env);
            if (!tunnel || !access) return tunnel?.state() ?? STOPPED_TUNNEL;
            return tunnel.restart(access);
          },
          ...options.clock,
        }
      : {}),
  });
  return { service, credentials, controlPlane };
}

/** What the control plane is asked for. Seira's own control plane gives tunnel addresses, not Seira Relay. */
export type ControlPlanePurpose = "tunnel" | "relay";

/** Null when `purpose` has a control plane. Otherwise the reason that it cannot work, with the ways in that do. */
export function controlPlaneProblem(env: NodeJS.ProcessEnv = process.env, purpose: ControlPlanePurpose = "tunnel", liveServices?: readonly string[]): string | null {
  const url = purpose === "relay"
    ? resolveCompanionControlPlaneURL({ isPackaged: true, environment: env })
    : resolveServerControlPlaneURL({ environment: env, ...(liveServices ? { live: liveServices } : {}) });
  if (url) return null;
  if (env.SEIRA_CONTROL_PLANE_URL?.trim()) return "SEIRA_CONTROL_PLANE_URL is set but is not an https address";
  const service = purpose === "relay" ? "Seira Relay" : "tunnel addresses";
  return `this Seira build has no account service for ${service}; set SEIRA_CONTROL_PLANE_URL to one you run, or serve with --domain, --tailscale or --public-url (behind your own tunnel or proxy)`;
}

export const FLEET_CREDENTIAL_ENV = "SEIRA_INSTALLATION_CREDENTIAL";

/** A fleet container's installation credential comes from the environment; nothing is written to disk. */
export function fleetCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[FLEET_CREDENTIAL_ENV]?.trim();
  return value ? value : null;
}

export async function fleetAccess(options: { credential: string; version?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; liveServices?: readonly string[] }): Promise<ManagedTunnelAccess> {
  const env = options.env ?? process.env;
  const live = options.liveServices ? { live: options.liveServices } : {};
  const problem = controlPlaneProblem(env, "tunnel", options.liveServices);
  if (problem) throw new Error(problem);
  const controlPlane = resolveServerControlPlaneURL({ environment: env, ...live });
  const client = withEndpointCheck(createControlPlaneClient({ baseURL: controlPlane, fetchImpl: options.fetchImpl }), env);
  try {
    const { endpoint, connectorToken } = await client.ensureEndpoint(options.credential, { appVersion: options.version, kind: "server" });
    return { endpoint: endpoint.url, token: connectorToken };
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 401) {
      throw new Error(`the installation credential in ${FLEET_CREDENTIAL_ENV} was rejected by ${controlPlane}; the fleet has to issue a new one`);
    }
    const reference = error instanceof ControlPlaneError && error.requestId ? ` (reference ${error.requestId})` : "";
    throw new Error(`could not get this machine's public address from ${controlPlane}: ${error instanceof Error ? error.message : String(error)}${reference}`);
  }
}

/** SEIRA_CLOUDFLARED_PATH, then the copy this command downloaded into the data
 * dir, then PATH. */
export function cloudflaredPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveCloudflaredBinary({ isPackaged: false, appPath: dataDir, environment: env });
}

export function prepareEntry(here = HERE): string {
  const bundled = join(here, "prepare-cloudflared.js");
  return existsSync(bundled) ? bundled : resolve(here, "..", "scripts", "prepare-cloudflared.mjs");
}

export function guardianEntry(here = HERE): string | null {
  const bundled = join(here, "tunnel-guardian.js");
  if (existsSync(bundled)) return bundled;
  const source = resolve(here, "..", "electron", "managed-companion-guardian-main.mjs");
  return existsSync(source) ? source : null;
}

export async function ensureCloudflared(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  here?: string;
}): Promise<string> {
  const env = options.env ?? process.env;
  const found = cloudflaredPath(options.dataDir, env);
  const staged = stagedCloudflaredPath({ appPath: options.dataDir });
  const refreshStaged = !env.SEIRA_CLOUDFLARED_PATH?.trim() && found === staged;
  if (found && !refreshStaged) return found;
  options.log(
    refreshStaged
      ? `checking staged cloudflared (pinned version and digest) in ${options.dataDir}`
      : `downloading cloudflared once (pinned version and digest, about 40 MB) into ${options.dataDir}`,
  );
  await new Promise<void>((done, fail) => {
    const child = spawn(process.execPath, [prepareEntry(options.here), "--current", "--root", options.dataDir], {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error) => fail(new Error(`could not prepare cloudflared: ${error.message}`)));
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`the cloudflared ${refreshStaged ? "refresh" : "download"} failed (exit ${code ?? "signal"})`))));
  });
  const prepared = refreshStaged ? (existsSync(staged) ? staged : null) : cloudflaredPath(options.dataDir, env);
  if (!prepared) throw new Error("cloudflared was prepared but is not where it should be; remove the data dir's dist-native folder and try again");
  return prepared;
}

export function createTunnelOrigin(): CompanionOriginEndpoint {
  return createCompanionOriginEndpoint({ processId: process.pid });
}

export function cleanupTunnelOrigin(origin: CompanionOriginEndpoint): void {
  cleanupCompanionOriginEndpoint(origin);
}

export interface RunningTunnel {
  address: string;
  state(): ManagedTunnelState;
  started: Promise<ManagedTunnelState>;
  restart(access: ManagedTunnelAccess): Promise<ManagedTunnelState>;
  stop(): Promise<void>;
}

/** The control plane points the tunnel at 127.0.0.1:8812 (SEIRA_TUNNEL_ORIGIN_PORT for tests); the gateway forwards to the IPC socket. */
export function startTunnel(options: {
  dataDir: string;
  access: ManagedTunnelAccess;
  originTarget: { pid: number; socketPath: string };
  binaryPath: string;
  guardian: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  onState?: (state: ManagedTunnelState) => void;
}): RunningTunnel {
  const env = options.env ?? process.env;
  const originPort = Number(env.SEIRA_TUNNEL_ORIGIN_PORT || MANAGED_COMPANION_ORIGIN_PORT);
  let current: ManagedTunnelState = { status: "stopped", ready: false };
  const tunnel = createManagedCompanionTunnel({
    binaryPath: options.binaryPath,
    guardianEntry: options.guardian,
    runtimeRoot: join(options.dataDir, TUNNEL_RUNTIME_DIR),
    originPort,
    environment: env,
    fetchImpl: options.fetchImpl,
    onChange: (state) => {
      current = state;
      options.onState?.(state);
    },
  });
  const started = tunnel.start({ endpoint: options.access.endpoint, token: options.access.token, originTarget: options.originTarget });
  return {
    address: options.access.endpoint,
    state: () => current,
    started,
    restart: (access) => tunnel.start({ endpoint: access.endpoint, token: access.token, originTarget: options.originTarget }),
    stop: async () => {
      await tunnel.stop();
    },
  };
}

export function describeTunnelState(state: ManagedTunnelState, address: string): string {
  switch (state.status) {
    case "starting":
      return "tunnel: connecting…";
    case "ready":
      return `tunnel: live at ${address}`;
    case "retrying":
      return `tunnel: ${state.error ?? "not verified yet"} retrying in ${Math.max(1, Math.round((state.retryInMs ?? 0) / 1000))}s`;
    case "stopped":
      return "tunnel: stopped";
    default:
      return `tunnel: ${state.error ?? state.status}`;
  }
}
