// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { CompanionAccountState } from "../types/ogb";
import { PhoneSetupFlowView, usePhoneSetupController, type CompanionState } from "./PhoneSetupFlow";

function PhoneSetupFlow() {
  return createElement(PhoneSetupFlowView, { controller: usePhoneSetupController() });
}

function desktop() {
  let companion: CompanionState = { enabled: false, keepAwake: false, port: 8810, devices: [], pairing: null };
  const account: CompanionAccountState = { available: false, status: "signed-out", problem: "unconfigured" };
  const bridge = {
    companion: {
      state: vi.fn(async () => companion),
      start: vi.fn(async () => {
        companion = { ...companion, enabled: true, endpoints: [], lan: "192.168.1.34" };
        return companion;
      }),
      stop: vi.fn(async () => companion),
      keepAwake: vi.fn(async () => companion),
      refreshTailscale: vi.fn(async () => companion),
      pairing: vi.fn(async (open: boolean) => {
        companion = {
          ...companion,
          pairing: open ? { code: "123456", token: `seira_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 } : null,
        };
        return companion;
      }),
      cloudDesktop: vi.fn(async () => companion),
      browserControl: vi.fn(async () => companion),
      revoke: vi.fn(async () => companion),
    },
    companionAccount: {
      state: vi.fn(async () => account),
      requestCode: vi.fn(async () => account),
      verifyCode: vi.fn(async () => account),
      retry: vi.fn(async () => account),
      signOut: vi.fn(async () => account),
      prepare: vi.fn(async () => account),
    },
  };
  return { bridge };
}

let host: HTMLDivElement;
let root: Root;
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) ?? null;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

describe("pairing while no phone account service is configured", () => {
  it("opens same-network pairing and never asks for an email", async () => {
    const fake = desktop();
    (globalThis as { ogb?: unknown }).ogb = fake.bridge;
    flushSync(() => root.render(createElement(PhoneSetupFlow)));
    await vi.waitFor(() => expect(button("Pair a device")?.disabled).toBe(false));
    button("Pair a device")!.click();

    await vi.waitFor(() => expect(host.querySelector('[aria-label="Device pairing QR code"]')).not.toBeNull());
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(fake.bridge.companion.pairing).toHaveBeenCalledWith(true);
    expect(fake.bridge.companionAccount.prepare).not.toHaveBeenCalled();
    expect(fake.bridge.companionAccount.requestCode).not.toHaveBeenCalled();
  });
});
