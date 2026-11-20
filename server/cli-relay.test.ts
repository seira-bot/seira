import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { applyStartupPreferences, parseArgs, runLogin, type CliOptions } from "./cli.ts";
import { RELAY_NOT_WITH_TUNNEL, relayPairingBlock, relayProblemLines, showRelayPairing } from "./cli-pairing.ts";
import { serviceServeArgs } from "./service-cli.ts";
import type { PhoneRelayStatus } from "./phone-relay.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startControlPlaneStub } from "./testing/control-plane-stub.ts";

const status = (over: Partial<PhoneRelayStatus> = {}): PhoneRelayStatus => ({ relay: "connected", node: "relay1.seira.bot", grant: "ok", phones: 1, maxPhones: 20, ...over });
const invite = "seira://pair?address=relay-only.invalid%3A443&token=seira_pair_x&e2e=eyJ2IjoxfQ";

describe("seira serve --relay", () => {
  it("is off unless asked for, joins any way in but --tunnel, and never a local start", () => {
    expect(parseArgs(["serve"], {})).not.toHaveProperty("relay");
    expect(parseArgs(["serve", "--relay"], {})).toMatchObject({ command: "serve", relay: true, tunnel: false });
    expect(parseArgs(["serve", "--relay", "--domain", "seira.example.com"], {})).toMatchObject({ relay: true, domain: "seira.example.com" });
    expect(parseArgs(["serve", "--tailscale", "--relay"], {})).toMatchObject({ relay: true, tailscale: true });
    expect(parseArgs(["service", "install", "--relay"], {})).toMatchObject({ command: "service", relay: true });
    expect(parseArgs(["serve", "--relay", "--tunnel"], {})).toEqual({ error: "choose one of --relay (phones through Seira Relay) and --tunnel (a public address)" });
    expect(parseArgs(["serve", "--tailscale", "--tunnel"], {})).toEqual({ error: "choose one of --tailscale (your tailnet) and --tunnel (a public address)" });
    expect(parseArgs(["--local", "--relay"], {})).toEqual({ error: "--local cannot be combined with a remote-access option" });
  });

  it("prints the relay QR for a phone code, and the usual block for everything else", () => {
    const body = { inviteUrl: invite, expiresAt: Date.now() + 600_000, relay: status() };
    const block = relayPairingBlock(body, true, "seira")!;
    expect(block).toContain("Scan with the Seira app. It connects through Seira Relay, end-to-end encrypted");
    expect(block).toContain("Paired phones: 1 of 20. Remove one: seira devices revoke ID");
    expect(relayPairingBlock(body, false, "seira")).toBeNull();
    expect(relayPairingBlock({ ...body, relay: undefined }, true, "seira")).toBeNull();
    expect(relayPairingBlock({ ...body, inviteUrl: "seira://pair?address=https%3A%2F%2Fseira.example.com&token=seira_pair_x" }, true, "seira")).toBeNull();
  });

  it("says why a phone cannot pair yet, in the person's terms", () => {
    expect(relayProblemLines(null, "seira")).toEqual(["Seira Relay is off on this server. Start it with: seira serve --relay"]);
    expect(relayProblemLines(status({ grant: "signed-out", relay: "off" }), "seira")[0]).toMatch(/^Seira Relay needs this machine signed in to a Seira account: seira login --relay/);
    expect(relayProblemLines(status({ grant: "unavailable", relay: "off" }), "npx @seira-bot/seira")[0]).toMatch(/not available for this machine right now\. The server keeps working here/);
    expect(relayProblemLines(status({ relay: "connecting", node: null }), "seira")[0]).toMatch(/^Can't reach Seira Relay yet\. The server keeps working here/);
    expect(relayProblemLines(status(), "seira")).toEqual([]);
    expect(relayProblemLines(status({ grant: "tunnel", relay: "off", reason: "this server runs with --tunnel" }), "seira")).toEqual([
      "Seira Relay stays off here: this server runs with --tunnel. A relay token would make that tunnel go for good; use the relay on a machine signed in with seira login --relay.",
    ]);
  });

  it("waits for the relay before making a code, and makes none it can't use", async () => {
    const reads = [status({ grant: "waiting", relay: "off" }), status({ relay: "connecting" }), status()];
    const lines: string[] = [];
    let minted = 0;
    const mint = async () => `code ${++minted}`;
    expect(await showRelayPairing({ tty: true, status: async () => reads.shift() ?? status(), mint, log: (line) => lines.push(line), prefix: "seira", waitMs: 5_000 })).toBe(true);
    expect(lines).toEqual(["code 1"]);

    lines.length = 0;
    expect(await showRelayPairing({ tty: true, status: async () => status({ grant: "signed-out", relay: "off" }), mint, log: (line) => lines.push(line), prefix: "seira", waitMs: 0 })).toBe(false);
    expect(minted).toBe(1);
    expect(lines[1]).toBe("Then: seira pair --phone");
  });

  it("signs a machine in for the relay without reserving one of the scarce tunnel addresses", async () => {
    const stub = await startControlPlaneStub();
    const dataDir = mkdtempSync(join(tmpdir(), "seira-login-relay-"));
    vi.stubEnv("SEIRA_CONTROL_PLANE_URL", stub.url);
    try {
      const lines: string[] = [];
      const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(`error: ${line}`), ask: async () => stub.otp };
      const options = parseArgs(["login", "--relay", "--email", "vps@example.test", "--data-dir", dataDir], {});
      if ("error" in options) throw new Error(options.error);
      expect(await runLogin(options, io)).toBe(0);
      expect(lines).toEqual(["Signed in as vps@example.test.", "No public address reserved: phones reach this machine through Seira Relay.", expect.stringMatching(/^Serve there with: {2}.*serve --relay$/)]);
      expect(stub.calls).toContain("POST /v1/installations");
      expect([...stub.installations.values()].map((installation) => installation.kind)).toEqual(["server"]);
      expect(stub.calls.filter((call) => call.includes("/endpoint"))).toEqual([]);
      const file = join(dataDir, "tunnel-account.json");
      expect(JSON.parse(readFileSync(file, "utf8")).companionInstallationCredential).toMatch(/^seira_install_/);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
      await stub.close();
      await removeTempDir(dataDir);
    }
  });

  it("never prints the one-time credential into a service's log", async () => {
    const lines: string[] = [];
    let minted = 0;
    expect(await showRelayPairing({ tty: false, status: async () => status(), mint: async () => `code ${++minted}`, log: (line) => lines.push(line), prefix: "seira" })).toBe(false);
    expect(minted).toBe(0);
    expect(lines).toEqual(["Pair a phone: seira pair --phone"]);
  });

  it("keeps a saved tunnel choice and the relay apart, and passes --relay to a service", () => {
    const start = (argv: string[]) => {
      const parsed = parseArgs(argv, {});
      if ("error" in parsed) throw new Error(parsed.error);
      return parsed as CliOptions;
    };
    expect(() => applyStartupPreferences(start(["start", "--relay"]), { access: "tunnel" })).toThrow(RELAY_NOT_WITH_TUNNEL);
    expect(applyStartupPreferences(start(["start", "--relay"]), { access: "local" })).toMatchObject({ relay: true, tunnel: false });
    expect(applyStartupPreferences(start(["start", "--relay"]), undefined)).toMatchObject({ relay: true });
    expect(applyStartupPreferences(start(["start"]), { access: "tunnel" })).toMatchObject({ tunnel: true });
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", relay: true })).toEqual(["--port", "8799", "--data-dir", "/d", "--relay"]);
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", domain: "seira.example.com", relay: true })).toEqual(["--port", "8799", "--data-dir", "/d", "--domain", "seira.example.com", "--relay"]);
    expect(serviceServeArgs({ port: 8799, dataDir: "/d" })).toEqual(["--port", "8799", "--data-dir", "/d"]);
  });
});
