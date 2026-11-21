import { describe, expect, it } from "vitest";

import { cloudSignedHeaders, CLOUD_SIGNED_HEADERS, CLOUD_SIGNED_LEGACY_HEADERS } from "../cloud-signed-headers.ts";
import { pagesHomeSignature } from "../pages/access.ts";
import { FAKE_HOME, FAKE_TOKEN_URL, fakePagesService } from "./fake-pages.ts";

const body = JSON.stringify({ action: "create" });
const timestamp = "1792670400", nonce = "n".repeat(20);
const signature = `v1=${pagesHomeSignature(FAKE_HOME.bootstrapSecret, FAKE_HOME.machineId, timestamp, nonce, body)}`;
const all = cloudSignedHeaders({ machineId: FAKE_HOME.machineId, timestamp, nonce, signature });
const only = (names: Record<string, string>) => Object.fromEntries(Object.entries(all).filter(([name]) => Object.values(names).includes(name)));

async function status(headers: Record<string, string>): Promise<number> {
  const { fetch } = fakePagesService();
  return (await fetch(FAKE_TOKEN_URL, { method: "POST", body, headers: { "content-type": "application/json", ...headers } })).status;
}

describe("fake pages service home signature", () => {
  it("accepts the x-seira-cloud-* headers alone", async () => {
    expect(await status(only(CLOUD_SIGNED_HEADERS))).toBe(200);
  });

  it("accepts the x-omb-cloud-* headers alone", async () => {
    expect(await status(only(CLOUD_SIGNED_LEGACY_HEADERS))).toBe(200);
  });

  it("refuses a wrong signature under either name", async () => {
    expect(await status({ ...only(CLOUD_SIGNED_HEADERS), "x-seira-cloud-signature": "v1=wrong" })).toBe(401);
    expect(await status({ ...only(CLOUD_SIGNED_LEGACY_HEADERS), "x-omb-cloud-signature": "v1=wrong" })).toBe(401);
  });
});
