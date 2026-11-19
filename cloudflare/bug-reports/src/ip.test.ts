import { describe, expect, it } from "vitest";

import { rateKeyOf } from "./ip";

describe("AC-13 IPv4 keeps the full address", () => {
  it.each(["203.0.113.7", "198.51.100.20", "0.0.0.0", "255.255.255.255"])("keeps %s", (ip) => {
    expect(rateKeyOf(ip)).toBe(ip);
  });
});

describe("AC-10 IPv6 uses the /64 prefix", () => {
  it("keeps the first four groups and drops the host part", () => {
    expect(rateKeyOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateKeyOf("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
  });

  it("gives one key to every address of a /64, and another key to the next /64", () => {
    const keys = ["2001:db8:aaaa:bbbb::1", "2001:db8:aaaa:bbbb:ffff:1:2:3", "2001:DB8:AAAA:BBBB::"].map(rateKeyOf);
    expect(new Set(keys).size).toBe(1);
    expect(rateKeyOf("2001:db8:aaaa:bbbc::1")).not.toBe(keys[0]);
    expect(rateKeyOf("2001:db9:aaaa:bbbb::1")).not.toBe(keys[0]);
  });

  it("reads a compressed address, leading zeros and capital letters as the same group values", () => {
    const expected = "2001:db8:0:1::/64";
    for (const ip of ["2001:db8:0:1::1", "2001:0DB8:0000:0001:0000:0000:0000:0001", "2001:db8::1:0:0:0:1", "2001:db8:0:1:0:0:0:1"]) {
      expect(rateKeyOf(ip), ip).toBe(expected);
    }
  });

  it("handles the all-zero and loopback addresses", () => {
    expect(rateKeyOf("::")).toBe("0:0:0:0::/64");
    expect(rateKeyOf("::1")).toBe("0:0:0:0::/64");
  });

  it("ignores a zone id", () => {
    expect(rateKeyOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("reads a dotted IPv4 tail as the last two groups", () => {
    expect(rateKeyOf("64:ff9b::198.51.100.9")).toBe("64:ff9b:0:0::/64");
  });

  it("never gives an IPv4 address and an IPv6 prefix the same key", () => {
    expect(rateKeyOf("2001:db8:1:2::1")).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe("AC-14 IPv4-mapped IPv6 uses the IPv4 address", () => {
  it.each(["::ffff:198.51.100.9", "::FFFF:198.51.100.9", "::ffff:c633:6409", "0:0:0:0:0:ffff:198.51.100.9"])("maps %s", (ip) => {
    expect(rateKeyOf(ip)).toBe("198.51.100.9");
  });

  it("gives the mapped form and the plain form the same key", () => {
    expect(rateKeyOf("::ffff:203.0.113.7")).toBe(rateKeyOf("203.0.113.7"));
  });
});

describe("AC-15 text that is not an address", () => {
  it.each([
    "unknown",
    "not an ip",
    "1:2:3",
    "1.2.3",
    "2001:db8::1::2",
    ":::",
    "12345::1",
    "::g",
    "2001:db8:1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7::8",
    "::ffff:300.1.1.1",
    "::ffff:1.2.3",
    "1.2.3.4:5678",
  ])("returns %j unchanged", (value) => {
    expect(rateKeyOf(value)).toBe(value);
  });

  it("does not throw on a very long value", () => {
    const value = `${"ab:".repeat(5000)}x`;
    expect(rateKeyOf(value)).toBe(value);
  });
});
