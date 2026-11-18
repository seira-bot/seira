import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/seira-cloud", () => ({ SEIRA_CLOUD_PLANS: ["pro", "team"] }));

describe("Cloud doors open when Seira's Cloud sells a plan", () => {
  it("opens the offer and the setup chip", async () => {
    const { cloudSells, cloudOfferAllowed } = await import("./cloud-sale");
    const { setupSteps } = await import("./default-bot");
    const { reducer, initialState } = await import("@/state/store");
    expect(cloudSells()).toBe(true);
    expect(cloudOfferAllowed({ kind: "signed-out" })).toBe(true);
    expect(setupSteps({ aiReady: true, ownBots: 0, onCloud: false, team: false, remote: false })).toContain("cloud");
    expect(reducer(initialState, { type: "openCloudAdd", source: "app_menu" }).cloudAdd).toEqual({ source: "app_menu" });
  });
});
