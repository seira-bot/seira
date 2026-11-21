import { describe, expect, it } from "vitest";

import { cloudSignedHeaders, readCloudSigned } from "./cloud-signed-headers.ts";

const parts = { machineId: "m1", timestamp: "1790000000", nonce: "n".repeat(20), signature: "v1=abc" };

describe("cloudSignedHeaders", () => {
  it("sends each value under both names", () => {
    expect(cloudSignedHeaders(parts)).toEqual({
      "x-seira-cloud-machine": "m1", "x-seira-cloud-timestamp": parts.timestamp, "x-seira-cloud-nonce": parts.nonce, "x-seira-cloud-signature": "v1=abc",
      "x-omb-cloud-machine": "m1", "x-omb-cloud-timestamp": parts.timestamp, "x-omb-cloud-nonce": parts.nonce, "x-omb-cloud-signature": "v1=abc",
    });
  });

  it("leaves the machine headers out without a machine id", () => {
    const headers = cloudSignedHeaders({ ...parts, machineId: undefined });
    expect(Object.keys(headers).filter((name) => name.endsWith("machine"))).toEqual([]);
  });
});

describe("readCloudSigned", () => {
  const reader = (headers: Record<string, string>) => readCloudSigned((name) => headers[name]);

  it("reads the new names alone", () => {
    expect(reader({ "x-seira-cloud-machine": "m1", "x-seira-cloud-timestamp": "1", "x-seira-cloud-nonce": "n", "x-seira-cloud-signature": "s" }))
      .toEqual({ machineId: "m1", timestamp: "1", nonce: "n", signature: "s" });
  });

  it("reads the old names alone", () => {
    expect(reader({ "x-omb-cloud-machine": "m1", "x-omb-cloud-timestamp": "1", "x-omb-cloud-nonce": "n", "x-omb-cloud-signature": "s" }))
      .toEqual({ machineId: "m1", timestamp: "1", nonce: "n", signature: "s" });
  });

  it("prefers the new names when both are present", () => {
    expect(reader({ "x-seira-cloud-timestamp": "new", "x-omb-cloud-timestamp": "old", "x-omb-cloud-nonce": "old-n" }))
      .toMatchObject({ timestamp: "new", nonce: "old-n" });
  });

  it("returns undefined for absent headers", () => {
    expect(reader({})).toEqual({ machineId: undefined, timestamp: undefined, nonce: undefined, signature: undefined });
  });
});
