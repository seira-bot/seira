import { describe, expect, it } from "vitest";

import { engineMayLackShell } from "./engine-shell-note";

const none = { localComputer: { available: false } } as Pick<DesktopCapabilities, "localComputer">;
const here = { localComputer: { available: true } } as Pick<DesktopCapabilities, "localComputer">;
const api = { driverKind: "openai-compat" };

describe("engineMayLackShell", () => {
  it("says so for an API engine when This computer is not available and no VPS or My Cloud is set up", () => {
    expect(engineMayLackShell({ instance: api, capabilities: none, config: { cloudHome: false, vps: { configured: false, sshAlias: "" } } })).toBe(true);
    expect(engineMayLackShell({ instance: api, capabilities: none, config: null })).toBe(true);
  });

  it("stays quiet when a computer can be lent, or the engine is not an API engine", () => {
    expect(engineMayLackShell({ instance: api, capabilities: here, config: null })).toBe(false);
    expect(engineMayLackShell({ instance: api, capabilities: none, config: { cloudHome: false, vps: { configured: true, sshAlias: "box" } } })).toBe(false);
    expect(engineMayLackShell({ instance: api, capabilities: none, config: { cloudHome: true, vps: { configured: false, sshAlias: "" } } })).toBe(false);
    expect(engineMayLackShell({ instance: { driverKind: "codex" }, capabilities: none, config: null })).toBe(false);
    expect(engineMayLackShell({ instance: undefined, capabilities: none, config: null })).toBe(false);
  });
});
