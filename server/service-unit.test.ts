import { describe, expect, it } from "vitest";

import { LEGACY_SENTINEL_LAUNCHD_LABEL, LEGACY_SENTINEL_SYSTEMD_NAME } from "../electron/legacy-names.mjs";
import {
  checkSentinelInstall, earlierSentinelSchedule, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/seira/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/seira/.seira", "--domain", "seira.example.com", "--no-pair"],
  dataDir: "/home/seira/.seira",
  user: "seira",
  home: "/home/seira",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/seira/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/Seira/server/seira.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=Seira (agentada)");
    expect(unit).toContain("User=seira");
    expect(unit).toContain("Environment=SEIRA_DATA_DIR=/home/seira/.seira");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/seira/cli.js serve --port 8799 --data-dir /home/seira/.seira --domain seira.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/seira/.seira"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/seira/My Data", serveArgs: ["--data-dir", "/home/seira/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/seira/cli.js serve --data-dir "/home/seira/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/seira", dataDir: "/Users/seira/.seira" });
    expect(plist).toContain("<string>com.seira.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>seira.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/seira/.seira/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/seira/.npm/_npx/abc123/node_modules/seira/cli.js")).toMatch(/npm install -g @seira-bot\/seira/);
    expect(unstableInstallWarning("/usr/lib/node_modules/seira/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/seira/.seira");
    expect(linux?.installed).toBe("/etc/systemd/system/seira.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now seira");
    const mac = servicePlan("darwin", "/Users/seira/.seira", "/Users/seira");
    expect(mac?.installed).toBe("/Users/seira/Library/LaunchAgents/com.seira.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/seira/Library/Application Support/seira-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/seira/cli.js", dataDir: "/Users/seira/.seira", home: "/Users/seira", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/seira/cli.js", "sentinel", "--once", "--data-dir", "/Users/seira/.seira", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/Seira/server/seira.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.seira.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".seira/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/seira");
    expect(mac?.files).toEqual([{ name: "com.seira.sentinel.plist", installed: "/Users/seira/Library/LaunchAgents/com.seira.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/seira/Library/LaunchAgents && cp '/Users/seira/Library/Application Support/seira-sentinel/com.seira.sentinel.plist' /Users/seira/Library/LaunchAgents/com.seira.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.seira.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/seira/cli.js", dataDir: "/home/seira/My Data", home: "/home/seira", out: "/home/seira/.local/state/seira-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/seira/cli.js sentinel --once --data-dir "/home/seira/My Data" --out /home/seira/.local/state/seira-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/seira");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/seira/.config/systemd/user/seira-sentinel.service", "/home/seira/.config/systemd/user/seira-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/seira/.local/state/seira-sentinel/seira-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now seira-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/Seira.app/Contents";
    const present = new Set([`${app}/MacOS/Seira`, `${app}/Resources/server/seira.js`]);
    expect(shippedSentinelCli("darwin", "/Users/seira", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/Seira`, script: `${app}/Resources/server/seira.js` });
    const user = "/Users/seira/Applications/Seira.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/seira", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/seira.js`);
    expect(shippedSentinelCli("linux", "/home/seira", (path) => path.startsWith("/opt/Seira/"))).toEqual({ node: "/opt/Seira/seira", script: "/opt/Seira/resources/server/seira.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/seira", (path) => path.endsWith("MacOS/Seira"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/seira", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\seira", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/Seira`, script: `${app}/Resources/server/seira.js`, dataDir: "/Users/seira/.seira", home: "/Users/seira", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/seira/cli.js", dataDir: "/home/seira/100% $HOME\\", home: "/home/my seira", out: "/home/my seira/.local/state/seira-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my seira"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/seira/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/seira/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/seira\n[Service]\nExecStartPre=/bin/true", "/home/seira\r", "/home/\0seira"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/seira/cli.js", dataDir: "/home/seira/My Data", home: "/home/seira", out: "/home/seira/.local/state/seira-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/seira/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/seira/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/seira/.config/systemd/user/seira-sentinel.service";
    const timer = "/home/seira/.config/systemd/user/seira-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/seira", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/seira", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/seira/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/seira", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/seira", fs([]))).toEqual({ status: "not_installed", unit: "/Users/seira/Library/LaunchAgents/com.seira.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/seira", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\seira", fs([]))).toEqual({ status: "unsupported" });
  });

  it("finds the Sentinel schedule an earlier version installed and gives the commands that remove it", () => {
    const unit = `/home/seira/.config/systemd/user/${LEGACY_SENTINEL_SYSTEMD_NAME}.service`;
    const timer = `/home/seira/.config/systemd/user/${LEGACY_SENTINEL_SYSTEMD_NAME}.timer`;
    const plist = `/Users/seira/Library/LaunchAgents/${LEGACY_SENTINEL_LAUNCHD_LABEL}.plist`;
    const fs = (...present: string[]) => ({ exists: (path: string) => present.includes(path), read: () => "" });
    expect(checkSentinelInstall("linux", "/home/seira", fs(unit, timer))).toEqual({
      status: "earlier_version",
      unit,
      deactivate: [`systemctl --user disable --now ${LEGACY_SENTINEL_SYSTEMD_NAME}.timer`, `rm ${unit} ${timer}`, "systemctl --user daemon-reload"],
    });
    expect(checkSentinelInstall("darwin", "/Users/seira", fs(plist))).toEqual({
      status: "earlier_version",
      unit: plist,
      deactivate: [`launchctl bootout gui/$(id -u)/${LEGACY_SENTINEL_LAUNCHD_LABEL}`, `rm ${plist}`],
    });
    expect(checkSentinelInstall("darwin", "/Users/seira", fs())).toMatchObject({ status: "not_installed" });
    expect(earlierSentinelSchedule("darwin", "/Users/seira", () => false)).toBeNull();
    expect(earlierSentinelSchedule("win32", "C:\\Users\\seira", () => true)).toBeNull();
    expect(earlierSentinelSchedule("linux", "/home/seira", fs(unit))?.files).toEqual([unit, timer]);
  });

  it("keeps checking the current schedule when an earlier one is also installed", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/seira/cli.js", dataDir: "/home/seira/data", home: "/home/seira", out: "/home/seira/out" };
    const dir = "/home/seira/.config/systemd/user";
    const current = `${dir}/seira-sentinel.service`;
    const earlier = `${dir}/${LEGACY_SENTINEL_SYSTEMD_NAME}.service`;
    const present = [current, earlier, `${dir}/seira-sentinel.timer`, spec.node, spec.script];
    const fs = { exists: (path: string) => present.includes(path), read: () => sentinelSystemdService(spec) };
    expect(checkSentinelInstall("linux", "/home/seira", fs)).toMatchObject({ status: "ok", unit: current });
  });
});
