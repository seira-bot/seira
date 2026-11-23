import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { descriptorFor, encodeDescriptor } from "../../companion/src/e2e/descriptor.ts";
import { generateKeyPair } from "../../companion/src/e2e/noise.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { decodeAnyInvite, decodeInvite, encodeInvite, newLinkId, readLinks, type RelayInvite } from "./linked-servers-store.ts";
import { LINK_DEVICE_PREFIX, RELAY_INVITES_MAX, RELAY_LINKS_MAX, placeholderOrigin, readRelayLinks, writeRelayLinks } from "./linked-servers-relay.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "linked-servers-invite-")); dirs.push(dir); return dir; };

const CODE = "A".repeat(43);
const hostId = randomBytes(16);
const key = generateKeyPair().publicKey;
const descriptor = descriptorFor(key, { hostId, nodes: ["relay1.seira.bot", "relay2.seira.bot"] });
const relayInvite: RelayInvite = { name: "Head office", code: CODE, e2e: descriptor };
const wrap = (body: unknown) => `seira-link:${Buffer.from(JSON.stringify(body)).toString("base64url")}`;

describe("invites", () => {
  it("keeps the invite with an address as it was, byte for byte", () => {
    const text = encodeInvite({ origin: "https://head.example", name: "Head", code: CODE });
    expect(text).toBe(`seira-link:${Buffer.from(`{"v":1,"origin":"https://head.example","name":"Head","code":"${CODE}"}`).toString("base64url")}`);
    expect(decodeInvite(text)).toEqual({ origin: "https://head.example", name: "Head", code: CODE });
    expect(decodeAnyInvite(text)).toEqual({ v: 1, origin: "https://head.example", name: "Head", code: CODE });
  });

  it("makes a version 2 invite that carries the relay identity and no address", () => {
    const text = encodeInvite(relayInvite);
    const body = JSON.parse(Buffer.from(text.slice("seira-link:".length), "base64url").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["v", "name", "code", "e2e"]);
    expect(body.v).toBe(2);
    expect(text.length).toBeLessThan(4_096);
    const decoded = decodeAnyInvite(text);
    expect(decoded).toEqual({ v: 2, name: "Head office", code: CODE, e2e: descriptor, transportKey: Buffer.from(key), hostId });
    expect(decodeInvite(text)).toBeNull();
  });

  it("says so for a version above 2, and for a relay identity of a newer kind", () => {
    expect(decodeAnyInvite(wrap({ v: 3, anything: true }))).toEqual({ v: "newer" });
    expect(decodeAnyInvite(wrap({ v: 99 }))).toEqual({ v: "newer" });
    expect(decodeAnyInvite(wrap({ v: 2, name: "x", code: CODE, e2e: { ...descriptor, v: 2 } }))).toEqual({ v: "newer" });
    expect(decodeInvite(wrap({ v: 3 }))).toBeNull();
  });

  it("refuses a version 2 invite that is not whole", () => {
    const bare = { v: 2, name: "x", code: CODE };
    expect(decodeAnyInvite(wrap(bare))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, e2e: { v: 1, k: descriptor.k } }))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, e2e: { ...descriptor, routes: "local" } }))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, e2e: { ...descriptor, r: ["relay.example.com"] } }))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, e2e: encodeDescriptor(descriptor), extra: 1 }))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, code: "short", e2e: descriptor }))).toBeNull();
    expect(decodeAnyInvite(wrap({ ...bare, origin: "https://x.example", e2e: descriptor }))).toBeNull();
    expect(decodeAnyInvite(wrap({ v: 0 }))).toBeNull();
    expect(decodeAnyInvite("seira-link:not base64!")).toBeNull();
    expect(decodeAnyInvite("hello")).toBeNull();
  });

  it("cleans the name of a version 2 invite", () => {
    const decoded = decodeAnyInvite(encodeInvite({ ...relayInvite, name: "He‮ad\nOffice" }));
    expect(decoded).toMatchObject({ v: 2, name: "He ad Office" });
  });
});

describe("the relay record", () => {
  const route = { v: 1 as const, k: descriptor.k, h: descriptor.h!, r: descriptor.r! };

  it("keeps the limits that keep the relay's admission set small", () => {
    expect([RELAY_LINKS_MAX, RELAY_INVITES_MAX, LINK_DEVICE_PREFIX]).toEqual([4, 2, "link:"]);
    expect(placeholderOrigin(hostId)).toBe(`https://h-${hostId.toString("hex")}.e2e.invalid`);
    expect(new URL(placeholderOrigin(hostId)).hostname.endsWith(".invalid")).toBe(true);
  });

  it("is empty when it is missing, and writes mode 600 apart from links.json", () => {
    const dir = tempDir();
    expect(readRelayLinks(dir)).toEqual({ v: 1, invites: [], hosted: [], joined: {} });
    const id = newLinkId();
    const file = { v: 1 as const, invites: ["a".repeat(64)], hosted: [id], joined: { [newLinkId()]: route } };
    writeRelayLinks(dir, file);
    expect(readRelayLinks(dir)).toEqual(file);
    const path = join(dir, "linked-servers", "relay.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readLinks(dir)).toEqual({ v: 1, links: [], invites: [] });
    expect(() => statSync(join(dir, "linked-servers", "links.json"))).toThrow();
  });

  it("gives an empty value and one log line for a file that does not parse", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "linked-servers"));
    const path = join(dir, "linked-servers", "relay.json");
    const bad: unknown[] = [
      "not json",
      JSON.stringify({ v: 2, invites: [], hosted: [], joined: {} }),
      JSON.stringify({ v: 1, invites: ["a".repeat(64), "b".repeat(64), "c".repeat(64)], hosted: [], joined: {} }),
      JSON.stringify({ v: 1, invites: [], hosted: Array.from({ length: 5 }, newLinkId), joined: {} }),
      JSON.stringify({ v: 1, invites: [], hosted: ["not-an-id"], joined: {} }),
      JSON.stringify({ v: 1, invites: [], hosted: [], joined: { [newLinkId()]: { ...route, r: ["relay.example.com"] } } }),
      JSON.stringify({ v: 1, invites: [], hosted: [], joined: {}, extra: 1 }),
    ];
    for (const text of bad) {
      writeFileSync(path, String(text));
      const lines: string[] = [];
      expect(readRelayLinks(dir, (line) => lines.push(line))).toEqual({ v: 1, invites: [], hosted: [], joined: {} });
      expect(lines).toHaveLength(1);
    }
  });

  it("refuses to write a record that does not fit its limits", () => {
    const dir = tempDir();
    expect(() => writeRelayLinks(dir, { v: 1, invites: [], hosted: Array.from({ length: 5 }, newLinkId), joined: {} })).toThrow();
    expect(() => statSync(join(dir, "linked-servers", "relay.json"))).toThrow();
    writeRelayLinks(dir, { v: 1, invites: [], hosted: [], joined: {} });
    expect(readFileSync(join(dir, "linked-servers", "relay.json"), "utf8")).toBe('{"v":1,"invites":[],"hosted":[],"joined":{}}');
  });
});
