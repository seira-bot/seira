import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { companionDeviceOf, fromPairedDevice } from "./paired-device.ts";

const req = (headers: Record<string, string> = {}) => ({ headers }) as unknown as IncomingMessage;
const PHONE_HEADERS = { "x-seira-companion": "1", "x-seira-companion-device": "phone-1" };
const session = (record: Record<string, unknown> = {}) =>
  ({ kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1", label: "Device", scopes: ["admin", "client"], ...record } }) as unknown as RequestAuth;
const local: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const proven: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-9" };

describe("fromPairedDevice", () => {
  it("is true for a session from a phone's pairing, a Team Cloud member's phone and a phone the companion proved, with no header", () => {
    expect(fromPairedDevice(req(), session({ pairedDevice: true }))).toBe(true);
    expect(fromPairedDevice(req(), session({ membershipAuthority: "team", memberCheckedAt: 1 }))).toBe(true);
    expect(fromPairedDevice(req(), proven)).toBe(true);
  });

  it("lets the header add the limits to any request, and is false without a mark or a header", () => {
    expect(fromPairedDevice(req({ "x-seira-companion": "1" }), session())).toBe(true);
    expect(fromPairedDevice(req({ "x-seira-companion": "1" }), local)).toBe(true);
    expect(fromPairedDevice(req(), session())).toBe(false);
    expect(fromPairedDevice(req(), session({ membershipAuthority: "team" }))).toBe(false);
    expect(fromPairedDevice(req({ "x-seira-companion": "0" }), local)).toBe(false);
  });
});

describe("companionDeviceOf", () => {
  it("names no phone for a session, whatever headers it sends", () => {
    expect(companionDeviceOf(req(PHONE_HEADERS), session({ pairedDevice: true }))).toBeUndefined();
    expect(companionDeviceOf(req(PHONE_HEADERS), session())).toBeUndefined();
  });

  it("takes the phone the companion proved over the headers, and a local companion's header otherwise", () => {
    expect(companionDeviceOf(req(PHONE_HEADERS), proven)).toBe("phone-9");
    expect(companionDeviceOf(req(), proven)).toBe("phone-9");
    expect(companionDeviceOf(req(PHONE_HEADERS), local)).toBe("phone-1");
    expect(companionDeviceOf(req({ "x-seira-companion-device": "phone-1" }), local)).toBeUndefined();
    expect(companionDeviceOf(req({ "x-seira-companion": "1", "x-seira-companion-device": "../phone" }), local)).toBeUndefined();
  });
});
