// The install flow against a real ssh2 server in this process. Its exec handler runs each command with the local shell
// in a scratch folder, with a stub `id` and `sudo` first on PATH, and the bundled installer is a fake script.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInstallSession, CONNECT_TIMEOUT_MS, installerPath, installVpsInstall, openOldPemKey, parseAddress, parseSeiraLine, readKeyFile, shellQuote } from "./vps-install.mjs";
import { createSavedHosts, fingerprint } from "./vps-install-hosts.mjs";

const require = createRequire(import.meta.url);
const { Server, utils } = require("./vendor/ssh2.cjs");
const here = path.dirname(fileURLToPath(import.meta.url));

// ssh2 1.17.0 writes about one ed25519 public key in 200 with a short length field that its own parser refuses.
function keyPair(kind, options) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pair = utils.generateKeyPairSync(kind, options);
    if (typeof utils.parseKey(pair.public)?.getPublicSSH === "function") return pair;
  }
  throw new Error(`no readable ${kind} key after 50 tries`);
}

process.env.SEIRA_TUNNEL_HOST_SUFFIX = ".example.test";

const SUDO_STUB = `#!/bin/sh
[ "\${FAKE_SUDO:-none}" = tty ] && { echo "sudo: sorry, you must have a tty to run sudo" >&2; exit 1; }
if [ "$1" = "-S" ]; then mode=S; shift; shift; shift; else mode=n; shift; fi
if [ "$mode" = n ]; then
  [ "\${FAKE_SUDO:-none}" = nopass ] || { echo "sudo: a password is required" >&2; exit 1; }
  exec "$@"
fi
[ "\${FAKE_SUDO:-none}" = none ] && { echo "alice is not in the sudoers file." >&2; exit 1; }
IFS= read -r pass
[ "$pass" = "$FAKE_SUDO_PASSWORD" ] || { echo "Sorry, try again." >&2; exit 1; }
[ "$1" = "-v" ] && exit 0
exec "$@"
`;
const ID_STUB = `#!/bin/sh
if [ "$1" = "-u" ]; then echo "\${FAKE_UID:-0}"; else exec /usr/bin/id "$@"; fi
`;
const INSTALLER = `#!/bin/sh
echo "$*" >> "$BOX/runs.log"
mode=install; email=""
while [ $# -gt 0 ]; do
  case "$1" in --check) mode=check;; --account-email) shift; email="$1";; esac
  shift
done
if [ "$mode" = check ]; then
  echo "::seira check os ok Debian is supported"
  if [ -f "$BOX/disk-bad" ]; then echo "::seira check disk fix Free up 20 GB of disk space"; echo "::seira checks fix"; exit 1; fi
  echo "::seira check disk ok Plenty of disk space"
  if [ -f "$BOX/leak" ]; then echo "::seira check account ok $(cat "$BOX/leak")"; fi
  if [ -f "$BOX/docker-bad" ]; then echo "::seira check docker-install fix Docker is not installed"; echo "::seira checks fix"; exit 1; fi
  if [ -f "$BOX/docker-broken" ]; then echo "::seira check docker fix Docker is stopped"; echo "::seira checks fix"; exit 1; fi
  echo "::seira checks ok"
  exit 0
fi
echo "::seira step docker start"
echo "::seira step docker done"
echo "::seira step signin start"
tries=0
while :; do
  echo "::seira ask code $email"
  IFS= read -r line
  echo "$line" >> "$BOX/stdin.log"
  tries=$((tries + 1))
  [ "$line" = "code 00000000" ] && [ "$tries" -lt 3 ] || break
done
case "$line" in "code "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "::seira step signin fail The code was not accepted"; echo "::seira fail The code was not accepted"; exit 1;; esac
echo "::seira step signin done"
if [ -f "$BOX/image-fails" ]; then echo "::seira step image start"; echo "::seira step image fail Docker could not pull the image"; echo "::seira fail Docker could not pull the image"; exit 1; fi
if [ -f "$BOX/drop" ]; then sleep 1; fi
tunnel=c-0123456789abcdef0123456789abcdef.example.test
[ -f "$BOX/plain-host" ] && tunnel=abc.example.test
[ -f "$BOX/other-suffix" ] && tunnel=c-0123456789abcdef0123456789abcdef.other.test
echo "::seira address https://$tunnel"
echo "::seira step pair done"
if [ -f "$BOX/other-origin" ]; then echo "::seira pair https://c-fedcba9876543210fedcba9876543210.example.test/pair#code=PAIR-CODE-1"
else echo "::seira pair https://$tunnel/pair#code=PAIR-CODE-1"; fi
echo "::seira done"
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === "function" ? what() : what}`);
    await sleep(15);
  }
}

async function world(options = {}) {
  const root = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "seira-vps-"));
  const stub = path.join(root, "bin"), box = path.join(root, "box");
  mkdirSync(stub); mkdirSync(box);
  writeFileSync(path.join(stub, "sudo"), SUDO_STUB, { mode: 0o755 });
  writeFileSync(path.join(stub, "id"), ID_STUB, { mode: 0o755 });
  const installer = path.join(root, "install.sh");
  writeFileSync(installer, options.installer ?? INSTALLER);
  const hostKeys = (options.hostKeys ?? ["ed25519"]).map((kind) => keyPair(kind, kind === "rsa" ? { bits: 2048 } : kind === "ecdsa" ? { bits: 256 } : undefined));
  const hostBlob = utils.parseKey(hostKeys[0].public).getPublicSSH();
  const log = [];
  const state = { closed: 0, authMethods: [], connections: 0, clients: new Set() };
  const accountKey = options.publicKey ? utils.parseKey(options.publicKey) : null;
  const server = new Server({ hostKeys: hostKeys.map((key) => key.private) }, (client) => {
    state.connections += 1;
    state.clients.add(client);
    client.on("authentication", (ctx) => {
      state.authMethods.push(ctx.method);
      if (ctx.username === "alice" && ctx.method === "password" && options.password !== undefined && ctx.password === options.password) return ctx.accept();
      if (ctx.username === "alice" && ctx.method === "publickey" && accountKey && (ctx.key.algo === accountKey.type || (accountKey.type === "ssh-rsa" && ["rsa-sha2-256", "rsa-sha2-512"].includes(ctx.key.algo))) && timingSafeEqual(ctx.key.data, accountKey.getPublicSSH())) {
        if (!ctx.signature || accountKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      return ctx.reject(["password", "publickey"]);
    });
    client.on("error", () => {});
    client.on("close", () => { state.closed += 1; state.clients.delete(client); });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        let command = info.command.replaceAll("/tmp/seira-install", `${box}/seira-install`);
        log.push({ kind: "exec", command: info.command });
        if (options.corruptUpload && command.startsWith("cat > ")) command = `${command}; echo tampered >> ${command.slice(6)}`;
        const stream = acceptExec();
        const child = spawn("sh", ["-c", command], { cwd: box, env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, BOX: box, FAKE_UID: options.uid ?? "0", FAKE_SUDO: options.sudo ?? "none", FAKE_SUDO_PASSWORD: options.sudoPassword ?? "" } });
        stream.pipe(child.stdin);
        child.stdin.on("error", () => {});
        child.stdout.pipe(stream, { end: false });
        child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
        child.on("close", (code) => { stream.exit(code ?? 1); stream.end(); });
        stream.on("close", () => child.kill("SIGTERM"));
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const dataDir = path.join(root, "data"), knownHosts = path.join(root, "known_hosts");
  mkdirSync(dataDir);
  return {
    root, box, port, installer, dataDir, knownHosts, log, state, hostBlob,
    address: `127.0.0.1:${port}`,
    fingerprint: fingerprint(hostBlob),
    folders: () => readdirSync(box).filter((name) => name.startsWith("seira-install.")),
    async close() { for (const client of state.clients) client.end(); await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); },
  };
}

function harness(w, extra = {}) {
  const events = [], added = [];
  const session = createInstallSession({
    emit: (event) => events.push(event),
    addServer: async (url) => { added.push(url); w.log.push({ kind: "add" }); return { outcome: "connected" }; },
    installer: w.installer, savedHosts: createSavedHosts({ dir: w.dataDir }), knownHostsFile: w.knownHosts, agent: null, ...extra,
  });
  const has = (type) => events.some((event) => event.type === type);
  return { session, events, added, has, wait: (type, ms) => until(() => events.find((event) => event.type === type), () => `${type} (saw ${JSON.stringify(events)}; server saw ${JSON.stringify(w.log)})`, ms) };
}

const request = (w, extra = {}) => ({ address: w.address, user: "alice", email: "me@example.com", method: "password", password: "pw", ...extra });

async function toChecks(w, h, extra = {}) {
  void h.session.start(request(w, extra));
  const first = await until(() => h.events.find((event) => ["hostKey", "checks", "failed"].includes(event.type)), "the host key question or the checks");
  if (first.type === "hostKey") assert.equal(h.session.acceptHostKey(), true);
  return h.wait("checks");
}

test("the connect timeout is fifteen seconds and a server that never answers fails as a timeout", async () => {
  assert.equal(CONNECT_TIMEOUT_MS, 15_000);
  const silent = net.createServer((socket) => { socket.resume(); socket.on("error", () => {}); });
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const events = [];
  const session = createInstallSession({ emit: (event) => events.push(event), addServer: async () => true, installer: "unused", savedHosts: { read: () => [], remember() {} }, knownHostsFile: "/nonexistent", agent: null, connectTimeoutMs: 250 });
  const started = Date.now();
  await session.start({ address: `127.0.0.1:${silent.address().port}`, user: "alice", email: "me@example.com", method: "password", password: "pw" });
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).reason, "timeout");
  assert.ok(Date.now() - started < 3_000);
  await new Promise((resolve) => silent.close(resolve));
});

test("a wrong password stops as an authentication failure and an unreachable address as unreachable", async () => {
  const w = await world({ password: "right" });
  try {
    const h = harness(w);
    void h.session.start(request(w, { password: "wrong" }));
    await h.wait("hostKey");
    h.session.acceptHostKey();
    const failed = await h.wait("failed");
    assert.equal(failed.reason, "auth");
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const dead = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const other = harness(w);
    await other.session.start(request(w, { address: `127.0.0.1:${dead}` }));
    assert.equal(other.events.at(-1).reason, "unreachable");
    const bad = harness(w);
    await bad.session.start(request(w, { address: "not a host" }));
    assert.equal(bad.events.at(-1).reason, "address");
  } finally { await w.close(); }
});

test("an unknown host key shows its fingerprint and waits for the person before anything else happens", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    void h.session.start(request(w));
    const asked = await h.wait("hostKey");
    assert.equal(asked.fingerprint, w.fingerprint);
    assert.equal(asked.host, "127.0.0.1");
    await sleep(250);
    assert.equal(h.has("checks"), false);
    assert.deepEqual(w.state.authMethods, []);
    assert.deepEqual(w.log, []);
    h.session.acceptHostKey();
    await h.wait("checks");
  } finally { await w.close(); }
});

test("declining the host key stops the flow before sign-in", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    void h.session.start(request(w));
    await h.wait("hostKey");
    h.session.rejectHostKey();
    assert.equal((await h.wait("failed")).reason, "hostKeyDeclined");
    assert.deepEqual(w.state.authMethods, []);
  } finally { await w.close(); }
});

test("a host key that differs from the saved one or the known_hosts one stops the flow before sign-in", async () => {
  const w = await world({ password: "pw" });
  try {
    createSavedHosts({ dir: w.dataDir }).remember({ host: "127.0.0.1", port: w.port, fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const saved = harness(w);
    await saved.session.start(request(w));
    assert.equal(saved.events.at(-1).reason, "hostKeyChanged");
    assert.equal(saved.has("hostKey"), false);
    rmSync(path.join(w.dataDir, "ssh"), { recursive: true });
    const other = utils.parseKey(keyPair("ed25519").public).getPublicSSH();
    writeFileSync(w.knownHosts, `[127.0.0.1]:${w.port} ssh-ed25519 ${other.toString("base64")}\n`);
    const known = harness(w);
    await known.session.start(request(w));
    assert.equal(known.events.at(-1).reason, "hostKeyChanged");
    assert.deepEqual(w.state.authMethods, []);
    assert.deepEqual(w.log, []);
  } finally { await w.close(); }
});

test("a key the known_hosts file holds goes straight on without a question", async () => {
  const w = await world({ password: "pw" });
  try {
    writeFileSync(w.knownHosts, `[127.0.0.1]:${w.port} ssh-ed25519 ${w.hostBlob.toString("base64")}\n`);
    const h = harness(w);
    void h.session.start(request(w));
    await h.wait("checks");
    assert.equal(h.has("hostKey"), false);
    await h.session.cancel();
  } finally { await w.close(); }
});

test("accepting saves only host, port, key type and fingerprint, and the next install to that host asks nothing", async () => {
  const w = await world({ password: "pw" });
  try {
    const first = harness(w);
    await toChecks(w, first);
    const file = path.join(w.dataDir, "ssh", "install-hosts.json");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { hosts: [{ host: "127.0.0.1", port: w.port, fingerprint: w.fingerprint, type: "ssh-ed25519" }] });
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    await first.session.cancel();
    const second = harness(w);
    void second.session.start(request(w));
    await second.wait("checks");
    assert.equal(second.has("hostKey"), false);
    await second.session.cancel();
  } finally { await w.close(); }
});

test("a user who is not root and cannot use sudo stops before any change on the server", async () => {
  const w = await world({ password: "pw", uid: "1000", sudo: "none" });
  try {
    const h = harness(w);
    void h.session.start(request(w));
    await h.wait("hostKey");
    h.session.acceptHostKey();
    const failed = await h.wait("failed");
    assert.equal(failed.reason, "notAdmin");
    assert.equal(w.log.some((entry) => /mktemp|cat >|install\.sh/.test(entry.command ?? "")), false);
    assert.deepEqual(w.folders(), []);
  } finally { await w.close(); }
});

test("a user with sudo and a password is checked with sudo -S in its own channel and a wrong password is said as such", async () => {
  const w = await world({ password: "pw", uid: "1000", sudo: "password", sudoPassword: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    assert.ok(w.log.some((entry) => entry.command === "sudo -S -p '' -v"));
    assert.ok(w.log.some((entry) => /^sudo -S -p '' sh '.*install\.sh' --check --tunnel --events$/.test(entry.command)));
    await h.session.cancel();
    const wrong = harness(w);
    void wrong.session.start(request(w, { method: "password", sudoPassword: "nope" }));
    await wrong.wait("failed");
    assert.equal(wrong.events.at(-1).reason, "sudoPassword");
  } finally { await w.close(); }
});

test("sudo without a password is used when the server allows it", async () => {
  const w = await world({ password: "pw", uid: "1000", sudo: "nopass" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    assert.ok(w.log.some((entry) => /^sudo -n sh '.*install\.sh' --check/.test(entry.command)));
    await h.session.cancel();
  } finally { await w.close(); }
});

test("the installer goes to a new private folder and its SHA-256 is checked before it runs", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    const [folder] = w.folders();
    assert.ok(folder);
    if (process.platform !== "win32") assert.equal(statSync(path.join(w.box, folder)).mode & 0o777, 0o700);
    assert.equal(readFileSync(path.join(w.box, folder, "install.sh"), "utf8"), INSTALLER);
    const order = w.log.map((entry) => entry.command);
    const sum = order.findIndex((command) => /sha256sum/.test(command));
    const run = order.findIndex((command) => /^sh '.*install\.sh' --check/.test(command));
    assert.ok(sum > order.findIndex((command) => command.startsWith("cat > ")) && sum < run);
    await h.session.cancel();
  } finally { await w.close(); }
});

test("an installer that arrives changed is never run", async () => {
  const w = await world({ password: "pw", corruptUpload: true });
  try {
    const h = harness(w);
    void h.session.start(request(w));
    await h.wait("hostKey");
    h.session.acceptHostKey();
    assert.equal((await h.wait("failed")).reason, "upload");
    assert.equal(w.log.some((entry) => /install\.sh' --/.test(entry.command ?? "")), false);
    await until(() => w.folders().length === 0, "the folder to be removed");
  } finally { await w.close(); }
});

test("the check runs alone, shows each result, and nothing is installed before Install", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    const checks = await toChecks(w, h);
    assert.equal(checks.result, "ok");
    assert.deepEqual(h.events.filter((event) => event.type === "check").map((event) => [event.id, event.level]), [["os", "ok"], ["disk", "ok"]]);
    assert.equal(w.log.some((entry) => /account-email/.test(entry.command ?? "")), false);
    assert.equal(readFileSync(path.join(w.box, "runs.log"), "utf8").trim(), "--check --tunnel --events");
    await h.session.cancel();
  } finally { await w.close(); }
});

test("a failed check shows the one-sentence fix, refuses Install, and Check again reruns it", async () => {
  const w = await world({ password: "pw" });
  try {
    writeFileSync(path.join(w.box, "disk-bad"), "");
    const h = harness(w);
    const first = await toChecks(w, h);
    assert.equal(first.result, "fix");
    assert.deepEqual(first.items.find((item) => item.id === "disk"), { id: "disk", level: "fix", sentence: "Free up 20 GB of disk space" });
    assert.equal(await h.session.install({ installDocker: false }), false);
    rmSync(path.join(w.box, "disk-bad"));
    h.events.length = 0;
    assert.equal(await h.session.check(), true);
    assert.equal((await h.wait("checks")).result, "ok");
    await h.session.cancel();
  } finally { await w.close(); }
});

test("a missing Docker can be installed only when the person agreed", async () => {
  const w = await world({ password: "pw" });
  try {
    writeFileSync(path.join(w.box, "docker-bad"), "");
    const h = harness(w);
    const checks = await toChecks(w, h);
    assert.equal(checks.result, "fix");
    assert.equal(await h.session.install({ installDocker: false }), false);
    void h.session.install({ installDocker: true });
    await h.wait("askCode");
    assert.match(readFileSync(path.join(w.box, "runs.log"), "utf8"), /--tunnel --events --account-email me@example\.com --install-docker/);
    await h.session.cancel();
  } finally { await w.close(); }
});

test("Install runs the installer with the tunnel and events options, shows each step, asks for the code once and adds the server", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    const done = h.session.install({ installDocker: false });
    const asked = await h.wait("askCode");
    assert.equal(asked.email, "me@example.com");
    assert.equal(h.session.sendCode("12ab"), false);
    assert.equal(h.session.sendCode("12345678"), true);
    assert.equal(h.session.sendCode("87654321"), false);
    await done;
    await h.wait("connected");
    assert.deepEqual(h.events.filter((event) => event.type === "step").map((event) => `${event.id}:${event.state}`), ["docker:start", "docker:done", "signin:start", "signin:done", "pair:done"]);
    assert.match(readFileSync(path.join(w.box, "runs.log"), "utf8"), /^--check --tunnel --events\n--tunnel --events --account-email me@example\.com\n$/);
    assert.equal(readFileSync(path.join(w.box, "stdin.log"), "utf8"), "code 12345678\n");
    assert.deepEqual(h.added, ["https://c-0123456789abcdef0123456789abcdef.example.test/pair#code=PAIR-CODE-1"]);
  } finally { await w.close(); }
});

test("the pairing link closes the connection, removes the folder first, then adds the server", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    const done = h.session.install({});
    await h.wait("askCode");
    h.session.sendCode("12345678");
    await done;
    await h.wait("connected");
    const kinds = w.log.map((entry) => (entry.kind === "add" ? "add" : /rm -rf/.test(entry.command) ? "rm" : "other"));
    assert.ok(kinds.indexOf("rm") !== -1 && kinds.indexOf("rm") < kinds.indexOf("add"));
    await until(() => w.state.closed >= 1, "the connection to close");
    assert.deepEqual(w.folders(), []);
    assert.equal(await h.session.check(), false);
    assert.equal(h.session.sendCode("12345678"), false);
  } finally { await w.close(); }
});

test("a failed step shows the step and the installer's sentence, and Try again runs the installer on a new connection", async () => {
  const w = await world({ password: "pw" });
  try {
    writeFileSync(path.join(w.box, "image-fails"), "");
    const h = harness(w);
    await toChecks(w, h);
    const done = h.session.install({});
    await h.wait("askCode");
    h.session.sendCode("12345678");
    await done;
    const failed = await h.wait("failed");
    assert.equal(failed.step, "image");
    assert.equal(failed.sentence, "Docker could not pull the image");
    assert.deepEqual(w.folders(), []);
    rmSync(path.join(w.box, "image-fails"));
    const before = w.state.connections;
    const again = harness(w);
    await toChecks(w, again);
    assert.equal(w.state.connections, before + 1);
    const second = again.session.install({});
    await again.wait("askCode");
    again.session.sendCode("12345678");
    await second;
    await again.wait("connected");
    assert.equal(readFileSync(path.join(w.box, "runs.log"), "utf8").split("\n").filter((line) => line.includes("--account-email")).length, 2);
  } finally { await w.close(); }
});

test("a dropped connection is shown as a failure at the step that was running", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    void h.session.install({});
    await h.wait("askCode");
    for (const client of w.state.clients) client.end();
    for (const client of w.state.clients) client._sock?.destroy();
    const failed = await h.wait("failed");
    assert.equal(failed.reason, "dropped");
    assert.equal(failed.step, "signin");
  } finally { await w.close(); }
});

test("Cancel closes the connection within two seconds, even while the installer waits", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    void h.session.install({});
    await h.wait("askCode");
    const started = Date.now();
    await h.session.cancel();
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
    await until(() => w.state.closed >= 1, "the server to see the connection close", 2_000);
    assert.equal(h.events.at(-1).type, "cancelled");
    assert.deepEqual(w.folders(), []);
    rmSync(path.join(w.dataDir, "ssh"), { recursive: true });
    const early = harness(w);
    void early.session.start(request(w));
    await early.wait("hostKey");
    const t = Date.now();
    await early.session.cancel();
    assert.ok(Date.now() - t < 2_000);
  } finally { await w.close(); }
});

test("an email that could break out of the command is refused before any connection", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await h.session.start(request(w, { email: "x'; touch /tmp/pwned; '@example.com" }));
    assert.equal(h.events.at(-1).reason, "email");
    assert.equal(w.state.connections, 0);
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
  } finally { await w.close(); }
});

test("nothing secret reaches the console, the page's events or the data folder (password, key passphrase, emailed code)", async () => {
  const secrets = { password: "pw-UNIQ-4f8e1c7a", passphrase: "pp-UNIQ-9d2b6e3f", code: "48151623", pair: "PAIR-CODE-1" };
  const consoleLines = [];
  const originals = {};
  for (const name of ["log", "info", "warn", "error", "debug", "trace"]) {
    originals[name] = console[name];
    console[name] = (...args) => consoleLines.push(args.map(String).join(" "));
  }
  const pair = keyPair("ed25519", { passphrase: secrets.passphrase, cipher: "aes256-ctr", rounds: 16 });
  const w = await world({ password: secrets.password, uid: "1000", sudo: "password", sudoPassword: secrets.password });
  const k = await world({ publicKey: pair.public });
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const body = readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), "utf8");
      for (const [name, value] of Object.entries(secrets)) assert.equal(body.includes(value), false, `${name} found in ${entry.name}`);
    }
  };
  try {
    const first = harness(w);
    await toChecks(w, first, { password: secrets.password });
    const done = first.session.install({});
    await first.wait("askCode");
    first.session.sendCode(secrets.code);
    await done;
    await first.wait("connected");
    const keyFile = path.join(k.root, "id_ed25519");
    writeFileSync(keyFile, pair.private, { mode: 0o600 });
    const second = harness(k);
    void second.session.start({ ...request(k), method: "key", keyPath: keyFile, passphrase: secrets.passphrase, password: "" });
    await second.wait("hostKey");
    second.session.acceptHostKey();
    await second.wait("checks");
    const done2 = second.session.install({});
    await second.wait("askCode");
    second.session.sendCode(secrets.code);
    await done2;
    await second.wait("connected");
    assert.deepEqual(k.folders(), []);
    assert.deepEqual(w.folders(), []);
    scan(w.dataDir);
    scan(k.dataDir);
    const text = `${JSON.stringify([...first.events, ...second.events])}\n${consoleLines.join("\n")}`;
    for (const [name, value] of Object.entries(secrets)) assert.equal(text.includes(value), false, `${name} leaked into events or console`);
  } finally {
    for (const [name, fn] of Object.entries(originals)) console[name] = fn;
    await w.close();
    await k.close();
  }
});

test("after the install ends the session is inert and its folder on the server is gone", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    assert.equal(w.folders().length, 1);
    await h.session.cancel();
    assert.deepEqual(w.folders(), []);
    assert.equal(await h.session.install({}), false);
    assert.equal(await h.session.check(), false);
    assert.equal(h.session.acceptHostKey(), false);
    assert.equal(h.session.sendCode("12345678"), false);
  } finally { await w.close(); }
});

test("the installer's lines are read as events and every other line is ignored", () => {
  assert.deepEqual(parseSeiraLine("::seira check disk fix Free up space"), { type: "check", id: "disk", level: "fix", sentence: "Free up space" });
  assert.deepEqual(parseSeiraLine("::seira checks ok"), { type: "checks", result: "ok" });
  assert.deepEqual(parseSeiraLine("::seira step image fail It broke"), { type: "step", id: "image", state: "fail", sentence: "It broke" });
  assert.deepEqual(parseSeiraLine("::seira step image start"), { type: "step", id: "image", state: "start", sentence: "" });
  assert.deepEqual(parseSeiraLine("::seira ask code me@example.com"), { type: "ask", email: "me@example.com" });
  assert.deepEqual(parseSeiraLine("::seira pair https://a.test/pair#code=X"), { type: "pair", url: "https://a.test/pair#code=X" });
  assert.deepEqual(parseSeiraLine("::seira done"), { type: "done" });
  assert.deepEqual(parseSeiraLine("::seira fail No room"), { type: "fail", sentence: "No room" });
  for (const line of ["hello", "::seira", "::seira unknown x", "::seira check disk maybe x", "code 12345678"]) assert.equal(parseSeiraLine(line), null, line);
});

test("an address is read as host, host:port, [v6]:port or ssh://host", () => {
  assert.deepEqual(parseAddress("203.0.113.9"), { host: "203.0.113.9", port: 22 });
  assert.deepEqual(parseAddress("vps.example.com:2200"), { host: "vps.example.com", port: 2200 });
  assert.deepEqual(parseAddress("ssh://vps.example.com/"), { host: "vps.example.com", port: 22 });
  assert.deepEqual(parseAddress("[2001:db8::1]:2200"), { host: "2001:db8::1", port: 2200 });
  for (const bad of ["", "a b", "root@host", "host:99999", "host:0", "-bad.example", "a;b"]) assert.equal(parseAddress(bad), null, bad);
});

test("the installer comes from the bundled resources, is shipped by the build, and no system ssh is called", () => {
  assert.equal(installerPath({ packaged: true, resourcesPath: "/r" }), path.join("/r", "installer", "install.sh"));
  assert.ok(existsSync(installerPath({ packaged: false, resourcesPath: "/r" })));
  const build = readFileSync(path.join(here, "..", "electron-builder.yml"), "utf8");
  assert.match(build, /from: deploy\/install\.sh\n\s+to: installer\/install\.sh/);
  for (const file of ["vps-install.mjs", "vps-install-hosts.mjs"]) {
    const source = readFileSync(path.join(here, file), "utf8");
    assert.equal(/child_process/.test(source), false, `${file} must not run a program`);
  }
});

function bridge(pick) {
  const handlers = new Map(), sent = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-bridge-"));
  installVpsInstall({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (handler) => handler, dialog: { showOpenDialog: async () => pick() },
    add: async () => true, dataDir: dir, resourcesPath: dir, packaged: false });
  const sender = { isDestroyed: () => false, send: (_channel, message) => sent.push(message), once() {} };
  const call = (name, ...args) => handlers.get(`server-install:${name}`)({ sender }, ...args);
  return { call, sent, dir };
}
const keyRequest = { address: "127.0.0.1:1", user: "alice", email: "me@example.com", method: "key" };

test("a key path sent by the page is never read; only the file the person picked is used", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-keyfile-"));
  const secret = path.join(dir, "other");
  writeFileSync(secret, "not a key");
  const b = bridge(() => ({ canceled: true, filePaths: [] }));
  await b.call("start", { ...keyRequest, keyPath: secret });
  const failed = await until(() => b.sent.find((event) => event.type === "failed"), "a failure");
  assert.equal(failed.reason, "keyUnreadable");
  rmSync(dir, { recursive: true, force: true });
});

test("the pick answers with the file name only, and a picked path that is not a regular file is unreadable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-keyfile-"));
  const b = bridge(() => ({ canceled: false, filePaths: [dir] }));
  assert.deepEqual(await b.call("pick-key"), { name: path.basename(dir) });
  await b.call("start", keyRequest);
  const failed = await until(() => b.sent.find((event) => event.type === "failed"), "a failure");
  assert.equal(failed.reason, "keyUnreadable");
  assert.throws(() => readKeyFile(dir));
  assert.throws(() => readKeyFile("/dev/null"));
  const big = path.join(dir, "big");
  writeFileSync(big, Buffer.alloc(64 * 1024 + 1));
  assert.throws(() => readKeyFile(big));
  writeFileSync(big, "small");
  assert.equal(readKeyFile(big).toString(), "small");
  rmSync(dir, { recursive: true, force: true });
});

test("the stored key path is cleared by cancel and by a cancelled pick", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-keyfile-"));
  const file = path.join(dir, "id");
  writeFileSync(file, "x");
  let answer = { canceled: false, filePaths: [file] };
  const b = bridge(() => answer);
  await b.call("pick-key");
  await b.call("cancel");
  await b.call("start", keyRequest);
  assert.equal((await until(() => b.sent.find((event) => event.type === "failed"), "a failure")).reason, "keyUnreadable");
  await b.call("pick-key");
  answer = { canceled: true, filePaths: [] };
  assert.equal(await b.call("pick-key"), null);
  b.sent.length = 0;
  await b.call("start", keyRequest);
  assert.equal((await until(() => b.sent.find((event) => event.type === "failed"), "a failure")).reason, "keyUnreadable");
  rmSync(dir, { recursive: true, force: true });
});

test("a wrong emailed code is asked again, flagged as a repeat, and the right code then connects", async () => {
  const w = await world({ password: "pw" });
  try {
    const h = harness(w);
    await toChecks(w, h);
    const done = h.session.install({});
    await until(() => h.events.filter((event) => event.type === "askCode").length === 1, "the first ask");
    assert.equal(h.events.find((event) => event.type === "askCode").again, undefined);
    assert.equal(h.session.sendCode("00000000"), true);
    await until(() => h.events.filter((event) => event.type === "askCode").length === 2, "the second ask");
    assert.equal(h.events.filter((event) => event.type === "askCode")[1].again, true);
    assert.equal(h.session.sendCode("12345678"), true);
    await done;
    await h.wait("connected");
    assert.equal(readFileSync(path.join(w.box, "stdin.log"), "utf8"), "code 00000000\ncode 12345678\n");
  } finally { await w.close(); }
});

for (const [name, marker] of [["a pair link on another address than the one the installer announced", "other-origin"], ["a pair link on a host that is not a tunnel host", "plain-host"], ["a pair link on a host outside the tunnel suffix", "other-suffix"]]) {
  test(`${name} is refused and nothing is added`, async () => {
    const w = await world({ password: "pw" });
    try {
      const h = harness(w);
      await toChecks(w, h);
      writeFileSync(path.join(w.box, marker), "");
      const done = h.session.install({});
      await h.wait("askCode");
      h.session.sendCode("12345678");
      await done;
      assert.equal((await h.wait("failed")).reason, "pairFailed");
      assert.deepEqual(h.added, []);
    } finally { await w.close(); }
  });
}

test("a saved key of one type and a server that offers only another type is refused as a changed host key", async () => {
  const w = await world({ password: "pw", hostKeys: ["rsa"] });
  try {
    createSavedHosts({ dir: w.dataDir }).remember({ host: "127.0.0.1", port: w.port, fingerprint: "SHA256:someoneelse", type: "ssh-ed25519" });
    const h = harness(w);
    void h.session.start(request(w));
    const failed = await h.wait("failed");
    assert.equal(failed.reason, "hostKeyChanged");
    assert.equal(h.has("hostKey"), false);
    assert.equal(w.state.authMethods.length, 0);
  } finally { await w.close(); }
});

test("a saved key and a server that offers that type and a new one connects as known", async () => {
  const w = await world({ password: "pw", hostKeys: ["ed25519", "ecdsa"] });
  try {
    createSavedHosts({ dir: w.dataDir }).remember({ host: "127.0.0.1", port: w.port, fingerprint: w.fingerprint, type: "ssh-ed25519" });
    const h = harness(w);
    void h.session.start(request(w));
    await h.wait("checks");
    assert.equal(h.has("hostKey"), false);
    await h.session.cancel();
  } finally { await w.close(); }
});

const forgetRig = (dataDir) => {
  const handlers = new Map(), sent = [];
  installVpsInstall({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (handler) => handler, dialog: {}, add: async () => true, dataDir, resourcesPath: dataDir, packaged: false });
  const sender = { isDestroyed: () => false, send: (_channel, message) => sent.push(message), once() {} };
  return { sent, call: (name, ...args) => handlers.get(`server-install:${name}`)({ sender }, ...args) };
};

test("a saved-list conflict says so, forget-host removes only that host and port, and the next start asks for the fingerprint", async () => {
  const w = await world({ password: "pw" });
  try {
    const saved = createSavedHosts({ dir: w.dataDir });
    saved.remember({ host: "127.0.0.1", port: w.port, fingerprint: "SHA256:old", type: "ssh-ed25519" });
    saved.remember({ host: "127.0.0.1", port: w.port, fingerprint: "SHA256:oldrsa", type: "ssh-rsa" });
    saved.remember({ host: "127.0.0.1", port: 1, fingerprint: "SHA256:other-port", type: "ssh-ed25519" });
    saved.remember({ host: "other.example", port: w.port, fingerprint: "SHA256:other-host", type: "ssh-ed25519" });
    const knownText = "# untouched\n";
    writeFileSync(w.knownHosts, knownText);
    const rig = forgetRig(w.dataDir);
    assert.equal(await rig.call("forget-host"), false, "nothing to forget before a failure");
    await rig.call("start", request(w));
    const failed = await until(() => rig.sent.find((event) => event.type === "failed"), "the failure");
    assert.equal(failed.reason, "hostKeyChanged");
    assert.equal(failed.source, "saved");
    assert.equal(JSON.stringify(failed).includes(w.dataDir), false);
    assert.equal(await rig.call("forget-host"), true);
    assert.equal(await rig.call("forget-host"), false);
    assert.deepEqual(saved.read().map((item) => `${item.host}:${item.port}`).sort(), ["127.0.0.1:1", "other.example:" + w.port].sort());
    assert.equal(readFileSync(w.knownHosts, "utf8"), knownText);
    const again = harness(w);
    void again.session.start(request(w));
    assert.equal((await again.wait("hostKey")).fingerprint, w.fingerprint);
    await again.session.cancel();
  } finally { await w.close(); }
});

test("a known_hosts conflict is reported as the system source and offers no forget", async () => {
  const w = await world({ password: "pw" });
  try {
    const other = await world({ password: "pw" });
    writeFileSync(w.knownHosts, `[127.0.0.1]:${w.port} ssh-ed25519 ${other.hostBlob.toString("base64")}\n`);
    await other.close();
    const h = harness(w);
    void h.session.start(request(w));
    const failed = await h.wait("failed");
    assert.equal(failed.reason, "hostKeyChanged");
    assert.equal(failed.source, "system");
    assert.equal(h.session.forgetHost(), false);
    assert.equal(createSavedHosts({ dir: w.dataDir }).read().length, 0);
  } finally { await w.close(); }
});

test("a conflict in both sources is reported as both", async () => {
  const w = await world({ password: "pw" });
  try {
    const other = await world({ password: "pw" });
    writeFileSync(w.knownHosts, `[127.0.0.1]:${w.port} ssh-ed25519 ${other.hostBlob.toString("base64")}\n`);
    await other.close();
    createSavedHosts({ dir: w.dataDir }).remember({ host: "127.0.0.1", port: w.port, fingerprint: "SHA256:old", type: "ssh-ed25519" });
    const h = harness(w);
    void h.session.start(request(w));
    assert.equal((await h.wait("failed")).source, "both");
    assert.equal(h.session.forgetHost(), false);
  } finally { await w.close(); }
});

test("the bundled installer knows the tunnel and events options", () => {
  const result = spawnSync("sh", [path.join(here, "..", "deploy", "install.sh"), "--help"], { encoding: "utf8" });
  const help = `${result.stdout}${result.stderr}`;
  assert.match(help, /--tunnel/);
  assert.match(help, /--events/);
});

test("a broken Docker is a normal fix that the Docker option cannot clear", async () => {
  const w = await world({ password: "pw" });
  try {
    writeFileSync(path.join(w.box, "docker-broken"), "");
    const h = harness(w);
    const checks = await toChecks(w, h);
    assert.equal(checks.result, "fix");
    assert.equal(await h.session.install({ installDocker: true }), false);
    assert.equal(await h.session.install({ installDocker: false }), false);
    await h.session.cancel();
  } finally { await w.close(); }
});

test("an installer sentence that holds a password is dropped whole, in a check and in the list", async () => {
  const w = await world({ password: "pw-secret-9" });
  try {
    writeFileSync(path.join(w.box, "leak"), "login with pw-secret-9 worked");
    const h = harness(w);
    const checks = await toChecks(w, h, { password: "pw-secret-9" });
    assert.equal(checks.items.find((item) => item.id === "account").sentence, null);
    assert.equal(h.events.find((event) => event.type === "check" && event.id === "account").sentence, null);
    assert.equal(JSON.stringify(h.events).includes("pw-secret-9"), false);
    await h.session.cancel();
  } finally { await w.close(); }
});

test("a key sign-in with no administrator password says so, and a server that wants a terminal says that", async () => {
  const pair = keyPair("ed25519");
  const w = await world({ publicKey: pair.public, uid: "1000", sudo: "password", sudoPassword: "pw" });
  const t = await world({ password: "pw", uid: "1000", sudo: "tty" });
  try {
    const keyFile = path.join(w.root, "id_ed25519");
    writeFileSync(keyFile, pair.private, { mode: 0o600 });
    const h = harness(w);
    void h.session.start({ ...request(w), method: "key", keyPath: keyFile, password: "" });
    await h.wait("hostKey");
    h.session.acceptHostKey();
    assert.equal((await h.wait("failed")).reason, "adminPasswordNeeded");
    const g = harness(t);
    void g.session.start(request(t));
    await g.wait("hostKey");
    g.session.acceptHostKey();
    assert.equal((await g.wait("failed")).reason, "sudoRefused");
  } finally { await w.close(); await t.close(); }
});

const OLD_PASS = "old-pem-pass";
function oldPem(kind, cipher) {
  const type = kind === "rsa" ? "pkcs1" : "sec1";
  const { privateKey } = generateKeyPairSync(kind, { ...(kind === "rsa" ? { modulusLength: 2048 } : { namedCurve: "prime256v1" }),
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type, format: "pem" } });
  return { plain: privateKey, encrypted: cipher ? createPrivateKey(privateKey).export({ type, format: "pem", cipher, passphrase: OLD_PASS }) : null };
}
const reasonOf = (open) => { try { open(); } catch (error) { return error.reason; } return null; };

test("an encrypted old PEM key opens with Node crypto into a plain key that ssh2 reads without a passphrase", () => {
  for (const [kind, cipher, label, sshType] of [["rsa", "aes-256-cbc", "RSA", "ssh-rsa"], ["rsa", "des-ede3-cbc", "RSA", "ssh-rsa"], ["ec", "aes-128-cbc", "EC", "ecdsa-sha2-nistp256"]]) {
    const { plain, encrypted } = oldPem(kind, cipher);
    assert.match(encrypted, /^Proc-Type: 4,ENCRYPTED$/m);
    for (const text of [encrypted, encrypted.replaceAll("\n", "\r\n")]) {
      const opened = openOldPemKey(Buffer.from(text), OLD_PASS).toString();
      assert.ok(opened.startsWith(`-----BEGIN ${label} PRIVATE KEY-----\n`), opened.slice(0, 40));
      assert.equal(opened.includes("ENCRYPTED"), false);
      const parsed = utils.parseKey(opened);
      assert.equal(parsed.type, sshType);
      assert.deepEqual(parsed.getPublicSSH(), utils.parseKey(plain).getPublicSSH());
    }
  }
});

test("an encrypted old PEM key with a wrong or missing password, a DSA key or an old cipher gets its own reason", () => {
  const { encrypted } = oldPem("rsa", "aes-128-cbc");
  assert.equal(reasonOf(() => openOldPemKey(Buffer.from(encrypted), "not-it")), "keyPassphrase");
  assert.equal(reasonOf(() => openOldPemKey(Buffer.from(encrypted), "")), "keyNeedsPassphrase");
  const fake = (label, cipher) => Buffer.from(`-----BEGIN ${label} PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: ${cipher},00112233445566778899AABBCCDDEEFF\n\nAAAA\n-----END ${label} PRIVATE KEY-----\n`);
  assert.equal(reasonOf(() => openOldPemKey(fake("DSA", "AES-128-CBC"), OLD_PASS)), "keyOldFormat");
  assert.equal(reasonOf(() => openOldPemKey(fake("RSA", "DES-CBC"), OLD_PASS)), "keyOldFormat");
});

test("a plain old PEM key and a key in the new format pass through unchanged", () => {
  const legacy = Buffer.from(oldPem("rsa").plain);
  assert.equal(openOldPemKey(legacy, "anything"), legacy);
  const modern = Buffer.from(keyPair("ecdsa", { bits: 256, passphrase: OLD_PASS, cipher: "aes256-ctr", rounds: 16 }).private);
  assert.equal(openOldPemKey(modern, OLD_PASS), modern);
});

test("an encrypted old RSA or EC PEM key signs in with its password, a wrong password says so, and a plain one signs in", async () => {
  for (const kind of ["rsa", "ec"]) {
    const { plain, encrypted } = oldPem(kind, "aes-256-cbc");
    const w = await world({ publicKey: plain });
    try {
      for (const [name, body, passphrase] of [["encrypted", encrypted, OLD_PASS], ["plain", plain, ""]]) {
        const keyFile = path.join(w.root, `id_${name}`);
        writeFileSync(keyFile, body, { mode: 0o600 });
        const h = harness(w);
        void h.session.start({ ...request(w), method: "key", keyPath: keyFile, passphrase, password: "" });
        const first = await until(() => h.events.find((event) => ["hostKey", "checks", "failed"].includes(event.type)), `${kind} ${name}: the host key or the checks`);
        if (first.type === "hostKey") h.session.acceptHostKey();
        assert.equal((await h.wait("checks")).type, "checks", `${kind} ${name}`);
        await h.session.cancel();
      }
      const keyFile = path.join(w.root, "id_encrypted");
      const wrong = harness(w);
      void wrong.session.start({ ...request(w), method: "key", keyPath: keyFile, passphrase: "not-it", password: "" });
      assert.equal((await wrong.wait("failed")).reason, "keyPassphrase");
    } finally { await w.close(); }
  }
});
