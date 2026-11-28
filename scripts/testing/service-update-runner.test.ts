// deploy/service-update-runner.sh, the host side of the Update server button for an npm install that runs as a systemd
// service. systemd, runuser, npm and the server are stand-ins; tar, gzip, find and the files are real. The requester is
// treated as hostile: anything running as the server's user can leave the request.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRun, parseRunner } from "../../server/server-update.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

const RUNNER = join(import.meta.dirname, "..", "..", "deploy", "service-update-runner.sh");
const PACKAGE = "@seira-bot/seira";
const OLD = "0.1.150";
const NEW = "0.1.151";
const PORT = "18999";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A host with Seira `running` installed by npm under a service user, and root's folder as --install leaves it. */
function host(options: { running?: string; latest?: string; stable?: string; ownsNode?: boolean; user?: string } = {}) {
  const running = options.running ?? OLD;
  const root = mkdtempSync(join(tmpdir(), "seira-service-runner-"));
  dirs.push(root);
  const fakes = join(root, "fakes");
  const tools = join(root, "tools");
  const prefix = join(root, "prefix");
  const pkg = join(prefix, "lib", "node_modules", PACKAGE);
  const data = join(root, "data");
  const state = join(root, "state");
  const backups = join(root, "backups");
  const registry = join(root, "registry");
  const node = join(tools, "bin", "node");
  for (const dir of [fakes, join(tools, "bin"), join(tools, "lib", "node_modules", "npm", "bin"), pkg, join(data, "workspaces"), join(state, "status"), join(state, "request"), join(registry, PACKAGE), join(root, "home"), join(root, "sbin"), join(root, "systemd")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: PACKAGE, version: running, dependencies: { a: "1.0.0" } }));
  writeFileSync(join(pkg, "cli.js"), "");
  writeFileSync(join(data, "config.json"), '{"profile":"before"}\n');
  writeFileSync(join(data, "workspaces", "big"), "kept out of the copy\n");
  writeFileSync(join(tools, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "");
  const setLatest = (version: string) => writeFileSync(join(registry, PACKAGE, "latest"), JSON.stringify({ name: PACKAGE, dist: { version: "9.9.9" }, version }));
  setLatest(options.latest ?? NEW);
  for (const version of [OLD, NEW]) writeFileSync(join(registry, PACKAGE, version), JSON.stringify({ name: PACKAGE, version }));
  if (options.stable) writeFileSync(join(root, "stable.json"), JSON.stringify({ version: options.stable, releaseUrl: "x" }));

  const uid = process.getuid!();
  const serviceUid = options.ownsNode ? uid : uid + 1;
  const user = options.user ?? "seira";
  writeFileSync(join(root, "unit.props"), [
    "LoadState=loaded", `User=${user}`,
    `ExecStart={ path=${node} ; argv[]=${node} ${join(pkg, "cli.js")} serve --port ${PORT} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
    `Environment=HOME=${join(root, "home")} SEIRA_DATA_DIR=${data} PATH=/usr/bin:/bin`, "",
  ].join("\n"));

  const log = join(root, "calls.log");
  // Root's tools without root: `id` says 0 for the caller and names the service user, `install` leaves owners alone,
  // `runuser` runs the command as the test's user, and `systemctl` runs a server that is only a file: `active` holds the
  // version it started as, and `broken-<version>` makes that version never answer.
  executable(join(fakes, "id"), `#!/bin/sh
case "$1 $#" in "-u 1") echo 0 ;; "-u 2") echo ${serviceUid} ;; "-g 2" | "-G 2") echo ${process.getgid!() + 1} ;; *) echo 0 ;; esac
`);
  executable(join(fakes, "install"), `#!/bin/sh
echo "install $*" >> "${log}"
args=""
while [ $# -gt 0 ]; do case "$1" in -o|-g) shift ;; *) args="$args $1" ;; esac; shift; done
exec /usr/bin/install $args
`);
  executable(join(fakes, "runuser"), `#!/bin/sh
[ "$1" = -u ] || exit 9
echo "runuser $2" >> "${log}"
shift 2
[ "$1" = -- ] && shift
exec "$@"
`);
  executable(join(fakes, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> "${log}"
case "$1" in
  show)
    case "$*" in
      *--value*) case "$*" in *ProtectSystem*) cat "${root}/protect" 2>/dev/null || echo no ;; *NRestarts*) echo 0 ;; *) echo ;; esac ;;
      *) cat "${root}/unit.props" ;;
    esac ;;
  is-active) [ -f "${root}/active" ]; exit $? ;;
  stop) rm -f "${root}/active" ;;
  start)
    version=$(sed -n 's/.*"version":"\\([0-9.]*\\)".*/\\1/p' "${join(pkg, "package.json")}")
    echo "$version" > "${root}/active"
    echo "$version" > "${data}/seen-$version" ;;
esac
exit 0
`);
  executable(join(fakes, "curl"), `#!/bin/sh
for arg in "$@"; do url=$arg; done
case "$url" in
  http://127.0.0.1:${PORT}/*)
    [ -f "${root}/active" ] || exit 7
    version=$(cat "${root}/active")
    [ -e "${root}/broken-$version" ] && exit 7
    case "$url" in
      */api/health) echo '{"app":"seira"}' ;;
      */api/health/engines) echo '{"engines":1}' ;;
      */.well-known/seira/environment) echo "{\\"environmentId\\":\\"e\\",\\"server\\":{\\"version\\":\\"9.9.9\\"},\\"version\\":\\"$version\\"}" ;;
      *) exit 22 ;;
    esac ;;
  *) exec /usr/bin/curl "$@" ;;
esac
`);
  // npm, as the service user: what it was asked and with which environment, then the package it would have installed.
  executable(node, `#!/bin/sh
echo "$*" >> "${join(root, "npm.log")}"
env | sort > "${join(root, "npm.env")}"
[ -e "${join(root, "npm-fails")}" ] && exit 1
prefix="" spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix=$2; shift ;; ${PACKAGE}@*) spec=\${1#${PACKAGE}@} ;; esac; shift; done
mkdir -p "$prefix/lib/node_modules/${PACKAGE}/node_modules/a"
printf '{"name":"${PACKAGE}","version":"%s"}\\n' "$spec" > "$prefix/lib/node_modules/${PACKAGE}/package.json"
: > "$prefix/lib/node_modules/${PACKAGE}/cli.js"
`);
  writeFileSync(join(root, "active"), `${running}\n`);
  writeFileSync(join(state, "status", "runner"), `layout=service\ndir=${prefix}\nheld=no\nrelease=yes\nunit=seira\n`);
  writeFileSync(join(state, "status", "last"), "run=0\nstate=done\nresult=updated\nat=0\nran=0\n");

  const request = join(state, "request", "request");
  const policy = join(root, "policy.json");
  const env = (extra: Record<string, string>) => ({
    PATH: `${fakes}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, SEIRA_SERVICE_UNIT: "seira", SEIRA_UPDATE_STATE_DIR: state,
    SEIRA_UPDATE_POLICY: policy, SEIRA_UPDATE_BACKUP_DIR: backups, SEIRA_STABLE_URL: `file://${join(root, "stable.json")}`,
    SEIRA_NPM_REGISTRY: `file://${registry}`, SEIRA_SBIN_DIR: join(root, "sbin"), SEIRA_SYSTEMD_DIR: join(root, "systemd"),
    SEIRA_UPDATE_POLL_S: "0", SEIRA_UPDATE_WAIT_S: "2", SEIRA_UPDATE_ENGINE_WAIT_S: "0", SEIRA_RUNNER_QUIET_S: "0",
    SEIRA_RUNNER_IDLE_S: "0", SEIRA_RUNNER_GAP_S: "0", ...extra,
  });
  const run = (args: string[] = [], extra: Record<string, string> = {}) => spawnSync("bash", [RUNNER, ...args], { encoding: "utf8", input: "", timeout: 60_000, env: env(extra) });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return {
    root, prefix, pkg, data, state, backups, request, policy, run, setLatest,
    /** The runner while another run holds its lock. */
    runHoldingLock: () => spawnSync("bash", ["-c", 'exec 9>"$1"; flock -n 9 || exit 3; bash "$2" 9>&-', "_", join(state, "lock"), RUNNER], {
      encoding: "utf8", input: "", timeout: 60_000, env: env({}),
    }),
    ask: (extra: Record<string, string> = {}, text = "x\n") => {
      writeFileSync(request, text);
      return run([], extra);
    },
    installed: () => JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string,
    previous: () => JSON.parse(readFileSync(join(prefix, "lib", "node_modules", "@seira-bot", ".seira-previous", "package.json"), "utf8")).version as string,
    active: () => read(join(root, "active")).trim(),
    last: () => parseRun(readFileSync(join(state, "status", "last"), "utf8")),
    lastText: () => readFileSync(join(state, "status", "last"), "utf8"),
    runner: () => parseRunner(readFileSync(join(state, "status", "runner"), "utf8")),
    copies: () => (existsSync(backups) ? readdirSync(backups).sort() : []),
    calls: () => read(log).trim().split("\n").filter(Boolean),
    npm: () => read(join(root, "npm.log")).trim().split("\n").filter(Boolean),
    npmEnv: () => read(join(root, "npm.env")),
    blocked: () => read(join(state, "blocked")),
    tarList: (name: string) => spawnSync("tar", ["-tzf", join(backups, name)], { encoding: "utf8" }).stdout.trim().split("\n").sort(),
    breakVersion: (version: string) => writeFileSync(join(root, `broken-${version}`), ""),
    file: (name: string) => join(root, name),
  };
}

describe.skipIf(process.platform !== "linux")("deploy/service-update-runner.sh", { timeout: hostTimeout(60_000) }, () => {
  it("parses as bash", () => {
    expect(spawnSync("bash", ["-n", RUNNER]).status).toBe(0);
  });

  it("does nothing without a request, and says again what it updates", () => {
    const box = host();
    const out = box.run();
    expect(out.status).toBe(0);
    expect(box.npm()).toEqual([]);
    expect(box.calls().filter((call) => /systemctl (stop|start)/.test(call))).toEqual([]);
    expect(box.runner()).toEqual({ layout: "service", dir: box.prefix, held: false, release: true, unit: "seira" });
    expect(box.last()).toMatchObject({ run: 0, result: "updated" });
  });

  it("takes a request: npm's newest version as the service user, a root-only copy of the data first, then a healthy start", () => {
    const box = host();
    // The runner never reads the request: none of this can choose a version, a flag or a path.
    const out = box.ask({}, `--rollback\n--version 0.1.100\n${PACKAGE}@0.1.100\n--registry=https://evil.example\n$(touch ${box.file("pwned")})\n`);
    expect(out.status, out.stderr).toBe(0);
    expect(existsSync(box.request)).toBe(false);
    expect(existsSync(box.file("pwned"))).toBe(false);
    expect(box.installed()).toBe(NEW);
    expect(box.active()).toBe(NEW);
    expect(box.previous()).toBe(OLD);
    expect(box.last()).toMatchObject({ run: 1, state: "done", result: "updated", version: NEW });

    const [npm] = box.npm();
    expect(npm).toContain(`install --global --prefix ${box.prefix}/.seira-update/prefix --ignore-scripts`);
    expect(npm).toContain("--userconfig=/dev/null --globalconfig=/dev/null");
    expect(npm).toContain(`--registry=file://${box.root}/registry/ ${PACKAGE}@${NEW}`);
    // npm sees none of root's environment, and no home of the service user's.
    expect(box.npmEnv()).not.toMatch(/^SEIRA_/m);
    expect(box.npmEnv()).not.toContain(`HOME=${box.root}/home\n`);
    expect(box.npmEnv()).toContain(`HOME=${box.prefix}/.seira-update/home`);
    expect(box.calls()).toContain("runuser seira");
    expect(existsSync(join(box.prefix, ".seira-update"))).toBe(false);

    const copies = box.copies();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(new RegExp(`^seira-data-${OLD.replace(/\./g, "\\.")}-\\d{8}T\\d{6}Z\\.tar\\.gz$`));
    expect(box.tarList(copies[0]!)).toEqual(["./", "./config.json"]);
    expect(box.calls().findIndex((call) => call === "systemctl stop seira.service")).toBeLessThan(box.calls().findIndex((call) => call === "systemctl start seira.service"));
    expect(existsSync(join(box.state, "journal"))).toBe(false);
  });

  it("says up to date, without stopping the server, when npm has nothing newer", () => {
    const box = host({ latest: OLD });
    expect(box.ask().status).toBe(0);
    expect(box.npm()).toEqual([]);
    expect(box.calls().filter((call) => /systemctl (stop|start)/.test(call))).toEqual([]);
    expect(box.last()).toMatchObject({ result: "updated", version: OLD });
  });

  it("follows the stable channel when it names a version npm has, and waits when npm does not have it yet", () => {
    const pinned = host({ stable: OLD, latest: NEW });
    expect(pinned.ask().status).toBe(0);
    expect(pinned.installed()).toBe(OLD);
    expect(pinned.npm()).toEqual([]);

    const waiting = host({ stable: "0.1.152", latest: "0.1.152" });
    expect(waiting.ask().status).toBe(0);
    expect(waiting.npm()).toEqual([]);
    expect(waiting.last()).toMatchObject({ result: "updated", version: OLD });
  });

  it("puts the old version and its data back when the new one does not answer, and does not try that version again", () => {
    const box = host();
    box.breakVersion(NEW);
    const out = box.ask();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain(`${NEW} is not healthy`);
    expect(box.installed()).toBe(OLD);
    expect(box.active()).toBe(OLD);
    expect(box.last()).toMatchObject({ result: "rolled-back", version: NEW });
    // What the newer version wrote is gone; what the copy leaves out was never touched.
    expect(existsSync(join(box.data, `seen-${NEW}`))).toBe(false);
    expect(readFileSync(join(box.data, "config.json"), "utf8")).toBe('{"profile":"before"}\n');
    expect(readFileSync(join(box.data, "workspaces", "big"), "utf8")).toBe("kept out of the copy\n");
    expect(existsSync(join(box.data, ".seira-update-replaced"))).toBe(false);
    expect(box.blocked()).toBe(`installed=${OLD}\ntarget=${NEW}\n`);

    expect(box.ask().status).toBe(0);
    expect(box.last()).toMatchObject({ run: 2, result: "not-retried" });
    expect(box.npm()).toHaveLength(1);
  });

  it("changes nothing when npm cannot install the version, and does not count it against the gap", () => {
    const box = host();
    writeFileSync(box.file("npm-fails"), "");
    expect(box.ask({ SEIRA_RUNNER_GAP_S: "3600" }).status).toBe(0);
    expect(box.last()).toMatchObject({ result: "refused" });
    expect(box.lastText()).toContain("\nran=0\n");
    expect(box.installed()).toBe(OLD);
    expect(box.calls().filter((call) => /systemctl (stop|start)/.test(call))).toEqual([]);
    expect(box.copies()).toEqual([]);
  });

  it("refuses a request held by the owner's policy, one too soon after a run, and one that is busy", () => {
    const held = host();
    writeFileSync(held.policy, '{ "updates": "hold" }\n');
    expect(held.ask().status).toBe(0);
    expect(held.last()).toMatchObject({ result: "held" });
    expect(held.runner()).toMatchObject({ held: true });
    expect(held.npm()).toEqual([]);

    const soon = host();
    writeFileSync(join(soon.state, "status", "last"), `run=4\nstate=done\nresult=updated\nat=0\nran=${Math.floor(Date.now() / 1000)}\n`);
    expect(soon.ask({ SEIRA_RUNNER_GAP_S: "3600" }).status).toBe(0);
    expect(soon.last()).toMatchObject({ run: 5, result: "too-soon" });
    expect(soon.npm()).toEqual([]);

    const busy = host();
    writeFileSync(busy.request, "x\n");
    expect(busy.runHoldingLock().status).toBe(0);
    expect(busy.last()).toMatchObject({ result: "busy" });
    expect(busy.npm()).toEqual([]);
  });

  it("refuses to run npm when the service user can change node or npm", () => {
    const box = host({ ownsNode: true });
    expect(box.ask().status).toBe(0);
    const last = box.last();
    expect(last).toMatchObject({ result: "unsafe" });
    expect(last?.detail).toMatch(new RegExp(`^${box.root}/tools/bin/node \\S+:\\S+ \\d+$`));
    expect(box.npm()).toEqual([]);
  });

  it("has nothing to update for a service that runs as root", () => {
    const box = host({ user: "root" });
    expect(box.ask().status).toBe(0);
    expect(box.last()).toMatchObject({ result: "no-updater" });
    expect(box.npm()).toEqual([]);
  });

  it("keeps a run cut off after a healthy start, and stops for a person at any other", () => {
    const kept = host();
    writeFileSync(join(kept.pkg, "package.json"), JSON.stringify({ name: PACKAGE, version: NEW }));
    writeFileSync(kept.file("active"), `${NEW}\n`);
    writeFileSync(join(kept.state, "journal"), `step=started\nfrom=${OLD}\nto=${NEW}\ncopy=x\nby=runner\n`);
    expect(kept.ask({}).status).toBe(0);
    expect(kept.last()).toMatchObject({ result: "updated" });
    expect(existsSync(join(kept.state, "journal"))).toBe(false);

    const stuck = host();
    writeFileSync(join(stuck.state, "journal"), `step=swapping\nfrom=${OLD}\nto=${NEW}\ncopy=x\nby=runner\n`);
    expect(stuck.ask().status).toBe(0);
    expect(stuck.last()).toMatchObject({ result: "failed" });
    expect(stuck.npm()).toEqual([]);
  });

  it("updates for a person with --now, and --rollback --yes puts that version and its data back", () => {
    const box = host();
    const now = box.run(["--now"]);
    expect(now.status, now.stderr).toBe(0);
    expect(box.installed()).toBe(NEW);
    expect(box.copies()[0]).toMatch(/-manual\.tar\.gz$/);
    writeFileSync(join(box.data, "config.json"), '{"profile":"after"}\n');

    const refused = box.run(["--rollback"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--yes");
    expect(box.installed()).toBe(NEW);

    const back = box.run(["--rollback", "--yes"]);
    expect(back.status, back.stderr).toBe(0);
    expect(box.installed()).toBe(OLD);
    expect(box.active()).toBe(OLD);
    expect(readFileSync(join(box.data, "config.json"), "utf8")).toBe('{"profile":"before"}\n');
    expect(box.blocked()).toBe(`installed=${OLD}\ntarget=${NEW}\n`);
  });

  it("installs the units, root's copy and the request folder, and refuses a host whose button updates Docker", () => {
    const box = host();
    rmSync(box.state, { recursive: true });
    writeFileSync(box.file("protect"), "strict\n");
    const out = box.run(["--install"]);
    expect(out.status, out.stderr).toBe(0);
    expect(readFileSync(join(box.root, "sbin", "seira-service-update"), "utf8")).toBe(readFileSync(RUNNER, "utf8"));
    const path = readFileSync(join(box.root, "systemd", "seira-update.path"), "utf8");
    expect(path).toContain(`PathExists=${box.state}/request/request`);
    expect(path).toContain(`PathChanged=${box.policy}`);
    const service = readFileSync(join(box.root, "systemd", "seira-update.service"), "utf8");
    expect(service).toContain(`ExecStart=${box.root}/sbin/seira-service-update`);
    expect(service).toContain(`SEIRA_SERVICE_UNIT=seira SEIRA_STABLE_URL=file://${box.root}/stable.json SEIRA_NPM_REGISTRY=file://${box.root}/registry`);
    expect(box.calls()).toContain("systemctl enable --now seira-update.path");
    expect(box.calls().some((call) => call.startsWith(`install -d -m 0700 -o ${process.getuid!() + 1} -g ${process.getgid!() + 1} ${box.state}/request`))).toBe(true);
    expect(box.runner()).toEqual({ layout: "service", dir: box.prefix, held: false, release: true, unit: "seira" });
    expect(out.stdout).toContain(`ReadWritePaths=${box.state}/request`);

    const docker = host();
    writeFileSync(join(docker.state, "status", "runner"), "layout=compose\ndir=/opt/seira\nheld=no\n");
    const refused = docker.run(["--install"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Docker");
    expect(existsSync(join(docker.root, "systemd", "seira-update.path"))).toBe(false);
  });
});
