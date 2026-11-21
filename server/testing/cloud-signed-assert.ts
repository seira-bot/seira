import { expect } from "vitest";

import { CLOUD_SIGNED_HEADERS, CLOUD_SIGNED_LEGACY_HEADERS } from "../cloud-signed-headers.ts";

/** A signed request carries every `x-seira-cloud-*` header, and the same value under the `x-omb-cloud-*` name. */
export function expectBothCloudSignedNames(headers: Record<string, string>, options: { machine?: boolean } = { machine: true }): void {
  const keys = (options.machine === false ? ["timestamp", "nonce", "signature"] : ["machine", "timestamp", "nonce", "signature"]) as Array<keyof typeof CLOUD_SIGNED_HEADERS>;
  for (const key of keys) {
    expect(headers[CLOUD_SIGNED_HEADERS[key]]).toBeTruthy();
    expect(headers[CLOUD_SIGNED_LEGACY_HEADERS[key]]).toBe(headers[CLOUD_SIGNED_HEADERS[key]]);
  }
  expect(headers[CLOUD_SIGNED_HEADERS.signature]).toMatch(/^v1=/);
}
