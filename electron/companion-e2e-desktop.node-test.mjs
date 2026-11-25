import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopCompanionE2E } from "./companion-e2e-desktop.mjs";

const make = () => createDesktopCompanionE2E({
  isPackaged: true, appVersion: "0.0.0", readCredentials: () => null, updateCredentials: async () => {}, powerMonitor: null, log() {}, onState() {}, renewInstallation: async () => {},
});
const withControlPlane = (value, run) => {
  const before = Object.hasOwn(process.env, "SEIRA_CONTROL_PLANE_URL") ? process.env.SEIRA_CONTROL_PLANE_URL : undefined;
  if (value === undefined) delete process.env.SEIRA_CONTROL_PLANE_URL; else process.env.SEIRA_CONTROL_PLANE_URL = value;
  try { return run(); } finally { if (before === undefined) delete process.env.SEIRA_CONTROL_PLANE_URL; else process.env.SEIRA_CONTROL_PLANE_URL = before; }
};

test("the encrypted connection is configured only when a control plane client exists", () => {
  assert.equal(withControlPlane("https://accounts.example.test", () => make().configured), true);
  assert.equal(withControlPlane("", () => make().configured), false);
  assert.equal(withControlPlane("not a url", () => make().configured), false);
});
