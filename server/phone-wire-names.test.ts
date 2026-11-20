import { describe, expect, it } from "vitest";

import * as companion from "../companion/src/wire-names.ts";
import * as electron from "../electron/phone-wire-names.mjs";
import * as canonical from "../packages/phone-protocol/src/wire-names.ts";

describe("the copies of the phone wire names", () => {
  it.each([["companion", companion], ["electron", electron]] as const)("the %s copy equals the table", (_name, copy) => {
    expect(copy.PHONE_WIRE_NAMES).toEqual(canonical.PHONE_WIRE_NAMES);
    expect(copy.PHONE_WIRE_SEND).toBe(canonical.PHONE_WIRE_SEND);
    for (const key of Object.keys(canonical.PHONE_WIRE_NAMES) as canonical.PhoneWireName[]) {
      expect(copy.sentWireName(key)).toBe(canonical.sentWireName(key));
      expect(copy.acceptedWireNames(key)).toEqual(canonical.acceptedWireNames(key));
      for (const value of canonical.acceptedWireNames(key)) expect(copy.acceptsWireName(key, value)).toBe(true);
      expect(copy.acceptsWireName(key, "")).toBe(false);
    }
  });

  it("every name has an old and a Seira value, and a phone reads both", () => {
    for (const [key, value] of Object.entries(canonical.PHONE_WIRE_NAMES)) {
      expect(value.legacy, key).not.toBe(value.seira);
      expect(canonical.acceptedWireNames(key as canonical.PhoneWireName)).toEqual([value.legacy, value.seira]);
    }
  });
});
