// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionState, PhoneSetupController } from "./PhoneSetupFlow";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }) }));
vi.mock("./PhoneSetupFlow", () => ({ PhoneSetupFlowView: () => createElement("div", { "data-qr": "" }, "QR") }));
const { PairDeviceDialog, showHttpsAddressRow } = await import("./PhoneDevicesSection");

const off = { on: false, since: null };
const base = { enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null, notices: [],
  routes: { wifi: off, relay: off, tailscale: off, https: off } };
const tunnelState = { ...base, anywhere: "https" } as unknown as CompanionState;
const relayState = { ...base, anywhere: "relay" } as unknown as CompanionState;

let host: HTMLDivElement;
let root: Root;
let c: { busy: boolean; account: unknown; act: ReturnType<typeof vi.fn>; useLocal: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

const open = (state: CompanionState) => flushSync(() => root.render(createElement(PairDeviceDialog, { c: c as unknown as PhoneSetupController, state, onClose: () => {} })));
const dialog = () => document.querySelector<HTMLElement>("[data-pair-dialog]")!;
const turnOn = () => dialog().querySelector<HTMLButtonElement>("[data-pair-turn-on]")!;
const words = (node: Element | null | undefined) => (node?.textContent ?? "").replace(/\u2011/g, "-");

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  c = { busy: false, account: { available: true, status: "ready" }, act: vi.fn(async () => true), useLocal: vi.fn(), start: vi.fn(), cancel: vi.fn() };
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

it("with Anywhere on the secure address, turning on prepares the hosted address and never opens a Wi-Fi code", async () => {
  open(tunnelState);
  expect(words(dialog().querySelector('[data-route-card="relay"]'))).toContain("Works away from home, over a secure Seira address.");
  expect(words(dialog())).not.toMatch(/end-to-end/i);
  turnOn().click();
  await vi.waitFor(() => expect(c.start).toHaveBeenCalledOnce());
  expect(c.useLocal).not.toHaveBeenCalled();
  expect(c.act).not.toHaveBeenCalled();
  expect(dialog().dataset.pairDialog).toBe("pairing");
});

it("with Anywhere on the relay, it still turns the relay on and shows the Wi-Fi code", async () => {
  open(relayState);
  expect(words(dialog().querySelector('[data-route-card="relay"]'))).toContain("End-to-end encrypted.");
  turnOn().click();
  await vi.waitFor(() => expect(c.useLocal).toHaveBeenCalledOnce());
  expect(c.act).toHaveBeenCalledOnce();
  expect(c.start).not.toHaveBeenCalled();
});

it("hides the separate HTTPS address row when Anywhere already is that address", () => {
  const account = { endpoint: "https://c-ab12.seira.run" };
  expect(showHttpsAddressRow(tunnelState, account, null)).toBe(false);
  expect(showHttpsAddressRow({ ...tunnelState, routes: { ...base.routes, https: { on: true, since: 1 } } } as unknown as CompanionState, account, null)).toBe(false);
  expect(showHttpsAddressRow(relayState, null, null)).toBe(true);
});
