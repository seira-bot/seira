import { describe, expect, it } from "vitest";
import { SEIRA_CLOUD_SALE_TIERS, seiraCloudSells } from "../../electron/seira-cloud-sale.mjs";
import { SEIRA_CLOUD_PLANS } from "./seira-cloud";
import { cloudOfferAllowed, cloudSells } from "./cloud-sale";
import { setupSteps, introChips } from "./default-bot";
import { reducer, initialState } from "@/state/store";

const fresh = { aiReady: false, ownBots: 0, onCloud: false, team: false, remote: false };

describe("Cloud doors stay hidden while Seira's Cloud sells nothing", () => {
  it("the window switch and the main switch are both off", () => {
    expect(cloudSells()).toBe(false);
    expect(seiraCloudSells()).toBe(false);
  });
  it("the two plan lists are equal, so the switches cannot drift", () => {
    expect([...SEIRA_CLOUD_SALE_TIERS]).toEqual([...SEIRA_CLOUD_PLANS]);
  });
  it("no offer is allowed, even for a signed-out account", () => {
    expect(cloudOfferAllowed({ kind: "signed-out" })).toBe(false);
  });
  it("the first-run setup and chips do not offer a Cloud", () => {
    expect(setupSteps(fresh)).not.toContain("cloud");
    expect(introChips(fresh)).not.toContain("cloud");
  });
  it("openCloudAdd and the how-to open nothing, but sign-in still opens the sheet", () => {
    const start = initialState;
    expect(reducer(start, { type: "openCloudAdd", source: "app_menu" }).cloudAdd).toBeNull();
    expect(reducer(start, { type: "cloudHowTo", open: true }).cloudHowTo).toBe(false);
    expect(reducer(start, { type: "openCloudAdd", source: "app_settings", signIn: true }).cloudAdd).toEqual({ source: "app_settings", signIn: true });
  });
});
