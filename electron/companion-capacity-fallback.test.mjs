import { describe, expect, it, vi } from "vitest";

import { companionEndpointCandidates } from "../companion/src/endpoints.ts";
import { phonePairingLink } from "../shared/pairing-link";
import { companionPairingRoute } from "../src/lib/companion-pairing";
import { ControlPlaneError } from "./control-plane-client.mjs";
import { FRIENDLY_MESSAGES } from "./companion-account-messages.mjs";
import { createCompanionAccountService, friendlyCompanionAccountError } from "./companion-account-service.mjs";
import { resolveDesktopControlPlaneURL } from "./desktop-control-plane.mjs";
import { LIVE_SEIRA_SERVICES } from "./seira-hosts.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
const SESSION = {
  accountToken: `omc_${"a".repeat(43)}`,
  user: { id: "user-1", email: "ada@example.com" },
};

function failingClient(error) {
  return {
    health: vi.fn(async () => true),
    ensureInstallation: vi.fn(async () => ({
      installation: { id: "22222222-2222-4222-8222-222222222222", clientInstanceId: UUID, name: "Mac", platform: "darwin" },
      credential: `seira_install_${"b".repeat(22)}.${"c".repeat(43)}`,
      credentialExpiresAt: Date.now() + 10_000,
    })),
    ensureEndpoint: vi.fn(async () => {
      throw error;
    }),
    listInstallations: vi.fn(async () => []),
    deleteEndpoint: vi.fn(async () => {}),
    revokeInstallation: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
}

function serviceFor(client) {
  let document = {};
  const activate = vi.fn(async () => ({ status: "ready", ready: true }));
  const service = createCompanionAccountService({
    client,
    readCredentials: () => structuredClone(document),
    updateCredentials: async (derive) => {
      document = structuredClone(await derive(structuredClone(document)));
      return structuredClone(document);
    },
    identity: { name: "Mac", platform: "darwin", appVersion: "1.2.3" },
    newClientInstanceId: () => UUID,
    activatePersistedEndpoint: activate,
    stopManagedEndpoint: async () => {},
    companionIsOn: () => true,
    cloudSession: { current: () => SESSION },
  });
  return { service, activate };
}

const QR_SOURCE = {
  port: 8810,
  tailnetName: "mac.tail1234.ts.net",
  lan: "192.168.1.42",
  hosts: ["mac.tail1234.ts.net", "192.168.1.42"],
  endpoints: companionEndpointCandidates(8810, ["100.64.0.5", "192.168.1.42"], "mac.tail1234.ts.net", null, null),
};
const token = `seira_pair_${"a".repeat(43)}`;

describe("a desktop that Seira Cloud cannot give an address", () => {
  it("has the server tunnel service switched on", () => {
    expect(resolveDesktopControlPlaneURL({ isPackaged: true, environment: {}, live: [...LIVE_SEIRA_SERVICES, "serverTunnel"] })).toBe("https://accounts.seira.bot");
  });

  for (const [name, error] of [
    ["is full (503)", new ControlPlaneError("endpoint_capacity", 503)],
    ["has the account at its limit (429)", new ControlPlaneError("endpoint_limit", 429)],
    ["does not answer", new ControlPlaneError("control_plane_unavailable")],
  ]) {
    it(`keeps running and shows the message when Seira Cloud ${name}`, async () => {
      const { service, activate } = serviceFor(failingClient(error));

      const state = await service.useCloudSession();

      expect(state.status).toBe("error");
      expect(state.message).toBe(friendlyCompanionAccountError(error));
      expect(FRIENDLY_MESSAGES[error.code]).toBeTruthy();
      expect(activate).not.toHaveBeenCalled();
      await expect(service.state()).resolves.toMatchObject({ status: "error" });
      service.dispose();
    });
  }

  it("keeps the LAN and tailnet routes and adds no hosted route", () => {
    expect(QR_SOURCE.endpoints.map((endpoint) => endpoint.kind)).toEqual(["tailnet", "lan"]);
    for (const mode of ["local", "tailscale"]) {
      const route = companionPairingRoute(QR_SOURCE, mode);
      const kinds = route.endpoints.map((endpoint) => endpoint.kind);
      expect(kinds, mode).toContain(mode === "local" ? "lan" : "tailnet");
      expect(kinds, mode).not.toContain("hosted");
      expect(phonePairingLink({ ...route, code: "004209", token })).toBeTruthy();
    }
    expect(companionPairingRoute(QR_SOURCE, "automatic")).toBeNull();
  });
});
