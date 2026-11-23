import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chooseTailscaleHttpsPorts, classifyTailscaleStderr, clearLeftoverTailscaleServe, explainTailscaleFailure, parseTailscaleStatus, tailnetListenFallback, tailscaleHttpsProblem, tailscaleMarker, tailscalePortsFile, tailscaleServe, type TailscaleStatus } from "./tailscale.ts";

describe("tailscale helpers", () => {
  it("reads the MagicDNS name, addresses and state from status --json", () => {
    const status = parseTailscaleStatus("/usr/bin/tailscale", JSON.stringify({
      BackendState: "Running",
      CertDomains: ["mini.tail1234.ts.net"],
      Self: { DNSName: "mini.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"] },
    }));
    expect(status).toEqual({ cli: "/usr/bin/tailscale", dnsName: "mini.tail1234.ts.net", addresses: ["100.64.0.7", "fd7a:115c:a1e0::7"], backendState: "Running", httpsEnabled: true });
    expect(parseTailscaleStatus("t", JSON.stringify({ BackendState: "Running" }))?.httpsEnabled).toBe(false);
    expect(parseTailscaleStatus("t", JSON.stringify({ BackendState: "Running", Self: { CapMap: { https: null } } }))?.httpsEnabled).toBe(true);
    expect(parseTailscaleStatus("t", "{}")?.dnsName).toBeNull();
    expect(parseTailscaleStatus("t", "not json")).toBeNull();
  });

  it("classifies stderr into a closed set and never needs the raw text again", () => {
    expect(classifyTailscaleStderr("Logged out.\nLog in at: https://login.tailscale.com/a/tskey-auth-secret")).toBe("not-logged-in");
    expect(classifyTailscaleStderr("failed to connect to local tailscaled; is Tailscale running?")).toBe("not-running");
    expect(classifyTailscaleStderr("Access denied: serve config denied; use 'sudo tailscale set --operator=USER'")).toBe("needs-operator");
    expect(classifyTailscaleStderr("error: HTTPS is not enabled for this tailnet")).toBe("https-not-enabled");
    expect(classifyTailscaleStderr("something else entirely")).toBe("unknown");
    for (const reason of ["not-installed", "not-logged-in", "not-running", "no-magicdns", "needs-operator", "https-not-enabled", "unknown"] as const) {
      expect(explainTailscaleFailure(reason).length).toBeGreaterThan(20);
      expect(explainTailscaleFailure(reason)).not.toContain("tskey");
    }
  });
});

describe("serve --tailscale without HTTPS", () => {
  const status: TailscaleStatus = { cli: "/usr/bin/tailscale", dnsName: "nuc.tail1234.ts.net", addresses: ["100.70.0.9", "fd7a:115c:a1e0::9"], backendState: "Running", httpsEnabled: false };
  const interfaces = { eth0: [{ address: "192.168.1.30" }], tailscale0: [{ address: "100.70.0.9" }, { address: "fd7a:115c:a1e0::9" }] };

  it("listens on this machine's own tailnet addresses at http://<name>:<port>, and says how to get https", () => {
    const fallback = tailnetListenFallback("https-not-enabled", status, 8799, interfaces);
    expect(fallback?.origin).toBe("http://nuc.tail1234.ts.net:8799");
    // The name alone: the server follows Tailscale's interface, so a restart of Tailscale needs no restart here.
    expect(fallback?.env).toEqual({ SEIRA_TAILNET_NAME: "nuc.tail1234.ts.net" });
    expect(fallback?.line).toContain("login.tailscale.com/admin/dns");
    expect(tailnetListenFallback("needs-operator", status, 8799, interfaces)?.line).toContain("--operator=$USER");
  });

  it("fails as before where listening would not help: another failure, no name, or no Tailscale interface", () => {
    expect(tailnetListenFallback("not-running", status, 8799, interfaces)).toBeNull();
    expect(tailnetListenFallback("https-not-enabled", { ...status, dnsName: null }, 8799, interfaces)).toBeNull();
    expect(tailnetListenFallback("https-not-enabled", status, 8799, { eth0: interfaces.eth0 })).toBeNull();
  });
});

describe("serve --tailscale", () => {
  const status: TailscaleStatus = { cli: "/usr/bin/tailscale", dnsName: "mini.tail1234.ts.net", addresses: [], backendState: "Running", httpsEnabled: true };
  const fakeServe = (exitCode: number | null, stderr = "") => {
    const calls: string[][] = [];
    const children: Array<EventEmitter & { kill(signal: string): void; killed: string[] }> = [];
    const spawnImpl = ((_cli: string, args: string[]) => {
      calls.push(args);
      const child: EventEmitter & { stderr: EventEmitter; killed: string[]; kill(signal: string): void } = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(), killed: [] as string[], kill(signal: string) { child.killed.push(signal); setImmediate(() => child.emit("exit", null)); },
      });
      children.push(child);
      if (exitCode !== null) setImmediate(() => { child.stderr.emit("data", Buffer.from(stderr)); child.emit("exit", exitCode); });
      return child;
    }) as never;
    return { calls, children, spawnImpl };
  };

  it("serves in the foreground, notes it, and turns it off when serve stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try {
      const fake = fakeServe(null);
      const served = await tailscaleServe(status, 8799, { dataDir: dir, settleMs: 20, spawnImpl: fake.spawnImpl });
      if ("failure" in served) throw new Error(served.failure);
      expect(served.origin).toBe("https://mini.tail1234.ts.net");
      expect(fake.calls).toEqual([["serve", "--https=443", "http://127.0.0.1:8799"]]);
      expect(fake.calls[0]).not.toContain("--bg");
      expect(existsSync(tailscaleMarker(dir))).toBe(true);
      await served.stop();
      expect(fake.children[0]!.killed).toEqual(["SIGTERM"]);
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks first: HTTPS certificates on, and no other Seira server already on this name; a serve that exits says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try {
      const fake = fakeServe(null);
      expect(await tailscaleServe({ ...status, httpsEnabled: false }, 8799, { dataDir: dir, spawnImpl: fake.spawnImpl })).toEqual({ failure: "https-not-enabled" });
      expect(await tailscaleServe(status, 8799, { dataDir: dir, spawnImpl: fake.spawnImpl, otherServer: async () => true })).toEqual({ failure: "other-server" });
      expect(fake.calls).toEqual([]);
      const refused = fakeServe(1, "Access denied: serve config denied");
      expect(await tailscaleServe(status, 8799, { dataDir: dir, settleMs: 500, spawnImpl: refused.spawnImpl })).toEqual({ failure: "needs-operator" });
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
      expect(explainTailscaleFailure("other-server")).toContain("different Seira server");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a missing data folder, private to this user, on a fresh install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try {
      const fresh = join(dir, "fresh");
      const served = await tailscaleServe(status, 8799, { dataDir: fresh, settleMs: 20, spawnImpl: fakeServe(null).spawnImpl });
      if ("failure" in served) throw new Error(served.failure);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      expect(existsSync(tailscaleMarker(fresh))).toBe(true);
      await served.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops tailscale serve again when it cannot note the share", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try {
      writeFileSync(join(dir, "file"), "");
      const fake = fakeServe(null);
      await expect(tailscaleServe(status, 8799, { dataDir: join(dir, "file", "data"), settleMs: 20, spawnImpl: fake.spawnImpl })).rejects.toMatchObject({ code: "ENOTDIR" });
      expect(fake.children[0]!.killed).toEqual(["SIGTERM"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turns off a share a crashed run left behind, and nothing without its note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try {
      expect(await clearLeftoverTailscaleServe(dir)).toBe(false);
      writeFileSync(tailscaleMarker(dir), JSON.stringify({ cli: process.execPath, httpsPort: 443, localPort: 8799 }));
      expect(await clearLeftoverTailscaleServe(dir)).toBe(true);
      expect(existsSync(tailscaleMarker(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the tailnet HTTPS ports", () => {
  const status: TailscaleStatus = { cli: "/usr/bin/tailscale", dnsName: "mini.tail1234.ts.net", addresses: [], backendState: "Running", httpsEnabled: true };
  const inTempDir = async (body: (dir: string) => Promise<void> | void) => {
    const dir = mkdtempSync(join(tmpdir(), "seira-ts-"));
    try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const fakeSpawn = (failPorts: number[] = []) => {
    const calls: string[][] = [];
    const killed: string[][] = [];
    const spawnImpl = ((_cli: string, args: string[]) => {
      calls.push(args);
      const port = Number(args[1]!.replace("--https=", ""));
      const child: EventEmitter & { stderr: EventEmitter; kill(signal: string): void } = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(), kill(signal: string) { killed.push([String(port), signal]); setImmediate(() => child.emit("exit", null)); },
      });
      if (failPorts.includes(port)) setImmediate(() => { child.stderr.emit("data", Buffer.from("Access denied: serve config denied")); child.emit("exit", 1); });
      return child;
    }) as never;
    return { calls, killed, spawnImpl };
  };

  it("is 443 alone when no ports are saved and nothing listens on 443", () => inTempDir((dir) => {
    expect(chooseTailscaleHttpsPorts(dir, [22, 8799])).toEqual({ ports: [443], primaryBusy: false, line: null });
  }));

  it("adds 8443 with one line that says so when another program listens on 443", () => inTempDir((dir) => {
    const choice = chooseTailscaleHttpsPorts(dir, new Set([22, 443]));
    expect(choice).toEqual({ ports: [443, 8443], primaryBusy: true, line: "tailscale: port 443 is in use by another program, so the server also answers on port 8443, for devices set up with that address." });
  }));

  it("uses the saved ports and ignores what listens", () => inTempDir((dir) => {
    writeFileSync(tailscalePortsFile(dir), JSON.stringify({ ports: [8443] }));
    expect(chooseTailscaleHttpsPorts(dir, [22])).toEqual({ ports: [8443], primaryBusy: false, line: null });
    expect(chooseTailscaleHttpsPorts(dir, [443, 8443])).toEqual({ ports: [8443], primaryBusy: true, line: null });
    writeFileSync(tailscalePortsFile(dir), JSON.stringify({ ports: [443, 8443] }));
    expect(chooseTailscaleHttpsPorts(dir, [443]).ports).toEqual([443, 8443]);
  }));

  it("treats an unreadable or invalid saved file as no file", () => inTempDir((dir) => {
    for (const content of ["not json", "{}", '{"ports":[]}', '{"ports":["443"]}', '{"ports":[443,443]}', '{"ports":[0]}', '{"ports":[70000]}', "null"]) {
      writeFileSync(tailscalePortsFile(dir), content);
      expect(chooseTailscaleHttpsPorts(dir, [443]).ports).toEqual([443, 8443]);
    }
  }));

  it("serves every chosen port, prints the first port's address, and saves the ports privately", () => inTempDir(async (dir) => {
    const fake = fakeSpawn();
    const served = await tailscaleServe(status, 8799, { dataDir: dir, httpsPorts: [443, 8443], settleMs: 20, spawnImpl: fake.spawnImpl });
    if ("failure" in served) throw new Error(served.failure);
    expect(served.origin).toBe("https://mini.tail1234.ts.net");
    expect(served.origins).toEqual(["https://mini.tail1234.ts.net", "https://mini.tail1234.ts.net:8443"]);
    expect(fake.calls).toEqual([["serve", "--https=443", "http://127.0.0.1:8799"], ["serve", "--https=8443", "http://127.0.0.1:8799"]]);
    expect(JSON.parse(readFileSync(tailscalePortsFile(dir), "utf8"))).toEqual({ ports: [443, 8443] });
    expect(statSync(tailscalePortsFile(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tailscaleMarker(dir), "utf8"))).toEqual({ cli: "/usr/bin/tailscale", httpsPorts: [443, 8443], localPort: 8799 });
    await served.stop();
    expect(fake.killed.map(([port]) => port).sort()).toEqual(["443", "8443"]);
    expect(existsSync(tailscaleMarker(dir))).toBe(false);
    expect(existsSync(tailscalePortsFile(dir))).toBe(true);
  }));

  it("serves only the saved ports at the next start", () => inTempDir(async (dir) => {
    writeFileSync(tailscalePortsFile(dir), JSON.stringify({ ports: [443] }));
    const fake = fakeSpawn();
    const served = await tailscaleServe(status, 8799, { dataDir: dir, httpsPorts: chooseTailscaleHttpsPorts(dir, [443, 8443]).ports, settleMs: 20, spawnImpl: fake.spawnImpl });
    expect("origin" in served && served.origin).toBe("https://mini.tail1234.ts.net");
    expect(fake.calls).toEqual([["serve", "--https=443", "http://127.0.0.1:8799"]]);
    if ("stop" in served) await served.stop();
  }));

  it("keeps going on the first port when the second fails, says so, and still saves both", () => inTempDir(async (dir) => {
    const fake = fakeSpawn([8443]);
    const lines: string[] = [];
    const served = await tailscaleServe(status, 8799, { dataDir: dir, httpsPorts: [443, 8443], settleMs: 200, spawnImpl: fake.spawnImpl, log: (line) => lines.push(line) });
    if ("failure" in served) throw new Error(served.failure);
    expect(served.origins).toEqual(["https://mini.tail1234.ts.net"]);
    expect(lines).toEqual([expect.stringContaining("port 8443 could not start")]);
    expect(JSON.parse(readFileSync(tailscalePortsFile(dir), "utf8"))).toEqual({ ports: [443, 8443] });
    expect(JSON.parse(readFileSync(tailscaleMarker(dir), "utf8")).httpsPorts).toEqual([443]);
    await served.stop();
  }));

  it("fails, and saves nothing, when the first port fails", () => inTempDir(async (dir) => {
    const fake = fakeSpawn([443]);
    expect(await tailscaleServe(status, 8799, { dataDir: dir, httpsPorts: [443, 8443], settleMs: 200, spawnImpl: fake.spawnImpl })).toEqual({ failure: "needs-operator" });
    expect(fake.calls).toHaveLength(1);
    expect(existsSync(tailscalePortsFile(dir))).toBe(false);
    expect(existsSync(tailscaleMarker(dir))).toBe(false);
  }));

  it("turns off every port in the marker, and still reads a marker with one port", () => inTempDir(async (dir) => {
    writeFileSync(tailscaleMarker(dir), JSON.stringify({ cli: process.execPath, httpsPorts: [443, 8443], localPort: 8799 }));
    expect(await clearLeftoverTailscaleServe(dir)).toBe(true);
    expect(existsSync(tailscaleMarker(dir))).toBe(false);
    writeFileSync(tailscaleMarker(dir), JSON.stringify({ cli: process.execPath, httpsPort: 8443, localPort: 8799 }));
    expect(await clearLeftoverTailscaleServe(dir)).toBe(true);
    expect(existsSync(tailscaleMarker(dir))).toBe(false);
  }));
});

describe("why a tailnet cannot give an HTTPS address", () => {
  const status: TailscaleStatus = { cli: "t", dnsName: "mini.tail1234.ts.net", addresses: [], backendState: "Running", httpsEnabled: false };

  it("names the admin page when certificates are off, and nothing when they are on", async () => {
    expect(await tailscaleHttpsProblem(async () => ({ status }))).toContain("login.tailscale.com/admin/dns");
    expect(await tailscaleHttpsProblem(async () => ({ status: { ...status, httpsEnabled: true } }))).toBeNull();
    expect(await tailscaleHttpsProblem(async () => ({ failure: "not-logged-in" }))).toContain("not signed in");
  });
});
