import { describe, expect, it } from "vitest";

import type { HostSummary } from "./cookie-db.ts";
import { groupSites, sensitivityOf, validHost } from "./sites.ts";

const host = (hostKey: string, extra: Partial<HostSummary> = {}): HostSummary => ({ hostKey, cookieCount: 1, hasAuthShaped: true, lastAccess: 1_000, ...extra });

describe("grouping hosts into sites", () => {
  it("joins hosts under the widest domain-wide cookie and drops a leading www", () => {
    const sites = groupSites([host(".example.com"), host("auth.example.com"), host("www.solo.test"), host(".a.b.deep.test"), host(".deep.test")]);
    expect(sites.map((site) => [site.site, site.cookies, [...site.hostKeys].sort()]).sort()).toEqual([
      ["deep.test", 2, [".a.b.deep.test", ".deep.test"]],
      ["example.com", 2, [".example.com", "auth.example.com"]],
      ["solo.test", 1, ["www.solo.test"]],
    ]);
  });

  it("leaves out IP addresses, localhost and .local, .localhost, .internal hosts, and odd characters", () => {
    const sites = groupSites(["127.0.0.1", "10.1.2.3", "localhost", ".localhost", "nas.local", "app.localhost", "svc.internal", "[::1]", "bad_host.test", "", "ok.test"].map((key) => host(key)));
    expect(sites.map((site) => site.site)).toEqual(["ok.test"]);
    expect(validHost("localhost")).toBe(false);
  });

  it("labels identity, email and financial sites and never suggests them", () => {
    const sites = groupSites(["okta.com", ".gmail.com", "paypal.com", "myshop.test"].map((key) => host(key)));
    const label = Object.fromEntries(sites.map((site) => [site.site, [site.sensitive, site.suggested]]));
    expect(label).toEqual({
      "okta.com": ["identity", false], "gmail.com": ["email", false], "paypal.com": ["financial", false], "myshop.test": [null, true],
    });
    expect(sensitivityOf("icloud.com")).toBe("identity");
    expect(sensitivityOf("klikbca.com")).toBe(null);
    expect(sensitivityOf("bankofexample.test")).toBe("financial");
    expect(sensitivityOf("notpaypalish.test")).toBe(null);
  });

  it("suggests at most 5 sites with an auth-shaped cookie, newest access first", () => {
    const hosts = Array.from({ length: 7 }, (_, index) => host(`site${index}.test`, { lastAccess: 100 + index }));
    hosts.push(host("plain.test", { hasAuthShaped: false, lastAccess: 9_999 }));
    const sites = groupSites(hosts);
    expect(sites.filter((site) => site.suggested).map((site) => site.site)).toEqual(["site6.test", "site5.test", "site4.test", "site3.test", "site2.test"]);
    expect(sites.find((site) => site.site === "plain.test")!.suggested).toBe(false);
    expect(sites.slice(0, 5).every((site) => site.suggested)).toBe(true);
  });
});
