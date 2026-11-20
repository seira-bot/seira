import { describe, expect, it } from "vitest";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { SEIRA_CLOUD_PLANS } from "./seira-cloud";
import { whatsNewSlides, whatsNewView } from "./whats-new";

const OFFER: CloudOffer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "pro", label: "Pro", amount: 4900 }, { tier: "team", label: "Team", amount: 4000, trialDays: 3 },
] };

describe("Seira Cloud plans", () => {
  it("sells no plan yet, so the What's new popup stays hidden", () => {
    expect(SEIRA_CLOUD_PLANS).toEqual([]);
    expect(whatsNewView({ status: "signed-out" }, OFFER)).toBe("none");
    expect(whatsNewSlides("none")).toEqual([]);
  });
});
