import { describe, expect, it } from "vitest";

import { cloudRequestSignature, signedHeaders } from "../src/home-health.ts";

describe("signedHeaders", () => {
  it("sends each value under x-seira-cloud-* and x-omb-cloud-*, with an unchanged signature", () => {
    const secret = "S".repeat(43), now = 1_793_183_627_000;
    const headers = signedHeaders(secret, "GET", "/api/cloud/health", "", now);
    const timestamp = "1793183627", nonce = headers["x-seira-cloud-nonce"]!;
    expect(headers["x-seira-cloud-timestamp"]).toBe(timestamp);
    expect(headers["x-seira-cloud-signature"]).toBe(`v1=${cloudRequestSignature(secret, timestamp, nonce, "GET", "/api/cloud/health", "")}`);
    for (const key of ["timestamp", "nonce", "signature"]) expect(headers[`x-omb-cloud-${key}`]).toBe(headers[`x-seira-cloud-${key}`]);
    expect(Object.keys(headers)).toHaveLength(6);
  });
});
