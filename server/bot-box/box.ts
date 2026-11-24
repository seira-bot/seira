// The bot box runtime: one per server. Decides once at boot whether turns are boxed and which (detect.ts), opens the
// gates the boxes reach through unix sockets (egress-gate.ts, harness-gate.ts, broker.ts), and wraps each bot spawn
// (server/procs.ts spawnCli with owner "bot") in bubblewrap by the plan (plan.ts). Nothing here changes a spawn the box
// does not take: the command, its arguments and its environment go through untouched.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { engineInstallRoots } from "../engine-roots.ts";
import type { TurnFolders } from "../folder-access.ts";
import { homeProgramDirs, resetPathCache } from "../env-path.ts";
import { SERVER_ROOT, resolveProxy } from "../proxy-paths.ts";
import { bridgedCommand, type BridgeTools } from "./bridge.ts";
import { brokerRewrite } from "./broker-env.ts";
import { openCredentialBroker, type BrokerGrant, type CredentialBroker } from "./broker.ts";
import { detectBox, type BoxDetection, type BoxKind, type BoxScope } from "./detect.ts";
import { BOX_EGRESS_RULES, limitedBoxRefusal, openBoxEgressGate, type BoxEgressGate } from "./egress-gate.ts";
import type { EgressRules } from "../browser/egress/policy.ts";
import { boxEnvironment } from "./env.ts";
import { openHarnessGate, type HarnessGate } from "./harness-gate.ts";
import { distrustHomePrograms, distrustLimitedBoxFolders } from "./program-trust.ts";
import { procHidepid } from "./hidepid.ts";
import { DENIED_SYSCALLS, seccompBytes, seccompSupported } from "./seccomp.ts";
import { LIMITED_HOME_SIGN_INS, RELAY_SOCKET_NAME, TEAM_FOLDER_KEPT, boxUploadsDir, makeSignInProgramFolders, signInPrograms, teamFolderOf, under, bwrapArgs, inBoxSocket, planBox, taskWorkspaceIds, visibleInBox, type BoxAudience, type BoxBridge, type BoxPlan, type BoxRequest, type BoxSetup } from "./plan.ts";
import { openBoxRelay, type BoxRelay } from "./relay.ts";

/** The loopback port inside a box that reaches the egress gate. The harness gate sits at the server's own port. */
export const BOX_EGRESS_PORT = 3128;
/** What the box sets on an isolated network: the egress proxy, and the local hosts that skip it. */
export const BOX_PROXY_ENV = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const, BOX_NO_PROXY_ENV = ["NO_PROXY", "no_proxy"] as const;
/** The loopback port inside a box that reaches the credential broker. */
export const BOX_BROKER_PORT = 18080;
/** The descriptor the box reads its seccomp filter from: the first after stdio. */
export const BOX_SECCOMP_FD = 3;
export const BOX_BRIDGE_SCRIPT = resolveProxy("bot-box/box-bridge");
export const BOX_PROBE_SCRIPT = resolveProxy("bot-box/box-probe");

export interface WrappedSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  plan: BoxPlan;
  /** The broker token this process got, or null; `release` revokes it (the caller does so when the process exits). */
  token: string | null;
  release(): void;
  /** Keys left raw in the environment because their CLI takes no base URL. */
  unbrokered: string[];
  /** Descriptors to hand the child after stdio (the seccomp filter), in order from 3; the caller closes them after the spawn. */
  extraFds: number[];
}

/** On a Team Cloud, the audience side of a conversation's boxes (server/host/team-box-scope.ts): null for a conversation
 * it does not place. `sharedProcess`: the box is for a process the bot's conversations share (BoxRequest.botThreads). */
export type BoxAudienceScope = (input: { threadId: string; botId: string | null; sharedProcess: boolean }) => BoxAudience | null;

/** The folders a bot's turn may use now, or null when the bot has no folder setting (server/bot-folders.ts). */
export type BoxFolders = (botId: string) => TurnFolders | null;

/** The folders the bots limited to chosen folders may change now, by every bot's setting. */
export type LimitedWrites = () => readonly string[];

const BOT_DATA_FOLDERS = ["workspaces", "task-workspaces", "engine-homes", "team-files"] as const;

/** A bot's folder list as a stable text: what a process kept between turns is started again on when it changes. */
export function foldersKey(folders: TurnFolders | null | undefined): string | null {
  if (!folders) return null;
  return JSON.stringify([folders.limited, folders.grants.map((grant) => `${grant.path}:${grant.write ? "rw" : "ro"}`).sort()]);
}

/** What the box runtime offers the broker's callers: mint a conversation-bound grant (an MCP server's headers). */
export interface BoxBroker {
  port: number;
  mintForThread: CredentialBroker["mintForThread"];
  touchThread: CredentialBroker["touchThread"];
  revokeThread: CredentialBroker["revokeThread"];
  lookup: CredentialBroker["lookup"];
}

export interface RunnerOptions {
  bwrap: string;
  bridge: BridgeTools;
  setup: BoxSetup;
  /** Names refused in the box's environment whatever the allow-list says: the workspace credentials. */
  denyEnv: ReadonlySet<string>;
  egressPort?: number;
  /** The seccomp filter file to hand each box on BOX_SECCOMP_FD; none loads no filter. */
  seccompFile?: string | null;
  /** The broker to mint per-process tokens with; none leaves keys in the environment. */
  broker?: { port: number; mintForProcess(input: { botId?: string | null; threadId?: string | null; grants: Record<string, BrokerGrant> }): { token: string }; revoke(token: string): void } | null;
}

/** Wraps spawns for one setup (the server's, or a self-check fixture's). */
export class BoxRunner {
  private readonly options: RunnerOptions;
  /** Paths a conversation's turns may write besides the bot's own folder (a member's or a room's memory layer on a Team Cloud). */
  private readonly lent = new Map<string, readonly string[]>();
  private audiences: BoxAudienceScope | null = null;
  private folders: BoxFolders | null = null;

  constructor(options: RunnerOptions) { this.options = options; }

  /** Each bot's folder list for every box from now on; null takes it away. */
  scopeFolders(folders: BoxFolders | null): void { this.folders = folders; }

  /** The folder list this spawn's bot has, or null (no setting, or no bot). */
  foldersFor(request: BoxRequest): TurnFolders | null {
    if (request.folders) return request.folders;
    const { botId } = this.conversation(request);
    return botId && this.folders ? this.folders(botId) : null;
  }

  /** A Team Cloud's audience rule for every box from now on; null takes it away. */
  scopeAudiences(scope: BoxAudienceScope | null): void { this.audiences = scope; }

  /** The conversation and bot a spawn is for: its conversation folder's, else the conversation it runs in (a Team
   * Cloud's engine homes say) with the bot whose own folder it works in or names. */
  private conversation(request: BoxRequest): { botId: string | null; threadId: string | null; folder: boolean } {
    const ids = request.cwd ? taskWorkspaceIds(request.cwd, this.options.setup.dataDir) : null;
    if (ids) return { ...ids, folder: true };
    if (!request.cwd && request.conversationBot) return { botId: request.conversationBot, threadId: request.threadId ?? null, folder: false };
    const inWorkspaces = request.cwd ? relative(join(this.options.setup.dataDir, "workspaces"), resolve(request.cwd)).split(sep)[0] : undefined;
    const botId = request.botId ?? (inWorkspaces && /^[A-Za-z0-9_-]{1,128}$/.test(inWorkspaces) ? inWorkspaces : null) ?? request.conversationBot ?? null;
    return { botId, threadId: request.threadId ?? null, folder: false };
  }

  /** What the audience rule gives this box, or null off a team (and for a spawn of no conversation). */
  audienceFor(request: BoxRequest): BoxAudience | null {
    const { botId, threadId, folder } = this.conversation(request);
    return this.audiences && threadId ? this.audiences({ threadId, botId, sharedProcess: Boolean(request.botThreads) && folder }) : null;
  }

  get setup(): BoxSetup { return this.options.setup; }

  /** Lends `rw` paths to every box of this conversation until `lend` is called again with none. */
  lend(botId: string, threadId: string, rw: readonly string[]): void {
    if (rw.length) this.lent.set(`${botId}/${threadId}`, [...rw]); else this.lent.delete(`${botId}/${threadId}`);
  }

  lentTo(botId: string, threadId: string): readonly string[] {
    return this.lent.get(`${botId}/${threadId}`) ?? [];
  }

  /** What a spawn of `given` would get: its folder plan and the PATH it would run with, with nothing made, opened or minted.
   * `wrap` is built on it, so a lookup and the launch cannot see different boxes. */
  view(given: BoxRequest): { plan: BoxPlan; path: string | undefined } {
    const made = this.prepare(given, false);
    return { plan: made.plan, path: made.env.PATH };
  }

  private prepare(given: BoxRequest, make: boolean): { request: BoxRequest; plan: BoxPlan; env: Record<string, string>; seccomp: string | null } {
    const ids = given.cwd ? taskWorkspaceIds(given.cwd, this.options.setup.dataDir) : null;
    const { botId, threadId } = this.conversation(given);
    const lent = botId && threadId ? this.lentTo(botId, threadId) : [];
    const audience = this.audienceFor(given);
    const folders = this.foldersFor(given);
    // A limited bot working in a folder of its own choosing still has its own folder, and its conversation's uploads.
    const limitedOwn = folders?.limited && !given.home && !ids && botId ? { botId, threadId } : null;
    const uploads = ids ?? (limitedOwn?.threadId ? { botId: limitedOwn.botId, threadId: limitedOwn.threadId } : null);
    // Made before the box starts, so an upload a later turn adds shows up in a box that is still running.
    if (make && uploads) try { mkdirSync(boxUploadsDir(this.options.setup.dataDir, uploads.botId, uploads.threadId), { recursive: true, mode: 0o700 }); } catch (error) {
      // The bind stays optional, but an upload named later would then be unreadable in this box: say so.
      console.error(`bot box: could not make the uploads folder, so uploads stay unreadable in this box: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A room's turn in the bot's own folder: the team's notes and skills are bound read-only only where they exist, so
    // they are made first, or the turn could make them.
    const team = audience?.teamReadOnly && given.cwd ? teamFolderOf(botId, resolve(given.cwd), this.options.setup.dataDir) : null;
    if (make && team && under(resolve(given.cwd!), team) && existsSync(team)) {
      for (const name of TEAM_FOLDER_KEPT) if (name !== "MEMORY.md") try { mkdirSync(join(team, name), { recursive: true, mode: 0o700 }); } catch {}
    }
    const request: BoxRequest = {
      ...given, ...(lent.length ? { rw: [...(given.rw ?? []), ...lent] } : {}), ...(audience ? { audience } : {}), ...(folders ? { folders } : {}),
      ...(limitedOwn && !given.botId ? { botId: limitedOwn.botId } : {}), ...(limitedOwn?.threadId && !given.threadId ? { threadId: limitedOwn.threadId } : {}),
    };
    const seccomp = this.options.seccompFile && !this.options.setup.mutate?.has("no-seccomp") ? this.options.seccompFile : null;
    if (make && request.folders?.limited && !request.home) makeSignInProgramFolders(this.options.setup.home, this.options.setup.dataDir);
    const plan = planBox({ ...this.options.setup, seccompFd: seccomp ? BOX_SECCOMP_FD : undefined }, request);
    const mutate = this.options.setup.mutate;
    const env = mutate?.has("env-all")
      ? Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      : boxEnvironment(request.env, this.options.denyEnv, new Set(request.allowEnv ?? []));
    // The server's own PATH leaves out the programs in HOME (program-trust.ts); inside the box they are the bot's own.
    const homePrograms = homeProgramDirs(resolve(request.home ?? this.options.setup.home)).filter((dir) => !(env.PATH ?? "").split(":").includes(dir));
    if (homePrograms.length) env.PATH = [...(env.PATH ? [env.PATH] : []), ...homePrograms].join(":");
    return { request, plan, env, seccomp };
  }

  wrap(given: BoxRequest): WrappedSpawn {
    const { request, plan, env, seccomp } = this.prepare(given, true);
    const extraFds: number[] = [];
    if (plan.net === "isolated") {
      const proxy = `http://127.0.0.1:${this.options.egressPort ?? BOX_EGRESS_PORT}`;
      for (const name of BOX_PROXY_ENV) env[name] = proxy;
      // Node's env proxy matches an IPv6 host only bracketed; curl and the engines take the plain forms.
      for (const name of BOX_NO_PROXY_ENV) env[name] = "127.0.0.1,localhost,::1,[::1]";
    }
    const bridges = plan.net === "isolated" ? this.options.setup.bridges : [];
    const relay = plan.net === "isolated" && request.relay ? inBoxSocket(RELAY_SOCKET_NAME) : undefined;
    const inner = bridgedCommand(this.options.bridge, bridges, request.command, request.args, relay);
    const brokered = this.broker(env, plan, request);
    try {
      const vouched = (request.allowEnv ?? []).filter((name) => /(?:KEY|TOKEN|SECRET)$/.test(name) && brokered.env[name] !== undefined && brokered.env[name] === request.env[name]);
      const unbrokered = [...new Set([...brokered.unbrokered, ...vouched])];
      if (seccomp) extraFds.push(openSync(seccomp, "r"));
      return { command: this.options.bwrap, args: [...bwrapArgs(plan), "--", inner.command, ...inner.args], env: brokered.env, plan, token: brokered.token, release: brokered.release, unbrokered, extraFds };
    } catch (error) {
      for (const fd of extraFds) { try { closeSync(fd); } catch {} }
      brokered.release();
      throw error;
    }
  }

  /** Keys become a per-process token when the broker is on and the box has its own network (the bridge to the broker). */
  private broker(env: Record<string, string>, plan: BoxPlan, request: BoxRequest): { env: Record<string, string>; token: string | null; release(): void; unbrokered: string[] } {
    const broker = this.options.broker;
    if (!broker || plan.net !== "isolated") return { env, token: null, release: () => {}, unbrokered: [] };
    const ids = request.cwd ? taskWorkspaceIds(request.cwd, this.options.setup.dataDir) : null;
    // The token is minted first (its value goes in the environment), then granted exactly what the rewrite took out.
    // A process the bot's conversations share belongs to none of them.
    const threadId = request.botThreads ? null : ids?.threadId ?? null;
    const minted = broker.mintForProcess({ botId: plan.botId, threadId, grants: {} });
    const rewrite = brokerRewrite(env, minted.token, broker.port);
    broker.revoke(minted.token);
    if (!Object.keys(rewrite.grants).length) return { env, token: null, release: () => {}, unbrokered: rewrite.unbrokered };
    const granted = broker.mintForProcess({ botId: plan.botId, threadId, grants: rewrite.grants });
    const again = brokerRewrite(env, granted.token, broker.port);
    return { env: again.env, token: granted.token, release: () => broker.revoke(granted.token), unbrokered: again.unbrokered };
  }
}

export interface BoxChecks { passed: number; total: number; failed: string[]; at: number }

export interface BoxReport {
  box: BoxKind;
  reason: BoxDetection["reason"];
  /** The last self-check (box-probe.ts inside a real box): `passed/total`, null before it ran. */
  checks: BoxChecks | null;
  bridge: "socat" | "node" | null;
  /** Spawns boxed since boot, and what the gates refused. */
  boxed: number;
  refused: { egress: number; harness: number };
  /** The credential broker: on with the box; live tokens, calls forwarded and refused, and key names left raw. */
  broker: { on: boolean; tokens: number; forwarded: number; refused: number; unbrokered: string[] };
  /** The extra layers (T0c): the seccomp filter in every box, the host's /proc with hidepid, Fly's API socket root-only. */
  hardening: { seccomp: "on" | "off" | "unsupported"; denied: number; hidepid: boolean; flyApiPrivate: boolean };
}

/** The filter file, written once at start (0600) and handed to each box on a read-only descriptor. */
export function writeSeccompFile(dir: string): string | null {
  if (!seccompSupported()) return null;
  const file = join(dir, "seccomp.bpf");
  writeFileSync(file, seccompBytes(), { mode: 0o600 });
  return file;
}

/** Whether Fly's local API socket folder is root's alone (no bits for group or others). */
export function flyApiPrivate(stat: (path: string) => { mode: number } = statSync): boolean {
  try { return (stat("/.fly").mode & 0o077) === 0; } catch { return true; }
}

export interface StartOptions {
  dataDir: string;
  home: string;
  /** The server's loopback port: the harness gate forwards /api/internal/ there. */
  port: number;
  env?: Record<string, string | undefined>;
  denyEnv: ReadonlySet<string>;
  codeRoots?: readonly string[];
  engineRoots?: readonly string[];
  log?: (line: string) => void;
  /** Scope `limited`: the host's rules for bots' browsers, which the box narrows to never reach this computer. */
  limitedEgress?: () => EgressRules;
  /** Overrides for tests. */
  detect?: (env: Record<string, string | undefined>) => BoxDetection;
}

export function defaultCodeRoots(): string[] {
  const roots = [dirname(SERVER_ROOT)];
  const prefix = dirname(dirname(process.execPath));
  // An AppImage's runtime sits at the top of its own mount (/tmp/.mount_X/seira): that mount, not the folder holding it.
  const node = ["/", "/tmp", "/run", "/var/tmp"].includes(prefix) ? dirname(process.execPath) : prefix;
  if (!roots.some((root) => node.startsWith(root))) roots.push(node);
  return roots;
}

export class BotBox {
  private detection: BoxDetection = { box: "off", reason: "not-cloud", tools: null };
  private runner: BoxRunner | null = null;
  private egress: BoxEgressGate | null = null;
  private harness: HarnessGate | null = null;
  private credentials: CredentialBroker | null = null;
  private seccompFile: string | null = null;
  private checks: BoxChecks | null = null;
  private boxed = 0;
  private unbrokered = new Set<string>();
  private started: StartOptions | null = null;
  private audiences: BoxAudienceScope | null = null;
  private folders: BoxFolders | null = null;
  private boxScope: BoxScope = "all";
  private limitedWrites: LimitedWrites | null = null;
  private limitedFolders: string[] = [];
  private limitedSignIns: string[] = [];
  private limitedWritten = new Set<string>();
  private limitedSignInViews = new Map<string, { signIn: string; kept: readonly string[] }>();

  /** Detects, and when the box is on opens the gates. Safe to call once; returns what it decided. */
  async start(options: StartOptions): Promise<BoxDetection> {
    this.started = options;
    const env = options.env ?? process.env;
    this.detection = (options.detect ?? ((e) => detectBox({ env: e })))(env);
    const log = options.log ?? ((line: string) => console.log(line));
    if (this.detection.box !== "bwrap" || !this.detection.tools) {
      log(`bot box: off (${this.detection.reason})`);
      return this.detection;
    }
    this.boxScope = this.detection.scope ?? "all";
    const dir = join(options.dataDir, "box");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const egressSocket = join(dir, "egress.sock"), harnessSocket = join(dir, "harness.sock"), brokerSocket = join(dir, "broker.sock");
    for (const socket of [egressSocket, harnessSocket, brokerSocket]) rmSync(socket, { force: true });
    const limitedEgress = options.limitedEgress;
    const limitedRules = (): EgressRules => {
      try { return limitedEgress?.() ?? BOX_EGRESS_RULES; } catch { return BOX_EGRESS_RULES; }
    };
    this.egress = await openBoxEgressGate({
      socketPath: egressSocket,
      ...(this.boxScope === "limited" ? { decide: (target, addresses) => limitedBoxRefusal(target, addresses, limitedRules()) } : {}),
    });
    this.harness = await openHarnessGate({ socketPath: harnessSocket, port: options.port });
    this.credentials = await openCredentialBroker({ socketPath: brokerSocket });
    this.seccompFile = writeSeccompFile(dir);
    const bridges: BoxBridge[] = [
      { name: "egress", port: BOX_EGRESS_PORT, socket: egressSocket },
      { name: "harness", port: options.port, socket: harnessSocket },
      { name: "broker", port: BOX_BROKER_PORT, socket: brokerSocket },
    ];
    this.runner = new BoxRunner({
      bwrap: this.detection.tools.bwrap,
      bridge: { socat: this.detection.tools.socat, bridgeScript: BOX_BRIDGE_SCRIPT, node: process.execPath },
      setup: { dataDir: options.dataDir, home: options.home, codeRoots: options.codeRoots ?? defaultCodeRoots(), engineRoots: options.engineRoots ?? engineInstallRoots(options.dataDir), bridges },
      denyEnv: options.denyEnv, seccompFile: this.seccompFile,
      broker: { port: BOX_BROKER_PORT, mintForProcess: this.credentials.mintForProcess, revoke: this.credentials.revoke },
    });
    this.runner.scopeAudiences(this.audiences);
    this.runner.scopeFolders(this.folders);
    const botFolders = BOT_DATA_FOLDERS.map((name) => join(options.dataDir, name));
    // Security: with only some bots boxed, the unboxed ones and the person write HOME anyway, so its programs stay
    // trusted; a folder a limited box writes does not.
    if (this.boxScope === "all") distrustHomePrograms(options.home, [options.dataDir], botFolders);
    else {
      this.limitedSignIns = LIMITED_HOME_SIGN_INS.map((name) => resolve(options.home, name));
      this.limitedFolders = [...this.limitedSignIns, ...botFolders.map((path) => resolve(path))];
      distrustLimitedBoxFolders(this.limitedFolders, () => this.limitedChosenFolders(options.dataDir), () => this.limitedKeptFolders(options.home, options.dataDir));
    }
    resetPathCache();
    log(`bot box: on (${this.boxScope === "all" ? "every bot" : "bots limited to chosen folders"}; bubblewrap, ${this.detection.tools.socat ? "socat" : "node"} bridges, credential broker, seccomp ${this.seccompFile ? "on" : "unsupported here"})`);
    return this.detection;
  }

  /** The broker for callers that mint conversation-bound grants for `botId`'s boxes, or null when its spawns are not boxed. */
  broker(botId?: string | null): BoxBroker | null {
    const credentials = this.credentials;
    if (!credentials || !this.boxesBot(botId)) return null;
    return { port: BOX_BROKER_PORT, mintForThread: credentials.mintForThread, touchThread: credentials.touchThread, revokeThread: credentials.revokeThread, lookup: credentials.lookup };
  }

  /** The broker's socket, for a self-check that bridges it. */
  brokerSocket(): string | null { return this.credentials?.socketPath ?? null; }

  /** The filter file each box gets, for a self-check. */
  seccomp(): string | null { return this.seccompFile; }

  /** The plan and PATH of the box this spawn would run in, or null when it is not boxed here. Makes and opens nothing. */
  view(request: BoxRequest): { plan: BoxPlan; path: string | undefined } | null {
    if (!this.runner) return null;
    const folders = this.boxScope === "limited" ? this.runner.foldersFor(request) : null;
    if (this.boxScope === "limited" && folders?.limited !== true) return null;
    return this.runner.view(folders ? { ...request, folders } : request);
  }

  /** The box for one spawn, or null when this spawn is not boxed here. */
  wrap(request: BoxRequest): WrappedSpawn | null {
    if (!this.runner) return null;
    const folders = this.boxScope === "limited" ? this.runner.foldersFor(request) : null;
    if (this.boxScope === "limited" && folders?.limited !== true) return null;
    const wrapped = this.runner.wrap(folders ? { ...request, folders } : request);
    if (this.boxScope === "limited") this.noteLimitedWrites(wrapped.plan);
    this.boxed += 1;
    for (const name of wrapped.unbrokered) this.unbrokered.add(name);
    return wrapped;
  }

  /** Whether every bot spawn runs boxed. */
  enabled(): boolean { return this.runner !== null && this.boxScope === "all"; }

  /** Which spawns the box takes, or null when it is off. */
  scope(): BoxScope | null { return this.enabled() ? "all" : this.runner ? this.boxScope : null; }

  /** Whether the spawns of a bot with these folders run boxed. */
  boxesFolders(folders: TurnFolders | null | undefined): boolean {
    return this.enabled() || (this.runner !== null && folders?.limited === true);
  }

  /** Whether `botId`'s spawns run boxed now. */
  boxesBot(botId: string | null | undefined): boolean {
    return this.enabled() || (Boolean(botId) && this.boxesFolders(this.folders?.(botId!)));
  }

  /** Whether this spawn runs boxed: every one in scope `all`, else one of a bot with "Only chosen folders" on. */
  takes(request: Pick<BoxRequest, "cwd" | "threadId" | "conversationBot" | "botId" | "folders">): boolean {
    if (this.enabled()) return true;
    return this.runner?.foldersFor({ command: "", args: [], env: {}, ...request })?.limited === true;
  }

  /** A relay for one boxed spawn (BoxRequest.relay), or null unless every bot spawn is boxed here. */
  async openRelay(): Promise<BoxRelay | null> {
    const runner = this.runner;
    if (!runner || this.boxScope !== "all") return null;
    return openBoxRelay(join(runner.setup.dataDir, "box", `relay-${randomBytes(6).toString("hex")}.sock`));
  }

  /** The box a bot's Chrome runs in: the system read-only, private /tmp and /run, the host's network (the browser's own
   * gate filters it), `ro` paths, and nothing of HOME or the data folder; the launcher binds the one profile it starts
   * Chrome on. bubblewrap's options before `--`; null when turns are not boxed here. */
  browserBox(seccompFd: number, ro: readonly string[]): { bwrap: string; options: string[]; seccomp: string | null } | null {
    if (!this.runner || !this.detection.tools) return null;
    const setup = { ...this.runner.setup, engineRoots: [] };
    const seccomp = this.seccompFile && !setup.mutate?.has("no-seccomp") ? this.seccompFile : null;
    const plan = planBox({ ...setup, seccompFd: seccomp ? seccompFd : undefined }, { command: "chrome", args: [], env: {}, net: "shared", ro });
    const home = resolve(setup.home), dataDir = resolve(setup.dataDir);
    const mounts = plan.mounts.filter((mount) => !(mount.kind === "bind" && mount.target === home) && !(mount.kind === "tmpfs" && mount.target === dataDir));
    return { bwrap: this.detection.tools.bwrap, options: bwrapArgs({ ...plan, mounts }), seccomp };
  }

  /** On a Team Cloud: the audience rule for every box (server/host/team-box-scope.ts). Kept for a box started later. */
  scopeAudiences(scope: BoxAudienceScope | null): void { this.audiences = scope; this.runner?.scopeAudiences(scope); }

  /** Each bot's folder list for every box: from now on, and for a box started later. Null takes it away. */
  scopeFolders(folders: BoxFolders | null): void { this.folders = folders; this.runner?.scopeFolders(folders); }

  /** The folders the limited bots may change, read each time the server checks where it may run a program. Null takes
   * it away. */
  scopeLimitedWrites(writes: LimitedWrites | null): void { this.limitedWrites = writes; }

  /** Besides the folders a limited box always writes: those the host names now, and every folder a box here was given
   * until the box stops. */
  private limitedChosenFolders(dataDir: string): string[] {
    const data = resolve(dataDir);
    // A grant in or around the data folder is never bound, and distrusting one around it would hide the app's engines.
    const named = (this.limitedWrites?.() ?? []).filter((path) => isAbsolute(path)).map((path) => resolve(path)).filter((path) => !under(path, data) && !under(data, path));
    return [...named, ...this.limitedWritten];
  }

  /** What a limited box can write, kept until the box stops: each folder it was given, and of each sign-in folder, the
   * folders in it that it had read-only. */
  private noteLimitedWrites(plan: BoxPlan): void {
    for (const path of plan.writable.map((given) => resolve(given))) {
      if (this.limitedSignIns.includes(path)) {
        const kept = plan.mounts.filter((mount) => mount.kind === "ro" && mount.target !== path && under(mount.target, path) && visibleInBox(plan, mount.target) === "ro").map((mount) => mount.target).sort();
        this.limitedSignInViews.set([path, ...kept].join("\0"), { signIn: path, kept });
      } else if (this.limitedSignIns.some((signIn) => under(path, signIn)) || !this.limitedFolders.some((dir) => under(path, dir))) {
        this.limitedWritten.add(path);
        // Security: the box keeps the folder it was bound to when a link on the way changes later.
        try { this.limitedWritten.add(realpathSync(path)); } catch {}
      }
    }
  }

  /** The program folders in the sign-in folders that a limited box has read-only, but those that a box here had writable
   * before, as when a link there came to pass another folder of its sign-in folder. */
  private limitedKeptFolders(home: string, dataDir: string): string[] {
    const views = [...this.limitedSignInViews.values()];
    return signInPrograms(home, dataDir).readOnly.filter((dir) => views.every((view) => !under(dir, view.signIn) || view.kept.some((kept) => under(dir, kept))));
  }

  /** The bot's folder list for one box now, as a key (foldersKey); null with no setting. */
  foldersKey(request: Pick<BoxRequest, "cwd" | "threadId" | "conversationBot">): string | null {
    return foldersKey(this.runner?.foldersFor({ command: "", args: [], env: {}, ...request }));
  }

  /** What a process the bot's conversations share is boxed with, as a key: the conversations its box puts back on a
   * Team Cloud, so a conversation made after it started gets a process whose box has its folder, and the bot's folder
   * list. Null elsewhere. */
  sharedThreadsKey(request: Pick<BoxRequest, "cwd" | "threadId" | "conversationBot">): string | null {
    const audience = this.runner?.audienceFor({ command: "", args: [], env: {}, ...request, botThreads: true });
    const threads = audience?.threads ? [audience.threads.rw, audience.threads.ro, audience.teamFiles?.write ?? null] : null;
    const folders = this.foldersKey(request);
    return folders ? JSON.stringify([threads, folders]) : threads ? JSON.stringify(threads) : null;
  }

  /** What the audience rule and the bot's folder list give one box now, as a key: what a process kept between turns is
   * started again on. */
  audienceKey(request: Pick<BoxRequest, "cwd" | "threadId" | "conversationBot">): string | null {
    const audience = this.runner?.audienceFor({ command: "", args: [], env: {}, ...request });
    const rule = audience ? [audience.teamReadOnly, audience.teamFiles?.write ?? null] : null;
    const folders = this.foldersKey(request);
    return folders ? JSON.stringify([rule, folders]) : rule ? JSON.stringify(rule) : null;
  }

  /** More read-write folders for one conversation's boxes (a memory layer); nothing without a runner. */
  lend(botId: string, threadId: string, rw: readonly string[]): void { this.runner?.lend(botId, threadId, rw); }

  tools(): { bwrap: string; socat: string | null } | null { return this.detection.tools; }

  noteChecks(checks: BoxChecks): void { this.checks = checks; }

  report(): BoxReport {
    return {
      box: this.detection.box,
      reason: this.detection.reason,
      checks: this.checks,
      bridge: this.detection.tools ? (this.detection.tools.socat ? "socat" : "node") : null,
      boxed: this.boxed,
      refused: { egress: this.egress?.refused ?? 0, harness: this.harness?.refused ?? 0 },
      broker: { on: this.credentials !== null, ...(this.credentials?.stats() ?? { tokens: 0, forwarded: 0, refused: 0 }), unbrokered: [...this.unbrokered].sort() },
      hardening: {
        seccomp: this.runner ? (this.seccompFile ? "on" : "unsupported") : "off", denied: this.seccompFile ? DENIED_SYSCALLS.length : 0,
        hidepid: process.platform === "linux" && procHidepid(), flyApiPrivate: process.platform === "linux" && existsSync("/.fly") ? flyApiPrivate() : true,
      },
    };
  }

  startOptions(): StartOptions | null { return this.started; }

  async stop(): Promise<void> {
    await Promise.all([this.egress?.close(), this.harness?.close(), this.credentials?.close()]);
    this.egress = null;
    this.harness = null;
    this.credentials = null;
    this.seccompFile = null;
    this.runner = null;
    this.boxScope = "all";
    this.limitedFolders = [];
    this.limitedSignIns = [];
    this.limitedWritten.clear();
    this.limitedSignInViews.clear();
    distrustHomePrograms(null);
    distrustLimitedBoxFolders(null);
    resetPathCache();
  }
}

export const botBox = new BotBox();
