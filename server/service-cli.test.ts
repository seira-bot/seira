import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LEGACY_SENTINEL_LAUNCHD_LABEL, LEGACY_SENTINEL_SYSTEMD_NAME } from "../electron/legacy-names.mjs";
import { runServiceCommand, serviceServeArgs } from "./service-cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("seira service", () => {
  let dir: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seira-service-"));
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => removeTempDir(dir));

  it("repeats the serve options the person gave, --public-url and --lan included", () => {
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", domain: "a.example.com", tunnel: true, label: "x" })).toEqual(["--port", "8799", "--data-dir", "/d", "--domain", "a.example.com", "--label", "x"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", tailscale: true })).toEqual(["--port", "1", "--data-dir", "/d", "--tailscale"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", publicUrl: "https://seira.example.com", lan: true })).toEqual(["--port", "1", "--data-dir", "/d", "--public-url", "https://seira.example.com", "--lan"]);
  });

  it("writes the unit next to the data and prints how to install it; under npx, runs a copy kept beside the data", () => {
    const code = runServiceCommand({ action: "install", dataDir: dir, port: 8799, domain: "seira.example.com", script: "/usr/lib/node_modules/seira/cli.js", node: "/usr/bin/node", platform: "linux", home: "/home/seira", user: "seira" }, io);
    expect(code).toBe(0);
    const unit = readFileSync(join(dir, "seira.service"), "utf8");
    expect(unit).toContain("--domain seira.example.com");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(out.join("\n")).toContain("sudo systemctl enable --now seira");
    expect(out.join("\n")).toContain("no setcap is needed");

    out.length = 0;
    const npx = { action: "install" as const, dataDir: join(dir, "x"), port: 8799, publicUrl: "https://seira.example.com", script: "/home/seira/.npm/_npx/deadbeef/node_modules/seira/dist-server/seira.js", node: "/usr/bin/node", platform: "linux" as const, home: "/home/seira", user: "seira" };
    const installs: string[] = [];
    expect(runServiceCommand({ ...npx, installCopy: (prefix) => { installs.push(prefix); return false; } }, io)).toBe(1);
    expect(err.join("\n")).toContain(`npm install --prefix ${join(dir, "x", "app", "latest")} @seira-bot/seira@latest`);
    expect(existsSync(join(dir, "x", "seira.service"))).toBe(false);
    expect(runServiceCommand({ ...npx, installCopy: (prefix) => { installs.push(prefix); return true; }, exists: () => true }, io)).toBe(0);
    const pinned = readFileSync(join(dir, "x", "seira.service"), "utf8");
    const script = join(dir, "x", "app", "latest", "node_modules", "@seira-bot", "seira", "dist-server", "seira.js");
    expect(pinned).toContain(`ExecStart=/usr/bin/node ${/[\s"\\]/.test(script) ? `"${script.replace(/[\\"]/g, "\\$&")}"` : script} serve`);
    expect(pinned).toContain("--public-url https://seira.example.com");
    expect(pinned).not.toContain("--no-pair");
    expect(pinned).toContain('Environment="SEIRA_CLI_PREFIX=npx @seira-bot/seira"');
    expect(installs).toEqual([join(dir, "x", "app", "latest"), join(dir, "x", "app", "latest")]);
  });

  it("carries the install PATH into the unit and says to install again after a Node upgrade", () => {
    const base = { action: "install" as const, dataDir: dir, port: 8799, script: "/usr/lib/node_modules/seira/cli.js", node: "/home/alice/.nvm/versions/node/v22.1.0/bin/node", platform: "linux" as const, home: "/home/alice", user: "alice", euid: 1000 };
    expect(runServiceCommand({ ...base, pathEnv: "/opt/engines/bin:/usr/bin:relative" }, io)).toBe(0);
    expect(readFileSync(join(dir, "seira.service"), "utf8"))
      .toContain('Environment="PATH=/home/alice/.nvm/versions/node/v22.1.0/bin:/opt/engines/bin:/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin"');
    expect(out.join("\n")).toContain("After you upgrade Node, run");
    expect(err.join("\n")).not.toContain("root");
  });

  it("warns when the service would run as root, says how to use a normal user, and creates none", () => {
    const base = { action: "install" as const, dataDir: dir, port: 8799, script: "/usr/lib/node_modules/seira/cli.js", node: "/usr/bin/node", platform: "linux" as const, home: "/root", user: "root", euid: 0 };
    expect(runServiceCommand(base, io)).toBe(0);
    const warning = err.join("\n");
    expect(warning).toContain("runs as root");
    expect(warning).toContain("Full access");
    expect(warning).toContain("sudo adduser seira");
    expect(warning).toContain("service install");
    expect(existsSync(join(dir, "seira.service"))).toBe(true);
  });

  it("writes a launchd agent on macOS and explains uninstall on both", () => {
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, tunnel: true, script: "/opt/homebrew/lib/node_modules/seira/cli.js", node: "/opt/homebrew/bin/node", platform: "darwin", home: "/Users/seira", env: { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" } }, io)).toBe(0);
    expect(readFileSync(join(dir, "com.seira.serve.plist"), "utf8")).toContain("<string>--tunnel</string>");
    expect(out.join("\n")).toContain("launchctl bootstrap");
    out.length = 0;
    expect(runServiceCommand({ action: "uninstall", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "linux" }, io)).toBe(0);
    expect(out.join("\n")).toContain("sudo systemctl disable --now seira");
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "win32" }, io)).toBe(1);
  });

  it("--sentinel writes the scan's own schedule into its own folder, not the data dir, and only prints how to install it", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const dataDir = join(dir, "data");
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, sentinelOut, script: "/usr/lib/node_modules/seira/cli.js", node: "/usr/bin/node", exists: () => false };
    expect(runServiceCommand({ ...base, platform: "darwin", home: "/Users/seira" }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.seira.sentinel.plist"), "utf8");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(plist).toContain(`<string>${sentinelOut}</string>`);
    expect(out.join("\n")).toContain("seira sentinel --check-install");
    expect(existsSync(dataDir)).toBe(false);
    expect(out.join("\n")).toContain("launchctl bootstrap gui/$(id -u) /Users/seira/Library/LaunchAgents/com.seira.sentinel.plist");
    expect(out.join("\n")).toContain(`issues: ${join(sentinelOut, "issues.jsonl")}`);

    out.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/seira" }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "seira-sentinel.service"), "utf8")).toContain("sentinel --once --data-dir");
    expect(readFileSync(join(sentinelOut, "seira-sentinel.timer"), "utf8")).toContain("OnUnitActiveSec=120s");
    expect(out.join("\n")).toContain("systemctl --user enable --now seira-sentinel.timer");
    expect(existsSync(dataDir)).toBe(false);

    out.length = 0;
    expect(runServiceCommand({ ...base, action: "uninstall", platform: "linux", home: "/home/seira" }, io)).toBe(0);
    expect(out.join("\n")).toContain("systemctl --user disable --now seira-sentinel.timer");

    // Windows gets a schtasks line, with the platform's own folder as --out
    expect(runServiceCommand({ ...base, sentinelOut: undefined, platform: "win32", dataDir: "C:\\Users\\seira\\.seira", home: "C:\\Users\\seira", env: {} }, io)).toBe(1);
    expect(err.join("\n")).toContain('schtasks /Create /SC MINUTE /MO 2 /TN "Seira Sentinel" /TR "\\"/usr/bin/node\\" \\"/usr/lib/node_modules/seira/cli.js\\" \\"sentinel\\"');
    expect(err.join("\n")).toContain("\\\"--out\\\" \\\"C:\\Users\\seira\\AppData\\Local\\seira-sentinel\\\"");
  });

  // Simulates a Linux install with the host's paths; on Windows those are backslash paths no Linux unit has.
  it("--sentinel lists the commands that remove a schedule an earlier version installed, before the install steps", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const base = { action: "install" as const, dataDir: join(dir, "data"), port: 8799, sentinel: true, sentinelOut, script: "/usr/lib/node_modules/seira/cli.js", node: "/usr/bin/node" };
    const oldPlist = `/Users/seira/Library/LaunchAgents/${LEGACY_SENTINEL_LAUNCHD_LABEL}.plist`;
    expect(runServiceCommand({ ...base, platform: "darwin", home: "/Users/seira", exists: (path) => path === oldPlist }, io)).toBe(0);
    let text = out.join("\n");
    expect(text).toContain("first remove the schedule an earlier version installed:");
    expect(text).toContain(`launchctl bootout gui/$(id -u)/${LEGACY_SENTINEL_LAUNCHD_LABEL}`);
    expect(text).toContain(`rm ${oldPlist}`);
    expect(text.indexOf("first remove")).toBeLessThan(text.indexOf("launchctl bootstrap"));
    out.length = 0;
    const oldUnit = `/home/seira/.config/systemd/user/${LEGACY_SENTINEL_SYSTEMD_NAME}.service`;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/seira", exists: (path) => path === oldUnit }, io)).toBe(0);
    text = out.join("\n");
    expect(text).toContain(`systemctl --user disable --now ${LEGACY_SENTINEL_SYSTEMD_NAME}.timer`);
    out.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/seira", exists: () => false }, io)).toBe(0);
    expect(out.join("\n")).not.toContain("first remove");
  });

  it.skipIf(process.platform === "win32")("--sentinel refuses an output folder the scan itself would refuse, before writing anything", () => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, script: "/usr/lib/node_modules/seira/cli.js", node: "/usr/bin/node", exists: () => false };
    // XDG_STATE_HOME pointing into the data dir makes the default land there
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), env: { XDG_STATE_HOME: join(dataDir, "state") } }, io)).toBe(1);
    expect(err.join("\n")).toContain("refusing to write issues inside the data dir");
    expect(existsSync(join(dataDir, "state"))).toBe(false);
    // a path no unit file can hold
    err.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), sentinelOut: join(dir, "out"), dataDir: `${dataDir}\nExecStartPre=/bin/true` }, io)).toBe(1);
    expect(err.join("\n")).toContain("line break or NUL");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("--sentinel prefers the installed app's own CLI over a checkout, which an update or Node upgrade would strand", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const app = "/Applications/Seira.app/Contents";
    const checkout = { action: "install" as const, dataDir: join(dir, "data"), port: 8799, sentinel: true, sentinelOut, script: "/src/Seira/server/seira.ts", node: "/home/seira/.nvm/versions/node/v24.0.0/bin/node", platform: "darwin" as const, home: "/Users/seira" };
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => true }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.seira.sentinel.plist"), "utf8");
    expect(plist).toContain(`<string>${app}/MacOS/Seira</string>`);
    expect(plist).toContain(`<string>${app}/Resources/server/seira.js</string>`);
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(plist).not.toContain("seira.ts");
    expect(out.join("\n")).toContain("runs the desktop app's own CLI");

    // an installed app from before Sentinel, or none: the checkout it was run
    // from, with a warning that it can move
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.seira.sentinel.plist"), "utf8")).not.toContain("ELECTRON_RUN_AS_NODE");
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.seira.sentinel.plist"), "utf8")).toContain("<string>--experimental-strip-types</string>");
    expect(out.join("\n")).toContain("if either moves (a new checkout, a Node upgrade), run this again");
  });
});
