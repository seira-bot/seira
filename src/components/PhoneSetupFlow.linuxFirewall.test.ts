import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhoneSetupFlowView, type CompanionState, type PhoneSetupController } from "./PhoneSetupFlow";

const UFW = "sudo ufw allow from 192.168.1.0/24 to any port 8810 proto tcp";

const state: CompanionState = {
  enabled: true,
  keepAwake: false,
  port: 8810,
  devices: [],
  pairing: { code: "123456", token: `seira_pair_${"a".repeat(43)}`, expiresAt: Date.now() + 120_000 },
  lan: "192.168.1.34",
  linuxFirewall: { certain: true, command: UFW },
};
const e2e = (over: Partial<CompanionState> = {}): CompanionState => ({
  ...state,
  ...over,
  e2e: { enabled: true, relay: "off", node: null, descriptor: null },
});

const noop = () => {};
const controller = (over: Partial<PhoneSetupController>): PhoneSetupController => ({
  state,
  account: null,
  phase: "qr",
  email: "",
  code: "",
  codeSent: false,
  busy: false,
  accountBusy: false,
  error: null,
  accountError: null,
  pairingLink: "seira://pair?address=192.168.1.34%3A8810",
  address: "192.168.1.34",
  pairingPort: 8810,
  addressText: "192.168.1.34:8810",
  hostedReady: false,
  localFallback: true,
  tailscaleFallback: false,
  tailscaleAvailable: false,
  pairingExpired: false,
  setupTimedOut: false,
  setEmail: noop,
  setCode: noop,
  changeEmail: noop,
  start: noop,
  useLocal: noop,
  useTailscale: noop,
  refreshTailscale: noop,
  requestCode: noop,
  verifyCode: noop,
  retryAccount: noop,
  cancel: noop,
  refreshCode: noop,
  finish: noop,
  act: async () => null,
  accountAct: async () => {},
  ...over,
});

const render = (over: Partial<PhoneSetupController>) =>
  renderToStaticMarkup(createElement(PhoneSetupFlowView, { controller: controller(over) }));

const BLOCKED = "This computer&#x27;s firewall is blocking your phone, so run this command in a terminal to let it in:";
const MAY_BLOCK = "This computer&#x27;s firewall may block your phone, so if it can&#x27;t connect, run this command in a terminal:";

describe("the Wi-Fi pairing panel on a Linux computer whose firewall drops the phone", () => {
  it("shows one sentence, the command and a Copy button, on both pairing screens", () => {
    for (const html of [render({}), render({ state: e2e() })]) {
      expect(html).toContain("role=\"note\"");
      expect(html).toContain(BLOCKED);
      expect(html).toContain(`>${UFW}</code>`);
      expect(html).toContain("aria-label=\"Copy command\"");
      expect(html).not.toContain(MAY_BLOCK);
    }
  });

  it("says the firewall may block the phone when its rules could not be read", () => {
    const unread = { linuxFirewall: { certain: false, command: UFW } };
    for (const html of [render({ state: { ...state, ...unread } }), render({ state: e2e(unread) })]) {
      expect(html).toContain(MAY_BLOCK);
      expect(html).not.toContain("is blocking");
    }
  });

  it("says nothing for a hosted QR, an open firewall or an expired code", () => {
    for (const over of [
      { localFallback: false },
      { state: { ...state, linuxFirewall: undefined } },
      { state: e2e({ linuxFirewall: undefined }) },
      { pairingExpired: true },
    ]) {
      expect(render(over)).not.toContain("firewall");
    }
  });
});
