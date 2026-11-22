import { describe, expect, it } from "vitest";

import { checkReach, envPublicUrl, lanProblem, localLinkBase, noRouteLines, publicUrlProblem, reachLines, waitForReach } from "./cli-reach.ts";

const descriptor = (environmentId: string) => Response.json({ environmentId });

describe("ways in", () => {
  it("--public-url: https anywhere, http only on a private network", () => {
    expect(publicUrlProblem("https://seira.example.com")).toBeNull();
    expect(publicUrlProblem("http://192.168.1.20:8799")).toBeNull();
    expect(publicUrlProblem("http://box.tail1234.ts.net")).toBeNull();
    expect(publicUrlProblem("http://seira.example.com")).toContain("plain http isn't encrypted");
    expect(publicUrlProblem("seira.example.com")).toContain("must start with https://");
  });

  it("SEIRA_PUBLIC_URL counts as the address unless it is plain http on the open internet", () => {
    const said: string[] = [];
    expect(envPublicUrl({ SEIRA_PUBLIC_URL: "https://seira.example.com/" }, (line) => said.push(line))).toBe("https://seira.example.com");
    expect(envPublicUrl({ SEIRA_PUBLIC_URL: "http://seira.example.com" }, (line) => said.push(line))).toBeUndefined();
    expect(envPublicUrl({}, (line) => said.push(line))).toBeUndefined();
    expect(said).toEqual([expect.stringContaining("SEIRA_PUBLIC_URL is ignored")]);
  });

  it("offers --tunnel as a way in only while an account service is set", () => {
    const without = noRouteLines(8799, "seira", { SEIRA_CONTROL_PLANE_URL: "" }).join("\n");
    expect(without).not.toContain("--tunnel");
    expect(without).not.toContain("seira login");
    for (const way of ["--public-url", "--domain", "--tailscale", "--lan"]) expect(without).toContain(way);
    expect(noRouteLines(8799, "seira", { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" }).join("\n")).toContain("serve --tunnel");
    expect(noRouteLines(8799, "seira", {}).join("\n")).toContain("serve --tunnel");
  });

  it("--lan on a machine with only public addresses says so", () => {
    expect(lanProblem({ lan: ["192.168.1.20"], tailscale: [] })).toBeNull();
    expect(lanProblem({ lan: [], tailscale: [] })).toContain("no private network address");
  });

  it("a browser on the Docker host opens the published port; elsewhere this server's own", () => {
    expect(localLinkBase("http://localhost:8080", 8799, { SEIRA_CLI_PREFIX: "docker compose exec seira seira" })).toEqual({ base: "http://localhost:8080", place: "docker" });
    expect(localLinkBase(null, 8799, {})).toEqual({ base: "http://127.0.0.1:8799", place: "machine" });
    expect(localLinkBase("https://seira.example.com", 8799, {})).toEqual({ base: "http://127.0.0.1:8799", place: "machine" });
  });
});

describe("the Reach line", () => {
  const fetching = (remote: () => Response) => (async (url: string | URL | Request) => (String(url).startsWith("http://127.0.0.1") ? descriptor("mine") : remote())) as typeof fetch;

  it("checks the address answers as this very server, with nothing secret sent", async () => {
    expect(await checkReach(8799, "https://seira.example.com", fetching(() => descriptor("mine")), () => 1)).toEqual({ ok: true, at: 1 });
    expect(await checkReach(8799, "https://seira.example.com", fetching(() => descriptor("someone-else")))).toEqual({ ok: false, kind: "other-server" });
    const refused = fetching(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    expect(await checkReach(8799, "https://seira.example.com", refused)).toEqual({ ok: false, kind: "unreachable", reason: "connection refused" });
  });

  it("says what to fix when it doesn't, as a command that pastes", () => {
    expect(reachLines("public-url", "https://seira.example.com", 8799, "npx @seira-bot/seira", { ok: false, kind: "unreachable", reason: "connection refused" })).toEqual([
      "Reach    ✗ https://seira.example.com doesn't reach this server (connection refused).",
      "           Point your tunnel or proxy at http://127.0.0.1:8799 (on another machine: add --lan and use this machine's address), then run: npx @seira-bot/seira status",
    ]);
    expect(reachLines("public-url", "https://seira.example.com", 8799, "seira", { ok: false, kind: "other-server" })[0]).toContain("answers as a different server");
    expect(reachLines("lan", "http://192.168.1.20:8799", 8799, "seira")).toEqual(["Reach    http://192.168.1.20:8799   this network only, not encrypted"]);
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", { ok: true, at: Date.parse("2026-11-07T11:04:00") })[0]).toMatch(/✓ answers as this server \(.+\) · your tailnet · checked from this server; other devices need MagicDNS on$/);
  });

  it("tells a certificate error from a closed port, and names the command that finds the other program", async () => {
    const wrong = fetching(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }); });
    const result = await checkReach(8799, "https://mini.tail1234.ts.net", wrong);
    expect(result).toEqual({ ok: false, kind: "certificate" });
    const lines = reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", result).join("\n");
    expect(lines).toContain("another program answers on this address with its own certificate".replace("another", "Another"));
    expect(lines).toContain("ss -ltnp 'sport = :443'");
    expect(lines).not.toContain("ERR_TLS");
    for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"]) {
      const failing = fetching(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code } }); });
      expect((await checkReach(8799, "https://x.example", failing)).ok === false && (await checkReach(8799, "https://x.example", failing))).toMatchObject({ kind: "certificate" });
    }
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net:8443", 8799, "seira", result).join("\n")).toContain("sport = :8443");
  });

  it("says a tailnet name was checked from this server, and what other devices need", () => {
    const line = reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", { ok: true, at: 1 })[0];
    expect(line).toContain("checked from this server; other devices need MagicDNS on");
    expect(reachLines("public-url", "https://seira.example.com", 8799, "seira", { ok: true, at: 1 })[0]).not.toContain("MagicDNS");
  });

  it("prints the tailnet address while the server listens on the tailnet itself, and not behind tailscale serve", () => {
    const listening = reachLines("tailscale", "http://mini.tail1234.ts.net:8799", 8799, "seira", { ok: true, at: 1 }, ["fd7a:115c:a1e0::7", "100.64.0.1"]);
    expect(listening[1]).toContain("http://100.64.0.1:8799");
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", { ok: true, at: 1 }, ["100.64.0.1"])).toHaveLength(1);
  });

  it("gives a Tailscale fix for a Tailscale route and a tunnel fix for the rest", () => {
    const miss = { ok: false, kind: "unreachable", reason: "connection refused" } as const;
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", miss).join("\n")).not.toContain("tunnel or proxy");
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", miss).join("\n")).toContain("Tailscale is connected");
    expect(reachLines("public-url", "https://seira.example.com", 8799, "seira", miss).join("\n")).toContain("tunnel or proxy");
    expect(reachLines("tailscale", "https://mini.tail1234.ts.net", 8799, "seira", { ok: false, kind: "other-server" }).join("\n")).not.toContain("tunnel or proxy");
  });

  it("waits a while for a tunnel or certificate, then gives up on its budget", async () => {
    let clock = 0, calls = 0;
    const result = await waitForReach(8799, "https://seira.example.com", 3_000, async () => { calls += 1; return { ok: false, kind: "unreachable" }; }, async (ms) => { clock += ms; }, () => clock);
    expect([result.ok, calls]).toEqual([false, 3]);
    calls = 0;
    expect(await waitForReach(8799, "x", 3_000, async () => (++calls === 2 ? { ok: true, at: 1 } : { ok: false, kind: "unreachable" }), async () => {}, () => 0)).toEqual({ ok: true, at: 1 });
  });
});
