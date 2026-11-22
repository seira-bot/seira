import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { EngineLimit } from "../../shared/limit-reset";
import { byHealth, providerHealth } from "./provider-health";
import { t } from "./i18n";

const instance = (instanceId: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind: "codex", displayName: instanceId, access: "subscription",
  snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [{ id: "m", label: "M" }] },
  ...extra,
});
const limit = (engine: string, used: number, blocked = false): EngineLimit => ({
  engine, name: engine, driver: "claude", window: "5-hour", usedPercent: used, resetsAt: null, blocked, windows: [],
});

describe("providerHealth", () => {
  it("passes a signed-in provider", () => {
    expect(providerHealth(instance("a"))).toEqual({ usable: true });
  });

  it("fails a provider that needs setup, with the words the menus use", () => {
    expect(providerHealth(instance("a", { snapshot: { state: "unavailable", reason: "missing" } }))).toEqual({ usable: false, reason: t("model.setupRequired") });
  });

  it("fails a provider that needs a sign-in, but not a local server", () => {
    const signedOut = { state: "available" as const, authenticated: false };
    expect(providerHealth(instance("a", { snapshot: signedOut }))).toEqual({ usable: false, reason: t("model.signInRequired") });
    expect(providerHealth(instance("a", { snapshot: signedOut, access: "custom" })).usable).toBe(true);
  });

  it("fails a provider that its organization blocks", () => {
    const blocked = instance("a", { policy: { organizationName: "Acme", reason: "no" } as InstanceInfo["policy"] });
    expect(providerHealth(blocked)).toEqual({ usable: false, reason: t("policy.managedBy", { organization: "Acme" }) });
  });

  it("fails a provider at its usage limit, and keeps one that only used a lot", () => {
    expect(providerHealth(instance("a"), limit("a", 100))).toEqual({ usable: false, reason: t("limits.atLimit", { engine: "a" }) });
    expect(providerHealth(instance("a"), limit("a", 10, true)).usable).toBe(false);
    expect(providerHealth(instance("a"), limit("a", 96)).usable).toBe(true);
  });

  it("keeps a provider whose CLI only has an update waiting", () => {
    expect(providerHealth(instance("a", { snapshot: { state: "available", authenticated: true, update: { title: "Update", message: "A newer version is out." } } })).usable).toBe(true);
  });
});

describe("byHealth", () => {
  it("puts usable providers first and keeps each group's order", () => {
    const all = ["a", "b", "c", "d"];
    const health = (id: string) => ({ usable: id === "b" || id === "d" });
    expect(byHealth(all, health)).toEqual(["b", "d", "a", "c"]);
  });
});
