import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  networkInterfaces: () => ({
    docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1", netmask: "255.255.0.0" }],
    wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.34", netmask: "255.255.255.0" }],
  }),
}));

import { companionState } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";
import {
  createLinuxFirewallCheck,
  firewalldZoneVerdict,
  ipv4Contains,
  linuxFirewallProblem,
  portListContains,
  servicePorts,
  subnetOf,
  ufwAllows,
  type FileRead,
  type FirewallHost,
  type PhoneLan,
  type RunResult,
} from "../src/linux-firewall.ts";

const lan: PhoneLan = { name: "wlan0", address: "192.168.1.34", port: 8810 };

const UFW_ON = "# /etc/ufw/ufw.conf\nENABLED=yes\nLOGLEVEL=low\n";
const UFW_OFF = "ENABLED=no\n";
const DROP = 'IPV6=yes\nDEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\n';
const ACCEPT = 'DEFAULT_INPUT_POLICY="ACCEPT"\n';
const SSH_ONLY = [
  "*filter",
  "### RULES ###",
  "",
  "### tuple ### allow any 22 0.0.0.0/0 any 0.0.0.0/0 in",
  "-A ufw-user-input -p tcp --dport 22 -j ACCEPT",
  "",
  "### END RULES ###",
].join("\n");
const tuple = (rest: string) => `${SSH_ONLY}\n### tuple ### ${rest}\n`;

const PUBLIC_ZONE = [
  "public (default, active)",
  "  target: default",
  "  icmp-block-inversion: no",
  "  interfaces: wlan0",
  "  sources: ",
  "  services: dhcpv6-client ssh",
  "  ports: ",
  "  protocols: ",
  "  forward: yes",
  "  masquerade: no",
  "  forward-ports: ",
  "  source-ports: ",
  "  icmp-blocks: ",
  "  rich rules: ",
].join("\n");

const SERVICES: Record<string, string> = {
  "/usr/lib/firewalld/services/ssh.xml": '<service><short>SSH</short><port protocol="tcp" port="22"/></service>',
  "/usr/lib/firewalld/services/dhcpv6-client.xml": '<service><port protocol="udp" port="546"/></service>',
  "/usr/lib/firewalld/services/seira.xml": '<service><port protocol="tcp" port="8800-8820"/></service>',
};

const denied: FileRead = { missing: false };
const missing: FileRead = { missing: true };

function host({
  files = {},
  run = {},
}: {
  files?: Record<string, FileRead>;
  run?: Record<string, RunResult>;
}): FirewallHost & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    read: async (path) => files[path] ?? SERVICES[path] ?? missing,
    run: async (file, args) => {
      const line = [file, ...args].join(" ");
      ran.push(line);
      return line in run ? run[line] : null;
    },
    interfaces: () => ({ wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.34", netmask: "255.255.255.0", mac: "", cidr: null }] }),
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout: `${stdout}\n` });
const ufwHost = (rules: FileRead, defaults: FileRead = DROP, unit: RunResult = ok("active")) =>
  host({
    files: { "/etc/ufw/ufw.conf": UFW_ON, "/etc/default/ufw": defaults, "/etc/ufw/user.rules": rules },
    run: { "systemctl is-active ufw": unit, "systemctl is-active firewalld": { code: 3, stdout: "inactive\n" } },
  });
const firewalldHost = (zone: RunResult, extra: Record<string, RunResult> = {}, files: Record<string, FileRead> = {}) =>
  host({
    files,
    run: {
      "systemctl is-active firewalld": ok("active"),
      "firewall-cmd --get-zone-of-interface=wlan0": ok("public"),
      "firewall-cmd --zone=public --list-all": zone,
      ...extra,
    },
  });

describe("address and port helpers", () => {
  it("matches IPv4 ranges and single addresses", () => {
    expect(ipv4Contains("0.0.0.0/0", "192.168.1.34")).toBe(true);
    expect(ipv4Contains("any", "192.168.1.34")).toBe(true);
    expect(ipv4Contains("192.168.0.0/16", "192.168.1.34")).toBe(true);
    expect(ipv4Contains("192.168.1.34", "192.168.1.34")).toBe(true);
    expect(ipv4Contains("10.0.0.0/8", "192.168.1.34")).toBe(false);
    expect(ipv4Contains("::/0", "192.168.1.34")).toBe(false);
    expect(ipv4Contains("192.168.1.0/33", "192.168.1.34")).toBe(false);
  });

  it("names the network of an address", () => {
    expect(subnetOf("192.168.1.34", "255.255.255.0")).toBe("192.168.1.0/24");
    expect(subnetOf("10.20.30.40", "255.255.240.0")).toBe("10.20.16.0/20");
    expect(subnetOf("192.168.1.34", "255.255.255.255")).toBeNull();
    expect(subnetOf("192.168.1.34", "255.0.255.0")).toBeNull();
    expect(subnetOf("192.168.1.34", undefined)).toBeNull();
  });

  it("reads single ports, ranges and lists in either firewall's spelling", () => {
    expect(portListContains("any", 8810)).toBe(true);
    expect(portListContains("8810", 8810)).toBe(true);
    expect(portListContains("22,8000:9000", 8810)).toBe(true);
    expect(portListContains("1025-65535", 8810)).toBe(true);
    expect(portListContains("8811", 8810)).toBe(false);
    expect(portListContains("http", 8810)).toBe(false);
  });
});

describe("ufwAllows", () => {
  it("finds an allow for the port from anywhere or from the phone's network", () => {
    expect(ufwAllows(tuple("allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in"), lan)).toBe(true);
    expect(ufwAllows(tuple("allow tcp 8810 0.0.0.0/0 any 192.168.1.0/24 in"), lan)).toBe(true);
    expect(ufwAllows(tuple("allow any 8000:9000 0.0.0.0/0 any 0.0.0.0/0 in"), lan)).toBe(true);
    expect(ufwAllows(tuple("limit_log tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in comment=6869"), lan)).toBe(true);
    expect(ufwAllows(tuple("allow any any 0.0.0.0/0 any 192.168.0.0/16 in_wlan0"), lan)).toBe(true);
    expect(ufwAllows(tuple("allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 Seira - in"), lan)).toBe(true);
  });

  it("ignores rules for another port, protocol, network, interface or direction", () => {
    expect(ufwAllows(SSH_ONLY, lan)).toBe(false);
    for (const rest of [
      "allow tcp 8811 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow udp 8810 0.0.0.0/0 any 0.0.0.0/0 in",
      "deny tcp 8810 0.0.0.0/0 any 0.0.0.0/0 in",
      "allow tcp 8810 0.0.0.0/0 any 10.0.0.0/8 in",
      "allow tcp 8810 0.0.0.0/0 any 192.168.1.50 in",
      "allow tcp 8810 172.17.0.1 any 0.0.0.0/0 in",
      "allow tcp 8810 0.0.0.0/0 1234 0.0.0.0/0 in",
      "allow any any 0.0.0.0/0 any 0.0.0.0/0 in_tailscale0",
      "allow tcp 8810 0.0.0.0/0 any 0.0.0.0/0 out",
    ]) {
      expect(ufwAllows(tuple(rest), lan), rest).toBe(false);
    }
  });
});

describe("linuxFirewallProblem with ufw", () => {
  it("is blocking when the rules were read and none lets the phone in", async () => {
    expect(await linuxFirewallProblem(lan, ufwHost(SSH_ONLY))).toEqual({
      certain: true,
      command: "sudo ufw allow from 192.168.1.0/24 to any port 8810 proto tcp",
    });
  });

  it("may block when the rules cannot be read, as on Ubuntu", async () => {
    expect(await linuxFirewallProblem(lan, ufwHost(denied))).toEqual({
      certain: false,
      command: "sudo ufw allow from 192.168.1.0/24 to any port 8810 proto tcp",
    });
  });

  it("uses the port the listener serves", async () => {
    const result = await linuxFirewallProblem({ ...lan, port: 18810 }, ufwHost(SSH_ONLY));
    expect(result?.command).toBe("sudo ufw allow from 192.168.1.0/24 to any port 18810 proto tcp");
  });

  it("falls back to the port alone when the network mask is unknown", async () => {
    const h = ufwHost(SSH_ONLY);
    h.interfaces = () => ({});
    expect((await linuxFirewallProblem(lan, h))?.command).toBe("sudo ufw allow 8810/tcp");
  });

  it("says nothing when a rule lets the phone in, the default accepts, or ufw is off", async () => {
    expect(await linuxFirewallProblem(lan, ufwHost(tuple("allow tcp 8810 0.0.0.0/0 any 192.168.1.0/24 in")))).toBeNull();
    expect(await linuxFirewallProblem(lan, ufwHost(SSH_ONLY, ACCEPT))).toBeNull();
    expect(await linuxFirewallProblem(lan, ufwHost(SSH_ONLY, DROP, { code: 3, stdout: "inactive\n" }))).toBeNull();
    const off = ufwHost(SSH_ONLY);
    const read = off.read;
    off.read = async (path) => (path === "/etc/ufw/ufw.conf" ? UFW_OFF : read(path));
    expect(await linuxFirewallProblem(lan, off)).toBeNull();
    expect(await linuxFirewallProblem(lan, host({}))).toBeNull();
  });

  it("keeps to ENABLED=yes when there is no systemctl", async () => {
    expect((await linuxFirewallProblem(lan, ufwHost(SSH_ONLY, DROP, null)))?.certain).toBe(true);
  });
});

describe("firewalld", () => {
  it("reads the ports, services and rich rules of a zone", async () => {
    const zone = (lines: Record<string, string>) =>
      PUBLIC_ZONE.split("\n").map((line) => {
        const key = line.trim().split(":")[0];
        return key in lines ? `  ${key}: ${lines[key]}` : line;
      }).join("\n");
    const verdict = (text: string, files: Record<string, FileRead> = {}) => firewalldZoneVerdict(host({ files }), text, lan);

    expect(await verdict(PUBLIC_ZONE)).toBe("no");
    expect(await verdict(zone({ target: "ACCEPT" }))).toBe("allows");
    expect(await verdict(zone({ ports: "1025-65535/udp 1025-65535/tcp" }))).toBe("allows");
    expect(await verdict(zone({ ports: "8810/udp" }))).toBe("no");
    expect(await verdict(zone({ services: "ssh seira" }))).toBe("allows");
    expect(await verdict(zone({ services: "ssh custom" }), { "/etc/firewalld/services/custom.xml": denied })).toBe("unknown");
    expect(await verdict(zone({ services: "ssh custom" }))).toBe("unknown");

    const rich = (rule: string) => `${PUBLIC_ZONE}\n\t${rule}`;
    expect(await verdict(rich('rule family="ipv4" source address="192.168.1.0/24" accept'))).toBe("allows");
    expect(await verdict(rich('rule family="ipv4" source address="192.168.1.0/24" port port="8810" protocol="tcp" accept'))).toBe("allows");
    expect(await verdict(rich('rule family="ipv4" source address="10.0.0.0/8" accept'))).toBe("no");
    expect(await verdict(rich('rule family="ipv4" source NOT address="10.0.0.0/8" accept'))).toBe("no");
    expect(await verdict(rich('rule family="ipv4" source ipset="home" accept'))).toBe("no");
    expect(await verdict(rich('rule family="ipv4" port port="8810" protocol="tcp" reject'))).toBe("no");
    expect(await verdict(rich('rule family="ipv4" forward-port port="80" protocol="tcp" to-port="8810" accept'))).toBe("no");
    expect(await verdict(rich('rule service name="seira" accept'))).toBe("allows");
  });

  it("reads the ports of a service file", () => {
    expect(servicePorts('<service><port protocol="tcp" port="80"/><port port="443" protocol="tcp"/></service>')).toEqual([
      "80/tcp",
      "443/tcp",
    ]);
  });

  it("is blocking in the zone of the phone's network, with a command for that zone", async () => {
    expect(await linuxFirewallProblem(lan, firewalldHost(ok(PUBLIC_ZONE)))).toEqual({
      certain: true,
      command: "sudo firewall-cmd --zone=public --add-port=8810/tcp && sudo firewall-cmd --permanent --zone=public --add-port=8810/tcp",
    });
  });

  it("uses the default zone when the network has none of its own", async () => {
    const h = firewalldHost(ok(PUBLIC_ZONE), {
      "firewall-cmd --get-zone-of-interface=wlan0": { code: 2, stdout: "no zone\n" },
      "firewall-cmd --get-default-zone": ok("public"),
    });
    expect((await linuxFirewallProblem(lan, h))?.certain).toBe(true);
  });

  it("may block when the zone cannot be read", async () => {
    expect(await linuxFirewallProblem(lan, firewalldHost({ code: 11, stdout: "" }))).toEqual({
      certain: false,
      command: "sudo firewall-cmd --zone=public --add-port=8810/tcp && sudo firewall-cmd --permanent --zone=public --add-port=8810/tcp",
    });
    const noZone = firewalldHost(ok(PUBLIC_ZONE), {
      "firewall-cmd --get-zone-of-interface=wlan0": { code: 11, stdout: "" },
      "firewall-cmd --get-default-zone": { code: 11, stdout: "" },
    });
    expect(await linuxFirewallProblem(lan, noZone)).toEqual({
      certain: false,
      command: "sudo firewall-cmd --add-port=8810/tcp && sudo firewall-cmd --permanent --add-port=8810/tcp",
    });
  });

  it("may block when a service of the zone cannot be read", async () => {
    const zone = PUBLIC_ZONE.replace("services: dhcpv6-client ssh", "services: ssh custom");
    expect((await linuxFirewallProblem(lan, firewalldHost(ok(zone))))?.certain).toBe(false);
  });

  it("says nothing when firewalld is not running or not installed", async () => {
    const stopped = firewalldHost(ok(PUBLIC_ZONE), { "systemctl is-active firewalld": { code: 3, stdout: "inactive\n" } });
    expect(await linuxFirewallProblem(lan, stopped)).toBeNull();
    expect(stopped.ran).not.toContain("firewall-cmd --zone=public --list-all");
    expect(await linuxFirewallProblem(lan, host({ run: { "firewall-cmd --state": { code: 252, stdout: "not running\n" } } }))).toBeNull();
  });

  it("only asks, never changes a rule", async () => {
    const h = firewalldHost(ok(PUBLIC_ZONE));
    await linuxFirewallProblem(lan, h);
    expect(h.ran.every((line) => line.startsWith("systemctl is-active ") || /^firewall-cmd (--get-|--zone=\w+ --list-all$|--state$)/.test(line))).toBe(true);
    expect(h.ran.join("\n")).not.toMatch(/sudo|--add-|--remove-|--set-|--reload/);
  });
});

describe("createLinuxFirewallCheck", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const blocked = { certain: true, command: "sudo ufw allow 8810/tcp" };

  it("never looks on Windows or macOS", () => {
    const probe = vi.fn(async () => blocked);
    for (const platform of ["win32", "darwin"] as const) {
      expect(createLinuxFirewallCheck({ platform, probe })(lan)).toBeNull();
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("answers at once, looks once at a time, and looks again when stale or for another network", async () => {
    let clock = 0;
    let answer: typeof blocked | null = blocked;
    const probe = vi.fn(async () => answer);
    const check = createLinuxFirewallCheck({ platform: "linux", probe, now: () => clock, maxAgeMs: 15_000 });

    expect(check(lan)).toBeNull();
    expect(check(lan)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    await settle();
    expect(check(lan)).toEqual(blocked);

    // The person runs the command; the next stale read finds out.
    answer = null;
    clock = 15_000;
    expect(check(lan)).toEqual(blocked);
    await settle();
    expect(check(lan)).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);

    answer = blocked;
    expect(check({ ...lan, address: "10.0.0.5" })).toBeNull();
    expect(probe).toHaveBeenCalledTimes(3);
    await settle();
    expect(check({ ...lan, address: "10.0.0.5" })).toEqual(blocked);
  });

  it("says nothing when a look fails", async () => {
    const check = createLinuxFirewallCheck({ platform: "linux", probe: async () => { throw new Error("timed out"); } });
    check(lan);
    await settle();
    expect(check(lan)).toBeNull();
  });
});

describe("companionState linuxFirewall", () => {
  const state = (pairing: boolean) => {
    const devices = new DeviceRegistry();
    if (pairing) devices.openPairing();
    const linuxFirewall = vi.fn(() => ({ certain: false, command: "sudo ufw allow 8810/tcp" }));
    const result = companionState({
      devices,
      companionPort: 8810,
      discovery: () => ({ advertising: false, name: "Miguel's computer" }),
      publicNetworks: () => new Set(),
      linuxFirewall,
    });
    return { result, linuxFirewall };
  };

  it("asks about the network the Wi-Fi QR leads with, on the listener's port", () => {
    const { result, linuxFirewall } = state(true);
    expect(result.lan).toBe("192.168.1.34");
    expect(linuxFirewall).toHaveBeenCalledWith({ name: "wlan0", address: "192.168.1.34", port: 8810 });
    expect(result.linuxFirewall).toEqual({ certain: false, command: "sudo ufw allow 8810/tcp" });
  });

  it("does not look while no pairing window is open", () => {
    const { result, linuxFirewall } = state(false);
    expect(result).not.toHaveProperty("linuxFirewall");
    expect(linuxFirewall).not.toHaveBeenCalled();
  });
});
