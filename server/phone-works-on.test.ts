import { describe, expect, it } from "vitest";

import { pairedDeviceWorksOnChange, type PhoneWorksOnContext } from "./phone-works-on.ts";

const admin: PhoneWorksOnContext = { pairedDevice: true, scopes: ["admin", "client"], cloudHome: false, hostedWorkspace: false };
const OWN = { computer: "cloud", cloudBackend: "vps" };

describe("pairedDeviceWorksOnChange", () => {
  it("allows no computer and the own server from an admin paired device", () => {
    expect(pairedDeviceWorksOnChange({ computer: "off" }, admin)).toBe("off");
    expect(pairedDeviceWorksOnChange(OWN, admin)).toBe("own-server");
    expect(pairedDeviceWorksOnChange({ cloudBackend: "vps", computer: "cloud" }, admin)).toBe("own-server");
  });

  it("refuses a device with only the client scope", () => {
    const client = { ...admin, scopes: ["client"] };
    expect(pairedDeviceWorksOnChange({ computer: "off" }, client)).toBeNull();
    expect(pairedDeviceWorksOnChange(OWN, client)).toBeNull();
  });

  it("refuses any other field with the move", () => {
    for (const extra of [{ vpsAlias: "elsewhere" }, { name: "x" }, { color: "blue" }, { approvalMode: "full" }]) {
      expect(pairedDeviceWorksOnChange({ computer: "off", ...extra }, admin)).toBeNull();
      expect(pairedDeviceWorksOnChange({ ...OWN, ...extra }, admin)).toBeNull();
    }
  });

  it("refuses every other value", () => {
    for (const computer of ["local", "vm", "browser", null, "cloud", "", undefined, 1]) {
      expect(pairedDeviceWorksOnChange({ computer }, admin), String(computer)).toBeNull();
    }
    expect(pairedDeviceWorksOnChange({ computer: "cloud", cloudBackend: "box" }, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange({ computer: "off", cloudBackend: "vps" }, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange({ computer: "local", cloudBackend: "vps" }, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange({ cloudBackend: "vps" }, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange({}, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange(null, admin)).toBeNull();
    expect(pairedDeviceWorksOnChange([], admin)).toBeNull();
  });

  it("refuses on a Cloud home and on a hosted workspace", () => {
    expect(pairedDeviceWorksOnChange({ computer: "off" }, { ...admin, cloudHome: true })).toBeNull();
    expect(pairedDeviceWorksOnChange(OWN, { ...admin, cloudHome: true })).toBeNull();
    expect(pairedDeviceWorksOnChange({ computer: "off" }, { ...admin, hostedWorkspace: true })).toBeNull();
    expect(pairedDeviceWorksOnChange(OWN, { ...admin, hostedWorkspace: true })).toBeNull();
  });

  it("leaves a request that is not from a paired device to the ordinary rules", () => {
    expect(pairedDeviceWorksOnChange({ computer: "off" }, { ...admin, pairedDevice: false })).toBeNull();
  });
});
