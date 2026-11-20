import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANION_CONTROL_PLANE_URL } from "./companion-account-service.mjs";
import { LIVE_SEIRA_SERVICES, SEIRA_HOSTS, seiraOrigin, seiraServiceLive } from "./seira-hosts.mjs";

describe("seiraServiceLive", () => {
  it("lists the services that answer today", () => {
    expect([...LIVE_SEIRA_SERVICES].sort()).toEqual(["apps", "cloud", "site", "updates"]);
    for (const name of LIVE_SEIRA_SERVICES) expect(seiraServiceLive(name)).toBe(true);
  });

  it("keeps a service that has no live host off", () => {
    for (const name of ["admin", "accounts", "device", "stats", "pages", "companion"]) expect(seiraServiceLive(name, {})).toBe(false);
  });

  it("turns a service on when the environment names an address for it", () => {
    expect(seiraServiceLive("accounts", { SEIRA_CONTROL_PLANE_URL: "https://accounts.example.test" })).toBe(true);
    expect(seiraServiceLive("accounts", { SEIRA_CONTROL_PLANE_URL: "  " })).toBe(false);
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
