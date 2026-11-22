// Install Seira on the person's own server over SSH (main process only). One session is one connection: it confirms the
// host key, finds out how to get administrator rights, uploads the bundled installer to a private folder, runs its checks,
// installs, passes the emailed sign-in code, then hands the pairing link to the app's add-a-server path.
// Password, passphrase, key and emailed code live only in the fields of a session. They are never written, logged or sent
// to the page.
import { createHash, createPrivateKey } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSavedHosts, fingerprint, hostKeySources, hostKeyStatus, keyType, knownTypes, parseKnownHosts, preferredHostKeyAlgorithms } from "./vps-install-hosts.mjs";

export const CONNECT_TIMEOUT_MS = 15_000;
export const CANCEL_BUDGET_MS = 1_500;
const QUICK_MS = 30_000;
const DONE_GRACE_MS = 5_000;
const KEY_FILE_LIMIT = 64 * 1024;

export function readKeyFile(file) {
  if (!file) throw new Error("no file");
  const real = realpathSync(file);
  if (!statSync(real).isFile()) throw new Error("not a file");
  const fd = openSync(real, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("not a file");
    const buffer = Buffer.alloc(KEY_FILE_LIMIT + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > KEY_FILE_LIMIT) throw new Error("too large");
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}
const OLD_PEM_EXPORT = { RSA: { type: "pkcs1", kind: "rsa" }, EC: { type: "sec1", kind: "ec" } };
const OLD_PEM_CIPHERS = new Set(["aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "des-ede3-cbc"]);

/**
 * The bundled ssh2 refuses an encrypted old PEM key ("BEGIN RSA|DSA|EC PRIVATE KEY" with "Proc-Type: 4,ENCRYPTED"),
 * because that format derives its key with MD5. Node crypto opens it here, and ssh2 gets the unencrypted key without
 * a passphrase. Any other key comes back as it is.
 */
export function openOldPemKey(key, passphrase) {
  const lines = key.toString("utf8").trim().split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const kind = ["RSA", "DSA", "EC"].find((name) => lines[0] === `-----BEGIN ${name} PRIVATE KEY-----`);
  if (!kind) return key;
  const headers = [];
  for (let index = 1; index < lines.length && lines[index].indexOf(":") > 0; index += 1) headers.push(lines[index].replaceAll(" ", ""));
  const dek = headers.find((line) => line.startsWith("DEK-Info:"));
  if (!dek && !headers.includes("Proc-Type:4,ENCRYPTED")) return key;
  if (!passphrase) throw new InstallFailure("keyNeedsPassphrase");
  const target = OLD_PEM_EXPORT[kind];
  if (!target) throw new InstallFailure("keyOldFormat");
  let opened;
  try {
    opened = createPrivateKey({ key, format: "pem", passphrase });
  } catch {
    const cipher = (dek ?? "").slice("DEK-Info:".length).split(",")[0].toLowerCase();
    throw new InstallFailure(OLD_PEM_CIPHERS.has(cipher) ? "keyPassphrase" : "keyOldFormat");
  }
  if (opened.asymmetricKeyType !== target.kind) throw new InstallFailure("keyOldFormat");
  return Buffer.from(opened.export({ type: target.type, format: "pem" }));
}

const NO_TERMINAL = /must have a tty|requiretty|no tty present|a terminal is required/i;
const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";
const TEMP_DIR = /^\/(?:[A-Za-z0-9._-]+\/)*seira-install\.[A-Za-z0-9]+$/;
const EMAIL = /^[^\s'"\\<>`$;&|(){}]+@[^\s'"\\<>`$;&|(){}@]+\.[^\s'"\\<>`$;&|(){}@]+$/;

/** A failure the page words itself: `reason` names it, `step` and `sentence` are the installer's own. */
export class InstallFailure extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.step = extra.step ?? null;
    this.sentence = extra.sentence ?? null;
    this.source = extra.source ?? null;
  }
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** `host`, `host:port`, `[v6]:port` or `ssh://host:port` as typed, or null. */
export function parseAddress(input) {
  const text = String(input ?? "").trim().replace(/^ssh:\/\//i, "").replace(/\/+$/, "");
  if (!text || /\s/.test(text) || text.includes("@")) return null;
  let host = text, port = 22;
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracket) { host = bracket[1]; if (bracket[2]) port = Number(bracket[2]); }
  else if ((text.match(/:/g) ?? []).length === 1) { const [name, given] = text.split(":"); host = name; port = Number(given); }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && !/^[0-9a-fA-F:.]+$/.test(host)) return null;
  return { host, port };
}

const sanitize = (text) => Array.from(String(text ?? ""), (char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char)).join("").trim().slice(0, 300);

/** One `::seira` line of the installer's output as an event, or null for any other line. */
export function parseSeiraLine(line) {
  if (!line.startsWith("::seira ")) return null;
  const [kind, ...rest] = line.slice(8).split(" ");
  const text = (from) => sanitize(rest.slice(from).join(" "));
  if (kind === "check" && rest.length >= 2 && ["ok", "fix", "note"].includes(rest[1])) return { type: "check", id: rest[0], level: rest[1], sentence: text(2) };
  if (kind === "checks" && (rest[0] === "ok" || rest[0] === "fix")) return { type: "checks", result: rest[0] };
  if (kind === "step" && rest.length >= 2 && ["start", "done", "fail"].includes(rest[1])) return { type: "step", id: rest[0], state: rest[1], sentence: text(2) };
  if (kind === "ask" && rest[0] === "code") return { type: "ask", email: text(1) };
  if (kind === "address") return { type: "address", url: rest.join(" ") };
  if (kind === "pair") return { type: "pair", url: rest.join(" ") };
  if (kind === "done") return { type: "done" };
  if (kind === "fail") return { type: "fail", sentence: text(0) };
  return null;
}

const TUNNEL_HOST = /^c-[0-9a-f]{32}\./;

function tunnelSuffix() {
  const given = String(process.env.SEIRA_TUNNEL_HOST_SUFFIX ?? "").trim().toLowerCase();
  return given ? (given.startsWith(".") ? given : `.${given}`) : ".seira.run";
}

function pairingLink(url, addressUrl) {
  try {
    const text = String(url).trim();
    const parsed = new URL(text), announced = new URL(String(addressUrl).trim());
    return parsed.protocol === "https:" && parsed.origin === announced.origin && TUNNEL_HOST.test(parsed.hostname) && parsed.hostname.endsWith(tunnelSuffix())
      && /(?:^|[#&])code=/.test(parsed.hash) && text.length < 2048 ? text : null;
  } catch { return null; }
}

/** The bundled installer: the resources folder in a packaged app, the repository's own file in development. */
export function installerPath({ packaged, resourcesPath }) {
  return packaged ? path.join(resourcesPath, "installer", "install.sh") : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "install.sh");
}

export function defaultCreateClient() {
  const { Client } = createRequire(import.meta.url)("./vendor/ssh2.cjs");
  return new Client();
}

function ssh2Utils() { return createRequire(import.meta.url)("./vendor/ssh2.cjs").utils; }

export function agentSocket(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  return platform === "win32" && exists(WINDOWS_AGENT_PIPE) ? WINDOWS_AGENT_PIPE : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `work`, or what `give()` returns once `ms` pass; the timer never outlives the race. */
async function within(work, ms, give) {
  let timer;
  try {
    return await Promise.race([work, new Promise((resolve, reject) => { timer = setTimeout(() => { try { resolve(give()); } catch (error) { reject(error); } }, ms); })]);
  } finally { clearTimeout(timer); }
}

function connectFailure(error, flags) {
  if (flags.changed) return new InstallFailure("hostKeyChanged", { source: flags.source });
  if (flags.declined) return new InstallFailure("hostKeyDeclined");
  if (flags.limited && error?.level === "handshake" && /host key/i.test(error.message ?? "")) return new InstallFailure("hostKeyChanged", { source: flags.source });
  if (error?.level === "client-authentication") return new InstallFailure("auth");
  if (error?.level === "client-timeout" || error?.code === "ETIMEDOUT" || flags.timedOut) return new InstallFailure("timeout");
  return new InstallFailure("unreachable");
}

/**
 * @typedef {{ type: string, [key: string]: unknown }} InstallEvent
 * @param {{
 *   emit(event: InstallEvent): void,
 *   addServer(url: string): Promise<{ outcome?: string } | boolean | void>,
 *   installer: string,
 *   savedHosts: { read(): any[], remember(entry: { host: string, port: number, fingerprint: string, type?: string }): void, forget(entry: { host: string, port: number }): void },
 *   knownHostsFile?: string,
 *   createClient?: () => any,
 *   connectTimeoutMs?: number,
 *   agent?: string | null,
 * }} deps
 */
export function createInstallSession(deps) {
  const { emit: send, addServer, installer, savedHosts, createClient = defaultCreateClient, connectTimeoutMs = CONNECT_TIMEOUT_MS } = deps;
  const knownHostsFile = deps.knownHostsFile ?? path.join(os.homedir(), ".ssh", "known_hosts");
  const agent = deps.agent === undefined ? agentSocket() : deps.agent;

  let secrets = null;
  let client = null;
  let target = null;
  let email = null;
  let directory = null;
  let elevation = "root";
  let pendingHostKey = null;
  let installerStream = null;
  let waitingForCode = false;
  let codeSent = false;
  let lastChecks = null;
  let lastStep = null;
  let stage = "idle";
  let finished = false;
  let closing = false;
  let linkClosed = false;
  let cancelled = false;
  let making = null;
  let lastLink = null;
  const flags = { changed: false, declined: false, timedOut: false, limited: false, source: null };
  let conflict = null;
  const sourceOf = (system, saved) => (system && saved ? "both" : system ? "system" : "saved");
  let armTimer = () => {};

  const scrub = (text) => {
    if (typeof text !== "string") return text ?? null;
    for (const secret of secrets ? [secrets.password, secrets.sudoPassword, secrets.passphrase] : []) if (secret && secret.length >= 3 && text.includes(secret)) return null;
    return text;
  };
  const emit = (event) => {
    if (finished && event.type !== "cancelled" && event.type !== "failed" && event.type !== "connected") return;
    const clean = { ...event };
    if ("sentence" in clean) clean.sentence = scrub(clean.sentence);
    if (Array.isArray(clean.items)) clean.items = clean.items.map((item) => ({ ...item, sentence: scrub(item.sentence) }));
    send(clean);
  };
  const drop = () => {
    if (secrets?.key) secrets.key.fill(0);
    secrets = null;
    pendingHostKey = null;
    waitingForCode = false;
    armTimer = () => {};
    const link = lastLink;
    lastLink = null;
    if (link) {
      try { link.removeAllListeners(); link.on("error", () => {}); } catch { /* already gone */ }
      for (const field of ["password", "privateKey", "passphrase"]) {
        if (link.config && field in link.config) link.config[field] = undefined;
      }
    }
  };

  function prepare(request) {
    const address = parseAddress(request.address);
    if (!address) throw new InstallFailure("address");
    const user = String(request.user ?? "").trim() || "root";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new InstallFailure("user");
    const account = String(request.email ?? "").trim();
    if (account.length > 254 || !EMAIL.test(account)) throw new InstallFailure("email");
    const method = request.method === "key" ? "key" : request.method === "agent" ? "agent" : "password";
    const password = typeof request.password === "string" ? request.password : "";
    const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
    const sudoPassword = typeof request.sudoPassword === "string" && request.sudoPassword ? request.sudoPassword : password;
    let key = null;
    let sshPassphrase = passphrase;
    if (method === "password" && !password) throw new InstallFailure("auth");
    if (method === "agent" && !agent) throw new InstallFailure("auth");
    if (method === "key") {
      try {
        key = readKeyFile(String(request.keyPath ?? ""));
      } catch { throw new InstallFailure("keyUnreadable"); }
      const opened = openOldPemKey(key, passphrase);
      if (opened !== key) {
        key.fill(0);
        key = opened;
        sshPassphrase = "";
      }
      const parsed = ssh2Utils().parseKey(key, sshPassphrase || undefined);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first instanceof Error) {
        if (/passphrase/i.test(first.message)) throw new InstallFailure(passphrase ? "keyPassphrase" : "keyNeedsPassphrase");
        throw new InstallFailure("keyUnreadable");
      }
      if (typeof first?.isPrivateKey === "function" && !first.isPrivateKey()) throw new InstallFailure("keyUnreadable");
    }
    return { address, user, account, method, password, passphrase, sshPassphrase, sudoPassword, key };
  }

  function connect() {
    return new Promise((resolve, reject) => {
      let timer = null;
      let ready = false;
      armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { flags.timedOut = true; reject(connectFailure(null, flags)); try { link.destroy(); } catch { /* already closed */ } }, connectTimeoutMs);
      };
      const link = createClient();
      client = link;
      lastLink = link;
      const known = (() => { try { return readFileSync(knownHostsFile, "utf8"); } catch { return ""; } })();
      const types = [...new Set([...savedHosts.read().filter((item) => item.type && item.host.toLowerCase() === target.host.toLowerCase() && item.port === target.port).map((item) => item.type),
        ...knownTypes(parseKnownHosts(known), target.host, target.port)])];
      const config = {
        host: target.host, port: target.port, username: secrets.user,
        readyTimeout: 0, keepaliveInterval: 10_000, tryKeyboard: secrets.method === "password",
        hostVerifier: (blob, verify) => {
          const status = hostKeyStatus({ host: target.host, port: target.port, key: blob, knownHosts: known, saved: savedHosts.read() });
          if (status === "known") return true;
          if (status === "changed") {
            const where = { host: target.host, port: target.port, key: blob };
            flags.source = sourceOf(hostKeyStatus({ ...where, knownHosts: known, saved: [] }) === "changed", hostKeyStatus({ ...where, knownHosts: "", saved: savedHosts.read() }) === "changed");
            flags.changed = true;
            return false;
          }
          clearTimeout(timer);
          pendingHostKey = { verify, fingerprint: fingerprint(blob), type: keyType(blob) };
          emit({ type: "hostKey", host: target.host, port: target.port, fingerprint: pendingHostKey.fingerprint });
          return undefined;
        },
      };
      if (types.length) {
        config.algorithms = { serverHostKey: preferredHostKeyAlgorithms(types) };
        flags.limited = true;
        const held = hostKeySources({ host: target.host, port: target.port, knownHosts: known, saved: savedHosts.read() });
        flags.source = sourceOf(held.system, held.saved);
      }
      if (secrets.method === "password") config.password = secrets.password;
      else if (secrets.method === "key") { config.privateKey = secrets.key; if (secrets.sshPassphrase) config.passphrase = secrets.sshPassphrase; }
      else config.agent = agent;
      link.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => secrets?.password ?? "")));
      link.on("ready", () => { ready = true; clearTimeout(timer); resolve(); });
      link.on("error", (error) => {
        clearTimeout(timer);
        if (!ready) reject(connectFailure(error, flags));
        else void fail(new InstallFailure("dropped", { step: lastStep }));
      });
      link.on("close", () => {
        linkClosed = true;
        clearTimeout(timer);
        if (!ready) reject(connectFailure(null, flags));
        else if (!closing) void fail(new InstallFailure("dropped", { step: lastStep }));
      });
      armTimer();
      link.connect(config);
    });
  }

  function open(command, onLine = null) {
    return new Promise((resolve, reject) => {
      if (!client) { reject(new InstallFailure("dropped", { step: lastStep })); return; }
      client.exec(command, (error, stream) => {
        if (error) { reject(new InstallFailure("dropped", { step: lastStep })); return; }
        let stdout = "", stderr = "";
        let tail = "";
        const closed = new Promise((done) => {
          stream.on("close", (code) => done({ code: typeof code === "number" ? code : null, stdout, stderr }));
          stream.on("error", () => {});
        });
        stream.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          if (stdout.length < 65_536) stdout += text;
          tail += text;
          let at;
          while ((at = tail.indexOf("\n")) !== -1) { const line = tail.slice(0, at).replace(/\r$/, ""); tail = tail.slice(at + 1); onLine?.(line); }
          if (tail.length > 65_536) tail = "";
        });
        stream.stderr.on("data", (chunk) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
        resolve({ stream, closed });
      });
    });
  }

  async function run(command, { input = null } = {}) {
    const { stream, closed } = await open(command);
    if (input !== null) stream.end(input); else stream.end();
    return within(closed, QUICK_MS, () => { throw new InstallFailure("timeout", { step: lastStep }); });
  }

  const prefix = () => (elevation === "root" ? "" : elevation === "sudo" ? "sudo -n " : "sudo -S -p '' ");

  async function detectAdministrator() {
    emit({ type: "phase", phase: "rights" });
    const who = await run("id -u");
    if (who.stdout.trim() === "0") { elevation = "root"; return; }
    const quiet = await run("sudo -n true");
    if (quiet.code === 0) { elevation = "sudo"; return; }
    if (NO_TERMINAL.test(quiet.stderr)) throw new InstallFailure("sudoRefused");
    if (!secrets.sudoPassword) throw new InstallFailure(secrets.method === "password" ? "notAdmin" : "adminPasswordNeeded");
    const asked = await run("sudo -S -p '' -v", { input: `${secrets.sudoPassword}\n` });
    if (asked.code === 0) { elevation = "sudo-password"; return; }
    if (NO_TERMINAL.test(asked.stderr)) throw new InstallFailure("sudoRefused");
    if (/not in the sudoers|may not run sudo|not allowed|command not found|not found/i.test(asked.stderr)) throw new InstallFailure("notAdmin");
    throw new InstallFailure("sudoPassword");
  }

  async function upload() {
    emit({ type: "phase", phase: "upload" });
    making = run("mktemp -d /tmp/seira-install.XXXXXXXXXX");
    const made = await making;
    const folder = made.stdout.trim();
    if (made.code !== 0 || !TEMP_DIR.test(folder)) throw new InstallFailure("upload");
    directory = folder;
    if (finished) throw new InstallFailure("dropped");
    const bytes = readFileSync(installer);
    const sent = await run(`cat > ${shellQuote(`${folder}/install.sh`)}`, { input: bytes });
    if (sent.code !== 0) throw new InstallFailure("upload");
    const file = shellQuote(`${folder}/install.sh`);
    const sum = await run(`sha256sum ${file} 2>/dev/null || shasum -a 256 ${file}`);
    const remote = sum.stdout.trim().split(/\s+/)[0]?.toLowerCase();
    if (remote !== createHash("sha256").update(bytes).digest("hex")) throw new InstallFailure("upload");
  }

  const script = (args) => `${prefix()}sh ${shellQuote(`${directory}/install.sh`)} ${args}`;

  async function runScript(args, onEvent) {
    const { stream, closed } = await open(script(args), (line) => { const event = parseSeiraLine(line); if (event) onEvent(event); });
    installerStream = stream;
    if (elevation === "sudo-password") stream.write(`${secrets.sudoPassword}\n`);
    return closed;
  }

  async function runChecks() {
    emit({ type: "phase", phase: "checking" });
    stage = "checking";
    const items = [];
    let result = null, failed = null;
    await runScript("--check --tunnel --events", (event) => {
      if (event.type === "check") { items.push({ id: event.id, level: event.level, sentence: event.sentence }); emit({ type: "check", id: event.id, level: event.level, sentence: event.sentence }); }
      else if (event.type === "checks") result = event.result;
      else if (event.type === "fail") failed = event.sentence;
    });
    installerStream = null;
    if (result === null) throw new InstallFailure("installer", { step: "checks", sentence: failed });
    lastChecks = { items, result };
    stage = "checked";
    emit({ type: "checks", result, items });
  }

  async function removeTemporaryFolder() {
    if (!directory || !client || closing) return;
    const folder = directory;
    directory = null;
    if (!TEMP_DIR.test(folder)) return;
    try {
      const plain = await run(`rm -rf -- ${shellQuote(folder)} 2>/dev/null; test ! -e ${shellQuote(folder)}`);
      if (plain.code === 0 || elevation === "root") return;
      await run(`${prefix()}rm -rf -- ${shellQuote(folder)}`, { input: elevation === "sudo-password" ? `${secrets?.sudoPassword ?? ""}\n` : null });
    } catch { /* the connection is gone; nothing more can be removed */ }
  }

  function closeConnection() {
    closing = true;
    const link = client;
    client = null;
    if (!link) return;
    try { link.end(); } catch { /* already closed */ }
    setTimeout(() => { try { link.destroy(); } catch { /* already closed */ } }, 500).unref?.();
  }

  async function fail(error) {
    if (finished) return;
    const failure = error instanceof InstallFailure ? error : new InstallFailure("unreachable");
    if (failure.reason === "hostKeyChanged" && failure.source === "saved" && target) conflict = { host: target.host, port: target.port };
    emit({ type: "failed", reason: failure.reason, step: failure.step, sentence: failure.sentence, ...(failure.source ? { source: failure.source } : {}) });
    finished = true;
    await within(removeTemporaryFolder(), CANCEL_BUDGET_MS, () => undefined);
    closeConnection();
    drop();
  }

  async function finishWithPairing(url) {
    if (cancelled || finished) return;
    finished = true;
    await within(removeTemporaryFolder(), CANCEL_BUDGET_MS, () => undefined);
    closeConnection();
    drop();
    if (cancelled) return;
    let outcome;
    try { outcome = await addServer(url); } catch { outcome = { outcome: "problem" }; }
    const ok = outcome === true || outcome === undefined || (typeof outcome === "object" && outcome?.outcome === "connected");
    send(ok ? { type: "connected" } : { type: "failed", reason: "pairFailed", step: "pair", sentence: null });
  }

  async function runInstall(installDocker) {
    stage = "installing";
    emit({ type: "phase", phase: "installing" });
    const args = `--tunnel --events --account-email ${shellQuote(email)}${installDocker ? " --install-docker" : ""}`;
    let pair = null, pairSeen = false, announced = "", failedStep = null, failedSentence = null, fatal = null;
    let asks = 0, announce = () => {}, doneSeen = () => {};
    const pairWait = new Promise((resolve) => { announce = resolve; });
    const doneWait = new Promise((resolve) => { doneSeen = resolve; });
    const closed = await runScript(args, (event) => {
      if (event.type === "step") {
        emit({ type: "step", id: event.id, state: event.state, sentence: event.sentence || null });
        if (event.state === "start") lastStep = event.id;
        if (event.state === "fail") { failedStep = event.id; failedSentence = event.sentence || null; }
      } else if (event.type === "ask") { asks += 1; codeSent = false; waitingForCode = true; stage = "code"; emit({ type: "askCode", email, ...(asks > 1 ? { again: true } : {}) }); }
      else if (event.type === "address") announced = event.url;
      else if (event.type === "pair") { pair = pairingLink(event.url, announced); pairSeen = true; announce(); }
      else if (event.type === "done") doneSeen();
      else if (event.type === "fail") fatal = event.sentence;
    });
    await Promise.race([closed, pairWait]);
    if (pairSeen && pair) {
      await within(Promise.race([closed, doneWait]), DONE_GRACE_MS, () => undefined);
      await finishWithPairing(pair);
      return;
    }
    await delay(100);
    if (finished) return;
    if (linkClosed) throw new InstallFailure("dropped", { step: failedStep ?? lastStep });
    throw new InstallFailure(pairSeen ? "pairFailed" : "installer", { step: failedStep ?? lastStep, sentence: failedSentence ?? fatal });
  }

  return {
    stage: () => stage,

    async start(request) {
      if (stage !== "idle") return;
      stage = "connecting";
      try {
        const prepared = prepare(request);
        target = prepared.address;
        email = prepared.account;
        secrets = { user: prepared.user, method: prepared.method, password: prepared.password, passphrase: prepared.passphrase, sshPassphrase: prepared.sshPassphrase, sudoPassword: prepared.sudoPassword, key: prepared.key };
        emit({ type: "phase", phase: "connecting" });
        await connect();
        await detectAdministrator();
        await upload();
        await runChecks();
      } catch (error) {
        await fail(error);
      }
    },

    acceptHostKey() {
      if (!pendingHostKey || finished) return false;
      const { verify, fingerprint: seen, type: pendingType } = pendingHostKey;
      pendingHostKey = null;
      try { savedHosts.remember({ host: target.host, port: target.port, fingerprint: seen, type: pendingType }); } catch { /* the answer still counts for this run */ }
      armTimer();
      verify(true);
      return true;
    },

    rejectHostKey() {
      if (!pendingHostKey) return false;
      const { verify } = pendingHostKey;
      pendingHostKey = null;
      flags.declined = true;
      verify(false);
      return true;
    },

    async check() {
      if (stage !== "checked" || finished) return false;
      try { await runChecks(); } catch (error) { await fail(error); }
      return true;
    },

    async install({ installDocker = false } = {}) {
      if (stage !== "checked" || finished || !lastChecks) return false;
      const fixes = lastChecks.items.filter((item) => item.level === "fix");
      const dockerInstall = fixes.some((item) => item.id === "docker-install");
      if (fixes.some((item) => item.id !== "docker-install") || (dockerInstall && installDocker !== true)) return false;
      try { await runInstall(dockerInstall); } catch (error) { await fail(error); }
      return true;
    },

    sendCode(code) {
      const digits = String(code ?? "").trim();
      if (!waitingForCode || codeSent || !installerStream || !/^\d{8}$/.test(digits)) return false;
      codeSent = true;
      waitingForCode = false;
      stage = "installing";
      installerStream.write(`code ${digits}\n`);
      return true;
    },

    forgetHost() {
      if (!conflict) return false;
      const { host, port } = conflict;
      conflict = null;
      savedHosts.forget({ host, port });
      return true;
    },

    async cancel() {
      if (finished) return;
      finished = true;
      cancelled = true;
      if (making) await within(making.catch(() => undefined), CANCEL_BUDGET_MS, () => undefined);
      if (pendingHostKey) { const { verify } = pendingHostKey; pendingHostKey = null; try { verify(false); } catch { /* handshake already ended */ } }
      try { installerStream?.signal?.("TERM"); } catch { /* the server ignores signals */ }
      await within(removeTemporaryFolder(), CANCEL_BUDGET_MS, () => undefined);
      closeConnection();
      drop();
      send({ type: "cancelled" });
    },
  };
}

const EVENT_CHANNEL = "server-install:event";
const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");

/**
 * The page's side of the flow: one session at a time, started from the person's click on this app's own page.
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   guard(handler: (...args: any[]) => unknown): (...args: any[]) => unknown,
 *   dialog: { showOpenDialog(options: object): Promise<{ canceled: boolean, filePaths: string[] }> },
 *   add(url: string): Promise<unknown>,
 *   dataDir: string,
 *   resourcesPath: string,
 *   packaged: boolean,
 *   createClient?: () => any,
 * }} deps
 */
export function installVpsInstall({ ipcMain, guard, dialog, add, dataDir, resourcesPath, packaged, createClient }) {
  const savedHosts = createSavedHosts({ dir: dataDir });
  let current = null;
  let pickedKey = null;
  const handle = (channel, handler) => ipcMain.handle(`server-install:${channel}`, guard(handler));
  handle("info", () => ({ agent: Boolean(agentSocket()) }));
  handle("pick-key", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openFile", "showHiddenFiles"], defaultPath: path.join(os.homedir(), ".ssh") });
    pickedKey = picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
    return pickedKey ? { name: path.basename(pickedKey) } : null;
  });
  handle("start", async (event, request) => {
    const previous = current;
    previous?.cancel();
    const sender = event.sender;
    const session = createInstallSession({
      installer: installerPath({ packaged, resourcesPath }), savedHosts, addServer: add, createClient,
      emit: (message) => {
        if (current !== session) return;
        const ends = message.type === "connected" || message.type === "failed" || message.type === "cancelled";
        if (ends) pickedKey = null;
        if (!sender.isDestroyed()) sender.send(EVENT_CHANNEL, message);
        if (ends && !(message.type === "failed" && message.reason === "hostKeyChanged" && message.source === "saved")) {
          unwatch();
          if (current === session) current = null;
        }
      },
    });
    current = session;
    const stop = () => { void session.cancel(); };
    const onNavigate = (details, _url, _inPlace, isMainFrame) => { if ((details?.isMainFrame ?? isMainFrame) !== false) stop(); };
    const unwatch = () => {
      sender.removeListener?.("destroyed", stop);
      sender.removeListener?.("render-process-gone", stop);
      sender.removeListener?.("did-start-navigation", onNavigate);
    };
    sender.once("destroyed", stop);
    sender.on?.("render-process-gone", stop);
    sender.on?.("did-start-navigation", onNavigate);
    const input = request && typeof request === "object" ? request : {};
    void session.start({
      address: text(input.address, 300), user: text(input.user, 80), email: text(input.email, 300), method: text(input.method, 10),
      password: text(input.password, 1024), sudoPassword: text(input.sudoPassword, 1024), passphrase: text(input.passphrase, 1024), keyPath: pickedKey ?? "",
    });
    return true;
  });
  handle("forget-host", () => current?.forgetHost() ?? false);
  handle("accept-host-key", () => current?.acceptHostKey() ?? false);
  handle("reject-host-key", () => current?.rejectHostKey() ?? false);
  handle("check", () => current?.check() ?? false);
  handle("install", (_event, options) => current?.install({ installDocker: options?.installDocker === true }) ?? false);
  handle("send-code", (_event, code) => current?.sendCode(text(code, 16)) ?? false);
  handle("cancel", async () => { pickedKey = null; await current?.cancel(); return true; });
}
