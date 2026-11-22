import { describe, expect, it } from "vitest";

import {
  CLOUD_BACKEND_CHANGE_ERROR,
  VPS_ALIAS_RESOURCES_ERROR,
  VPS_BOT_ALIAS_CHANGE_ERROR,
  cloudBackendChangeError,
  vpsAliasResourceChangeError,
  vpsBotAliasChangeError,
  vpsNotChosenReason,
} from "./cloud-backend.ts";

describe("cloud backend switching", () => {
  const activeTurnCases: Array<[string, boolean, boolean]> = [
    ["a busy bot", true, false],
    ["an active VPS thread", false, true],
  ];

  it.each(activeTurnCases)("rejects changes during %s", (_reason, busy, activeVpsThread) => {
    expect(cloudBackendChangeError(busy, activeVpsThread)).toBe(CLOUD_BACKEND_CHANGE_ERROR);
  });

  it("allows changes while idle", () => {
    expect(cloudBackendChangeError(false, false)).toBeNull();
  });

  it("keeps an SSH alias attached while its VPS still has local computers", () => {
    expect(vpsAliasResourceChangeError(1)).toBe(VPS_ALIAS_RESOURCES_ERROR);
    expect(vpsAliasResourceChangeError(0)).toBeNull();
  });

  it.each(activeTurnCases)("rejects a bot's own SSH alias change during %s", (_reason, busy, activeVpsThread) => {
    expect(vpsBotAliasChangeError(busy, activeVpsThread)).toBe(VPS_BOT_ALIAS_CHANGE_ERROR);
  });

  it("allows a bot's own SSH alias change while idle", () => {
    expect(vpsBotAliasChangeError(false, false)).toBeNull();
  });
});

describe("vpsNotChosenReason", () => {
  it("points a bot without a cloud computer at the saved VPS it could use instead", () => {
    const reason = vpsNotChosenReason("Scout", "production-vps");
    expect(reason).toContain("production-vps");
    expect(reason).toContain("Self-hosted VPS");
    expect(reason).toContain("Scout's Bot settings, Access section");
  });

  it("says nothing when no VPS is set up", () => {
    expect(vpsNotChosenReason("Scout", null)).toBeNull();
  });
});
