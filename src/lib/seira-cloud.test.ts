import { describe, expect, it } from "vitest";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { BUILT_IN_ANNOUNCEMENTS, type HistoryFacts } from "@/lib/announcement-history";
import { WHATS_NEW_NOTICE } from "@/lib/notices";
import { SEIRA_CLOUD_PLANS } from "./seira-cloud";
import { whatsNewSlides, whatsNewView } from "./whats-new";

const OFFER: CloudOffer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "pro", label: "Pro", amount: 4900 }, { tier: "team", label: "Team", amount: 4000, trialDays: 3 },
] };
const desktopHere: HistoryFacts = { branded: false, organization: false, cloudSale: true, cloudCards: true, remote: false, team: false, canSave: true, sponsors: true, modelgo: true };

describe("Seira Cloud plans", () => {
  it("sells no plan yet, so the What's new popup stays hidden", () => {
    expect(SEIRA_CLOUD_PLANS).toEqual([]);
    expect(whatsNewView({ status: "signed-out" }, OFFER)).toBe("none");
    expect(whatsNewSlides("none")).toEqual([]);
    expect(BUILT_IN_ANNOUNCEMENTS.filter(entry => entry.for(desktopHere)).map(entry => entry.id)).not.toContain(WHATS_NEW_NOTICE);
  });
});
