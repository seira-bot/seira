// ufw (Ubuntu, Mint, Arch) and firewalld (Fedora, openSUSE) drop a phone's
// connection when their default for incoming traffic is drop or reject and no
// rule allows the companion port. Read as a normal user: config files, the
// unit state, and firewall-cmd queries. Nothing here needs root or changes a
// rule; the pairing panel shows the command the person runs.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { backgroundAnswer } from "./background-answer.ts";

/** Wire shape in `companionState`, mirrored in `src/lib/companion-types.ts`. */
export interface LinuxFirewall {
  /** True when the rules were read and none lets the phone in; false when
   * the firewall is on but its rules could not be read. */
  certain: boolean;
  /** One shell line that lets the phone in, for the person to run. */
  command: string;
}

/** The network the pairing QR leads with, and the port phones dial on it. */
export interface PhoneLan {
  name: string;
  address: string;
  port: number;
}

/** File text, or why there is none. */
export type FileRead = string | { missing: boolean };

/** Exit code and output, or null when the program is not installed or did
 * not finish in time. */
export type RunResult = { code: number; stdout: string } | null;

export interface FirewallHost {
  read: (path: string) => Promise<FileRead>;
  run: (file: string, args: string[]) => Promise<RunResult>;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

const UFW_CONF = "/etc/ufw/ufw.conf";
const UFW_DEFAULTS = "/etc/default/ufw";
const UFW_RULES = "/etc/ufw/user.rules";
const FIREWALLD_SERVICE_DIRS = ["/etc/firewalld/services", "/usr/lib/firewalld/services"];

const toInt = (address: string): number | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
};

const fromInt = (value: number): string =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");

const maskOf = (bits: number): number => (bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits));

/** "any", "0.0.0.0/0", a CIDR or one IPv4 address; an IPv6 or unreadable
 * value contains nothing. */
export function ipv4Contains(range: string, address: string): boolean {
  if (range === "any") return true;
  const [base, bitsText = "32"] = range.split("/");
  const bits = Number(bitsText);
  const start = toInt(base);
  const target = toInt(address);
  if (start === null || target === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = maskOf(bits);
  return (start & mask) >>> 0 === (target & mask) >>> 0;
}

/** e.g. "192.168.1.0/24" for 192.168.1.34 with mask 255.255.255.0. */
export function subnetOf(address: string, netmask: string | null | undefined): string | null {
  const value = toInt(address);
  const mask = netmask ? toInt(netmask) : null;
  if (value === null || mask === null) return null;
  const bits = mask.toString(2).replace(/0+$/, "").length;
  if (maskOf(bits) !== mask || bits === 0 || bits === 32) return null;
  return `${fromInt((value & mask) >>> 0)}/${bits}`;
}

/** "any", "8810", "8000:9000" (ufw) or "8000-9000" (firewalld), or a comma list of those. */
export function portListContains(list: string, port: number): boolean {
  if (list === "any") return true;
  return list.split(",").some((item) => {
    const [low, high = low] = item.split(/[:-]/).map(Number);
    return Number.isInteger(low) && Number.isInteger(high) && low <= port && port <= high;
  });
}

const settings = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*"?([^"#\s]*)"?/.exec(line);
    if (match) out.set(match[1], match[2]);
  }
  return out;
};

const closedByDefault = (policy: string | undefined): boolean => policy !== "ACCEPT";

/** The phone's own address is unknown, but it is on the lead network: a range
 * that holds this computer's address holds the phone too. */
const sourceHoldsPhone = (range: string, lan: PhoneLan): boolean =>
  range.includes("/") && ipv4Contains(range, lan.address);

/** `### tuple ### <action> <proto> <dport> <dst> <sport> <src> [<dapp> <sapp>] <direction>[_<interface>]`,
 * the line ufw writes above each rule in user.rules. Only allow and limit
 * rules count; rule order is not followed, so an earlier deny is missed. */
export function ufwAllows(rules: string, lan: PhoneLan): boolean {
  for (const line of rules.split(/\r?\n/)) {
    if (!line.startsWith("### tuple ### ")) continue;
    const fields = line.slice("### tuple ### ".length).split(" ").filter((field) => !field.startsWith("comment="));
    if (fields.length !== 7 && fields.length !== 9) continue;
    const [action, proto, dport, dst, sport, src] = fields;
    const [direction, ...iface] = fields[fields.length - 1].split("_");
    if (!/^(allow|limit)(_log|_log-all)?$/.test(action)) continue;
    if (direction !== "in" || (iface.length > 0 && iface.join("_") !== lan.name)) continue;
    if (proto !== "tcp" && proto !== "any") continue;
    if (sport !== "any" || !portListContains(dport, lan.port)) continue;
    if (!ipv4Contains(dst, lan.address) || !sourceHoldsPhone(src, lan)) continue;
    return true;
  }
  return false;
}

const ufwCommand = (lan: PhoneLan, subnet: string | null): string =>
  subnet
    ? `sudo ufw allow from ${subnet} to any port ${lan.port} proto tcp`
    : `sudo ufw allow ${lan.port}/tcp`;

async function ufwProblem(host: FirewallHost, lan: PhoneLan, subnet: string | null): Promise<LinuxFirewall | null> {
  const conf = await host.read(UFW_CONF);
  if (typeof conf !== "string" || settings(conf).get("ENABLED") !== "yes") return null;
  // `ufw enable` writes ENABLED=yes; on Arch the rules load at boot only while the unit is enabled.
  const unit = await host.run("systemctl", ["is-active", "ufw"]);
  if (unit && unit.stdout.trim() !== "active") return null;
  const defaults = await host.read(UFW_DEFAULTS);
  const policy = typeof defaults === "string" ? settings(defaults).get("DEFAULT_INPUT_POLICY") : undefined;
  if (!closedByDefault(policy)) return null;
  const rules = await host.read(UFW_RULES);
  const command = ufwCommand(lan, subnet);
  if (typeof rules !== "string") return { certain: false, command };
  return ufwAllows(rules, lan) ? null : { certain: typeof defaults === "string", command };
}

/** The "key: value" lines of `firewall-cmd --list-all`, and its rich rules. */
export function firewalldZone(listAll: string): { fields: Map<string, string>; richRules: string[] } {
  const fields = new Map<string, string>();
  const richRules: string[] = [];
  for (const raw of listAll.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("rule ")) {
      richRules.push(line);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return { fields, richRules };
}

const words = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter(Boolean);

const portsAllow = (ports: string[], port: number): boolean =>
  ports.some((entry) => {
    const [range, protocol] = entry.split("/");
    return protocol === "tcp" && portListContains(range, port);
  });

/** `<port protocol="tcp" port="8810"/>` entries of a firewalld service file, as "8810/tcp". */
export function servicePorts(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<port\b[^>]*>/g)) {
    const port = /\bport="([^"]+)"/.exec(match[0])?.[1];
    const protocol = /\bprotocol="([^"]+)"/.exec(match[0])?.[1];
    if (port && protocol) out.push(`${port}/${protocol}`);
  }
  return out;
}

type Verdict = "allows" | "no" | "unknown";

async function serviceVerdict(host: FirewallHost, service: string, port: number): Promise<Verdict> {
  if (!/^[\w.+-]+$/.test(service)) return "unknown";
  for (const dir of FIREWALLD_SERVICE_DIRS) {
    const xml = await host.read(`${dir}/${service}.xml`);
    if (typeof xml === "string") return portsAllow(servicePorts(xml), port) ? "allows" : "no";
    if (!xml.missing) return "unknown";
  }
  return "unknown";
}

/** Only plain accept rules count: an inverted, ipset, MAC or IPv6 match, or
 * an element other than port, service or protocol, reads as no. */
async function richRuleVerdict(host: FirewallHost, rule: string, lan: PhoneLan): Promise<Verdict> {
  if (!/ accept\b/.test(rule) || /\bNOT\b|family="ipv6"/.test(rule)) return "no";
  if (/\b(forward-port|source-port|icmp-block|icmp-type|masquerade|tcp-mss-clamp)\b/.test(rule)) return "no";
  const source = /\bsource (\w+)="([^"]*)"/.exec(rule);
  if (source && (source[1] !== "address" || !sourceHoldsPhone(source[2], lan))) return "no";
  const destination = /\bdestination (\w+)="([^"]*)"/.exec(rule);
  if (destination && (destination[1] !== "address" || !ipv4Contains(destination[2], lan.address))) return "no";
  const port = /\bport port="([^"]+)" protocol="([^"]+)"/.exec(rule);
  if (port) return port[2] === "tcp" && portListContains(port[1], lan.port) ? "allows" : "no";
  const service = /\bservice name="([^"]+)"/.exec(rule);
  if (service) return serviceVerdict(host, service[1], lan.port);
  const protocol = /\bprotocol value="([^"]+)"/.exec(rule);
  if (protocol) return protocol[1] === "tcp" ? "allows" : "no";
  return "allows";
}

/** Whether a zone's settings let the phone in; "unknown" when a service it
 * names could not be read. */
export async function firewalldZoneVerdict(host: FirewallHost, listAll: string, lan: PhoneLan): Promise<Verdict> {
  const { fields, richRules } = firewalldZone(listAll);
  if (fields.get("target") === "ACCEPT") return "allows";
  if (portsAllow(words(fields.get("ports")), lan.port)) return "allows";
  if (words(fields.get("protocols")).includes("tcp")) return "allows";
  let unknown = false;
  for (const verdict of [
    ...await Promise.all(words(fields.get("services")).map((service) => serviceVerdict(host, service, lan.port))),
    ...await Promise.all(richRules.map((rule) => richRuleVerdict(host, rule, lan))),
  ]) {
    if (verdict === "allows") return "allows";
    if (verdict === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "no";
}

const firewalldCommand = (port: number, zone: string | null): string => {
  const scope = zone ? ` --zone=${zone}` : "";
  return `sudo firewall-cmd${scope} --add-port=${port}/tcp && sudo firewall-cmd --permanent${scope} --add-port=${port}/tcp`;
};

const ZONE_NAME = /^[\w.+-]+$/;

async function firewalldProblem(host: FirewallHost, lan: PhoneLan): Promise<LinuxFirewall | null> {
  const unit = await host.run("systemctl", ["is-active", "firewalld"]);
  const running = unit ? unit.stdout.trim() === "active" : (await host.run("firewall-cmd", ["--state"]))?.code === 0;
  if (!running) return null;
  const ofInterface = await host.run("firewall-cmd", [`--get-zone-of-interface=${lan.name}`]);
  const zoneAnswer = ofInterface?.code === 0 ? ofInterface : await host.run("firewall-cmd", ["--get-default-zone"]);
  const zoneText = zoneAnswer?.code === 0 ? zoneAnswer.stdout.trim() : "";
  const zone = ZONE_NAME.test(zoneText) ? zoneText : null;
  const uncertain = { certain: false, command: firewalldCommand(lan.port, zone) };
  if (!zone) return uncertain;
  const listAll = await host.run("firewall-cmd", [`--zone=${zone}`, "--list-all"]);
  if (listAll?.code !== 0) return uncertain;
  const verdict = await firewalldZoneVerdict(host, listAll.stdout, lan);
  if (verdict === "allows") return null;
  return { certain: verdict === "no", command: uncertain.command };
}

export async function linuxFirewallProblem(lan: PhoneLan, host: FirewallHost = systemHost): Promise<LinuxFirewall | null> {
  const entry = host.interfaces()[lan.name]?.find((info) => info.address === lan.address);
  const subnet = subnetOf(lan.address, entry?.netmask);
  return (await ufwProblem(host, lan, subnet)) ?? (await firewalldProblem(host, lan));
}

const readText = async (path: string): Promise<FileRead> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return { missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
};

const runQuiet = (file: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      // firewall-cmd prints translated words otherwise.
      { timeout: 5_000, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => {
        if (!error) return resolve({ code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === "number" ? { code, stdout } : null);
      },
    );
  });

const systemHost: FirewallHost = { read: readText, run: runQuiet, interfaces: networkInterfaces };

/** How old an answer may be before the next read looks again. Someone who
 * runs the command sees the note go within this long. */
const MAX_AGE_MS = 15_000;

/** Never waits (see `backgroundAnswer`). Off Linux it always answers null. */
export function createLinuxFirewallCheck({
  platform = process.platform,
  probe = linuxFirewallProblem,
  now = Date.now,
  maxAgeMs = MAX_AGE_MS,
}: {
  platform?: NodeJS.Platform;
  probe?: (lan: PhoneLan) => Promise<LinuxFirewall | null>;
  now?: () => number;
  maxAgeMs?: number;
} = {}): (lan: PhoneLan) => LinuxFirewall | null {
  if (platform !== "linux") return () => null;
  return backgroundAnswer<PhoneLan, LinuxFirewall | null>(probe, null, { now, maxAgeMs });
}

export const linuxFirewall = createLinuxFirewallCheck();
