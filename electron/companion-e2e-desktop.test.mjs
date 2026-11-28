import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./companion.mjs", () => ({ companionState: vi.fn(), postCompanionMessage: vi.fn(), setCompanionE2EHooks: vi.fn() }));
const { createDesktopCompanionE2E } = await import("./companion-e2e-desktop.mjs");

const make = () => createDesktopCompanionE2E({
  isPackaged: true, appVersion: "0.0.0", readCredentials: () => null, updateCredentials: async () => {}, powerMonitor: null, log() {}, onState() {}, renewInstallation: async () => {},
});

describe("the desktop encrypted connection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is configured only when a control plane client exists", () => {
    vi.stubEnv("SEIRA_CONTROL_PLANE_URL", "https://accounts.example.test");
    expect(make().configured).toBe(true);
    vi.stubEnv("SEIRA_CONTROL_PLANE_URL", "");
    expect(make().configured).toBe(false);
    vi.stubEnv("SEIRA_CONTROL_PLANE_URL", "not a url");
    expect(make().configured).toBe(false);
  });
});
