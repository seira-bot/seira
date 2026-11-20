import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANION_CONTROL_PLANE_URL, resolveCompanionControlPlaneURL, resolveServerControlPlaneURL } from "./companion-account-service.mjs";
import { LIVE_SEIRA_SERVICES, SEIRA_HOSTS, seiraOrigin, seiraServiceLive } from "./seira-hosts.mjs";

describe("seiraServiceLive", () => {
  it("lists the services that answer today", () => {
    expect([...LIVE_SEIRA_SERVICES].sort()).toEqual(["apps", "cloud", "serverTunnel", "site", "updates"]);
    for (const name of LIVE_SEIRA_SERVICES) expect(seiraServiceLive(name)).toBe(true);
  });

  it("keeps a service that has no live host off", () => {
    for (const name of ["admin", "accounts", "device", "stats", "pages", "companion", "push"]) expect(seiraServiceLive(name, {})).toBe(false);
  });

  it("turns a service on when the environment names an address for it", () => {
    expect(seiraServiceLive("accounts", { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" })).toBe(true);
    expect(seiraServiceLive("accounts", { SEIRA_CONTROL_PLANE_URL: "  " })).toBe(false);
    expect(seiraServiceLive("push", { SEIRA_PUSH_RELAY_URL: "https://push.example.test" })).toBe(true);
    expect(seiraServiceLive("admin", { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" })).toBe(false);
  });
});

describe("SEIRA_HOSTS", () => {
  it("builds origins and accepts only numbered relay hosts", () => {
    expect(seiraOrigin(SEIRA_HOSTS.cloud)).toBe("https://cloud.seira.bot");
    expect(SEIRA_HOSTS.relayPattern.test("relay1.seira.bot")).toBe(true);
    expect(SEIRA_HOSTS.relayPattern.test("relay0.seira.bot")).toBe(false);
    expect(SEIRA_HOSTS.relayPattern.test("relay1.seira.bot.example.net")).toBe(false);
  });

  it("leaves the phone account service off in a build without a live account host", () => {
    expect(DEFAULT_COMPANION_CONTROL_PLANE_URL).toBe("");
  });
});

describe("the server tunnel service", () => {
  const live = [...LIVE_SEIRA_SERVICES, "serverTunnel"];

  it("is in the live list and has its own zone", () => {
    expect(LIVE_SEIRA_SERVICES).toContain("serverTunnel");
    expect(seiraServiceLive("serverTunnel", {})).toBe(true);
    expect(SEIRA_HOSTS.tunnel).toBe("seira.run");
  });

  it("uses Seira's control plane when live and no address is set", () => {
    expect(resolveServerControlPlaneURL({ environment: {}, live })).toBe("https://accounts.seira.bot");
  });

  it("lets SEIRA_CONTROL_PLANE_URL win, and an invalid value turns it off", () => {
    expect(resolveServerControlPlaneURL({ environment: { SEIRA_CONTROL_PLANE_URL: "https://cp.example.test/" }, live })).toBe("https://cp.example.test");
    expect(resolveServerControlPlaneURL({ environment: { SEIRA_CONTROL_PLANE_URL: "ftp://nope" }, live })).toBe("");
  });

  it("gives no control plane when it is not live and nothing is set", () => {
    expect(resolveServerControlPlaneURL({ environment: {}, live: ["site"] })).toBe("");
    expect(resolveServerControlPlaneURL({ environment: { SEIRA_CONTROL_PLANE_URL: "https://cp.example.test" } })).toBe("https://cp.example.test");
  });

  it("keeps the packaged desktop phone account off while only this service is live", () => {
    expect(seiraServiceLive("accounts", {}, live)).toBe(false);
    expect(DEFAULT_COMPANION_CONTROL_PLANE_URL).toBe("");
    expect(resolveCompanionControlPlaneURL({ isPackaged: true, environment: {} })).toBe("");
  });
});
