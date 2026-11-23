import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { CLOUD_SIGNED_HEADERS, CLOUD_SIGNED_LEGACY_HEADERS } from "../cloud-signed-headers.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { CLOUD_BOX_PATH, createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43);

function world() {
  const clock = 1_800_000_000_000;
  let counter = 0;
  const now = () => clock;
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
  const handle = createCloudSignedRoutes({ secret, sessions, health, now });
  const parts = (key = secret) => {
    const timestamp = String(Math.floor(now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { timestamp, nonce, signature: `v1=${cloudRequestSignature(key, timestamp, nonce, "GET", CLOUD_BOX_PATH, "")}` };
  };
  const named = (names: Record<"timestamp" | "nonce" | "signature", string>, signed: ReturnType<typeof parts>) =>
    ({ [names.timestamp]: signed.timestamp, [names.nonce]: signed.nonce, [names.signature]: signed.signature });
  const status = async (headers: Record<string, string>) => {
    const req = Object.assign(new PassThrough(), { method: "GET", url: CLOUD_BOX_PATH, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let code = 0;
    const res = { setHeader() {}, writeHead(value: number) { code = value; }, end() {} } as unknown as ServerResponse;
    const answered = handle({ req, res, url: new URL(CLOUD_BOX_PATH, "http://localhost"), path: CLOUD_BOX_PATH, method: "GET" });
    (req as unknown as PassThrough).end("");
    await answered;
    return code;
  };
  return { parts, named, status };
}

describe("the Cloud-signed header names", () => {
  it("accepts a valid request that carries only x-seira-cloud-*", async () => {
    const { parts, named, status } = world();
    expect(await status(named(CLOUD_SIGNED_HEADERS, parts()))).toBe(200);
  });

  it("accepts a valid request that carries only x-omb-cloud-*", async () => {
    const { parts, named, status } = world();
    expect(await status(named(CLOUD_SIGNED_LEGACY_HEADERS, parts()))).toBe(200);
  });

  it("uses the x-seira-cloud-* values when both sets are present", async () => {
    const { parts, named, status } = world();
    const wrong = parts("W".repeat(43));
    expect(await status({ ...named(CLOUD_SIGNED_LEGACY_HEADERS, wrong), ...named(CLOUD_SIGNED_HEADERS, parts()) })).toBe(200);
    expect(await status({ ...named(CLOUD_SIGNED_LEGACY_HEADERS, parts()), ...named(CLOUD_SIGNED_HEADERS, wrong) })).toBe(401);
  });

  it("refuses a request with no signed headers", async () => {
    expect(await world().status({})).toBe(401);
  });
});
