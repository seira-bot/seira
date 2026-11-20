import { describe, expect, it, vi } from "vitest";

import { chiefChoices, chiefFor, chiefStepFits, createChiefPatch, hiddenFromSidebar, INTRO_CHIPS, introChips, myDefaultBot, setupSteps, someoneElsesDefaultBot } from "./default-bot";
import { partitionSidebarBots } from "./sidebar-layout";
import type { DefaultBotFields } from "../../shared/default-bot";
vi.mock("@/lib/seira-cloud", () => ({ SEIRA_CLOUD_PLANS: ["pro", "team"] })); // these tests cover the sale itself

const bot = (id: string, fields: DefaultBotFields = {}): DefaultBotFields & { id: string } => ({ id, ...fields });

describe("Seira in the sidebar", () => {
  it("leaves out a Seira whose Show switch is off, and on a Team Cloud other people's, but keeps the viewer's own", () => {
    const bots = [
      bot("seira", { defaultBot: {} }),
      bot("ada-seira", { defaultBot: { person: "ada@example.com" } }),
      bot("bea-seira", { defaultBot: { person: "bea@example.com" } }),
      bot("writer"),
    ];
    const shown = (viewerEmail: string | null) => partitionSidebarBots(bots, { viewerEmail }).unsectionedBots.map((entry) => entry.id);
    expect(shown("ada@example.com")).toEqual(["seira", "ada-seira", "writer"]);
    expect(shown(null)).toEqual(["seira", "writer"]);
    bots[0] = bot("seira", { defaultBot: {}, sidebarHidden: true });
    expect(shown(null)).toEqual(["writer"]);
    expect(hiddenFromSidebar(bots[0]!, null)).toBe(true);
    expect(someoneElsesDefaultBot(bots[2]!, "ADA@example.com".toLowerCase())).toBe(true);
  });

  it("finds the viewer's own Seira: their own on a team, the place's otherwise, none until the viewer is known", () => {
    const team = [bot("ada-seira", { defaultBot: { person: "ada@example.com" } }), bot("writer")];
    expect(myDefaultBot(team, undefined)).toBeUndefined();
    expect(myDefaultBot(team, "ada@example.com")?.id).toBe("ada-seira");
    expect(myDefaultBot(team, "bea@example.com")).toBeUndefined();
    const place = [bot("writer"), bot("seira", { defaultBot: {} })];
    expect(myDefaultBot(place, null)?.id).toBe("seira");
    expect(myDefaultBot(place, "owner@example.com")?.id).toBe("seira");
  });
});

describe("Seira's identity is its mark, never its name", () => {
  it("keeps finding a renamed Seira for the Settings switch and the sidebar, and keeps it out of the list while its welcome is open", () => {
    const bots = [bot("writer"), { ...bot("seira", { defaultBot: {} }), name: "Jarvis" }];
    expect(myDefaultBot(bots, null)?.id).toBe("seira");
    expect(partitionSidebarBots(bots, { viewerEmail: null }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer", "seira"]);
    expect(partitionSidebarBots(bots, { viewerEmail: null, welcoming: "seira" }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer"]);
  });
});

describe("what Seira offers to set up", () => {
  const fresh = { aiReady: false, ownBots: 0, onCloud: false, team: false, remote: false };

  it("in Advanced mode, as on a new install before: an AI, bots, apps, the phone and the Cloud", () => {
    expect(setupSteps(fresh)).toEqual(["ai", "bots", "apps", "phone", "cloud"]);
    expect(setupSteps({ ...fresh, aiReady: true, onCloud: true })).toEqual(["bots", "apps", "phone"]);
    expect(setupSteps({ ...fresh, ownBots: 3 })).toEqual(["ai"]);
    expect(setupSteps({ ...fresh, team: true })).toEqual([]);
  });

  it("in Simple mode, chips for only what its look around found missing, in order: AI, apps, skills, phone, Cloud", () => {
    expect(introChips(fresh)).toEqual(["ai", "apps", "phone", "cloud"]);
    expect(introChips({ ...fresh, aiReady: true, importFound: true })).toEqual(["apps", "import", "phone", "cloud"]);
    expect(introChips({ ...fresh, aiReady: true, appsConnected: true, phonePaired: true })).toEqual(["cloud"]);
    expect(introChips({ ...fresh, aiReady: true, remote: true })).toEqual(["apps", "phone"]);
    expect(introChips({ ...fresh, aiReady: true, onCloud: true, importFound: false })).toEqual(["apps", "phone"]);
    expect(INTRO_CHIPS).toBe(3);
  });

  it("never offers a bot (the sidebar's + adds one), nor nags a person who is set up or a Team Cloud member", () => {
    expect(introChips(fresh)).not.toContain("bots");
    expect(introChips({ ...fresh, aiReady: true, ownBots: 3, importFound: true })).toEqual([]);
    expect(introChips({ ...fresh, ownBots: 3 })).toEqual(["ai"]);
    expect(introChips({ ...fresh, team: true })).toEqual([]);
  });
});

describe("the first run's Chief step", () => {
  const seira = { id: "seira", defaultBot: {}, chiefOfStaff: true };

  it("shows for a Seira not yet introduced, where it is the Chief or there is none", () => {
    expect(chiefStepFits([seira], seira)).toBe(true);
    expect(chiefStepFits([{ ...seira, chiefOfStaff: false }], { ...seira, chiefOfStaff: false })).toBe(true);
  });

  it("is skipped where another bot is the Chief, once Seira has met the person, and with no Seira", () => {
    const other = { ...seira, chiefOfStaff: false };
    expect(chiefStepFits([other, { id: "research", chiefOfStaff: true }], other)).toBe(false);
    expect(chiefStepFits([{ ...seira, welcomed: true }], { ...seira, welcomed: true })).toBe(false);
    expect(chiefStepFits([{ id: "research" }], undefined)).toBe(false);
  });

  it("keeps a Chief in another department out of it", () => {
    const other = { ...seira, chiefOfStaff: false };
    expect(chiefStepFits([other, { id: "sales", chiefOfStaff: true, section: "Sales" }], other)).toBe(true);
  });
});

describe("who becomes the Chief of Staff on the first run", () => {
  type Candidate = { id: string; defaultBot?: { person?: string }; chiefOfStaff?: boolean; section?: string; hidden?: boolean };
  const seira: Candidate = { id: "seira", defaultBot: {}, chiefOfStaff: true };
  const research: Candidate = { id: "research" };

  it("finds the Chief in Seira's own department, never a department's or a hidden one", () => {
    expect(chiefFor([seira, research], seira)?.id).toBe("seira");
    expect(chiefFor([{ ...seira, chiefOfStaff: false }, { ...research, chiefOfStaff: true }], seira)?.id).toBe("research");
    expect(chiefFor([{ ...seira, chiefOfStaff: false }, { id: "sales", section: "Sales", chiefOfStaff: true }], seira)).toBeUndefined();
    expect(chiefFor([{ ...seira, chiefOfStaff: false }, { id: "old", chiefOfStaff: true, hidden: true }], seira)).toBeUndefined();
  });

  it("offers the person's own bots there to choose from, never Seira, a hidden bot or someone else's", () => {
    const bots: Candidate[] = [seira, research, { id: "sales", section: "Sales" }, { id: "gone", hidden: true }, { id: "ada-seira", defaultBot: { person: "ada@example.com" } }];
    expect(chiefChoices(bots, seira, null).map((bot) => bot.id)).toEqual(["research"]);
    expect(chiefChoices([seira], seira, null)).toEqual([]);
  });

  it("Create makes Seira the Chief only where there is none, and never takes the role from a Chief someone has", () => {
    expect(createChiefPatch({ defaultBot: {} }, undefined)).toEqual({ welcomed: true, chiefOfStaff: true });
    expect(createChiefPatch({ defaultBot: {} }, seira)).toEqual({ welcomed: true });
    expect(createChiefPatch({ defaultBot: {}, sidebarHidden: true }, seira), "back in the sidebar").toEqual({ welcomed: true, sidebarHidden: false });
  });
});
