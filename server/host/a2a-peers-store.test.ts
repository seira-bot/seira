import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  A2A_TOKEN_PREFIX, URL_MAX, a2aPeerIds, linksFull, linksInUse, newA2aToken, outboundUrl, peerByToken, readA2aPeers, writeA2aPeers,
  type A2aPeer, type A2aPeersFile,
} from "./a2a-peers-store.ts";
import { LINKS_MAX, linkedServersDir, writeLinks, type LinksFile } from "./linked-servers-store.ts";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "a2a-peers-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const peer = (id: string, over: Partial<A2aPeer> = {}): A2aPeer => ({
  id, name: "Partner agent", url: "https://agent.example/", exposed: ["writer"], cap: "ask", createdAt: 1_000, ...over,
});
const hexId = (n: number) => n.toString(16).padStart(16, "0");
const filePath = (dataDir: string) => join(linkedServersDir(dataDir), "a2a-peers.json");
const rawFile = (dataDir: string, body: unknown) => {
  mkdirSync(linkedServersDir(dataDir), { recursive: true });
  writeFileSync(filePath(dataDir), typeof body === "string" ? body : JSON.stringify(body));
};

describe("the inbound token (AC-01)", () => {
  it("is lsa_ and 32 random bytes, and its hash is the sha256 of the whole token", () => {
    const one = newA2aToken(), two = newA2aToken();
    expect(one.token).toMatch(/^lsa_[A-Za-z0-9_-]{43}$/u);
    expect(one.token.startsWith(A2A_TOKEN_PREFIX)).toBe(true);
    expect(one.hash).toBe(createHash("sha256").update(one.token).digest("hex"));
    expect(two.token).not.toBe(one.token);
  });

  it("is stored only as its hash", () => {
    const dataDir = tempDir();
    const { token, hash } = newA2aToken();
    writeA2aPeers(dataDir, { v: 1, peers: [peer(hexId(1), { tokenHash: hash })] });
    for (const name of readdirSync(linkedServersDir(dataDir))) {
      const text = readFileSync(join(linkedServersDir(dataDir), name), "utf8");
      expect(text).not.toContain(token);
      expect(text).not.toContain(token.slice(A2A_TOKEN_PREFIX.length));
    }
    expect(readFileSync(filePath(dataDir), "utf8")).toContain(hash);
  });

  it("finds its peer, and no other token does", () => {
    const one = newA2aToken(), two = newA2aToken(), other = newA2aToken();
    const file: A2aPeersFile = { v: 1, peers: [peer(hexId(1), { tokenHash: one.hash }), peer(hexId(2), { tokenHash: two.hash }), peer(hexId(3))] };
    expect(peerByToken(file, one.token)?.id).toBe(hexId(1));
    expect(peerByToken(file, two.token)?.id).toBe(hexId(2));
    expect(peerByToken(file, other.token)).toBeUndefined();
    expect(peerByToken(file, `lsk_${one.token.slice(4)}`)).toBeUndefined();
    expect(peerByToken(file, one.hash)).toBeUndefined();
    expect(peerByToken(file, "")).toBeUndefined();
    expect(peerByToken(file, undefined)).toBeUndefined();
  });
});

describe("the record", () => {
  it("is mode 600 in a folder of mode 700, and reads back as written", () => {
    const dataDir = tempDir();
    const file: A2aPeersFile = { v: 1, peers: [peer(hexId(1), { tokenHash: "a".repeat(64), endpoint: "https://agent.example/rpc" })] };
    writeA2aPeers(dataDir, file);
    expect(statSync(filePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(linkedServersDir(dataDir)).mode & 0o777).toBe(0o700);
    expect(readA2aPeers(dataDir)).toEqual(file);
  });

  it("leaves links.json byte for byte as it was when peers are added, changed and removed (AC-02)", () => {
    const dataDir = tempDir();
    const links: LinksFile = { v: 1, links: [{ id: hexId(9), role: "inviter", place: { id: "far", name: "Far" }, exposed: [], cap: "ask", tokenHash: "b".repeat(64), createdAt: 5 }], invites: [] };
    writeLinks(dataDir, links);
    const before = readFileSync(join(linkedServersDir(dataDir), "links.json"));
    writeA2aPeers(dataDir, { v: 1, peers: [peer(hexId(1))] });
    writeA2aPeers(dataDir, { v: 1, peers: [peer(hexId(1), { name: "Renamed" }), peer(hexId(2), { tokenHash: newA2aToken().hash, url: undefined })] });
    writeA2aPeers(dataDir, { v: 1, peers: [] });
    expect(readFileSync(join(linkedServersDir(dataDir), "links.json")).equals(before)).toBe(true);
  });

  it("reads as empty, with one log line, when it is not JSON or not this version", () => {
    for (const body of ["{not json", JSON.stringify({ v: 2, peers: [] }), JSON.stringify({ v: 1 }), JSON.stringify([])]) {
      const dataDir = tempDir(), logs: string[] = [];
      rawFile(dataDir, body);
      expect(readA2aPeers(dataDir, (line) => logs.push(line))).toEqual({ v: 1, peers: [] });
      expect(logs).toHaveLength(1);
    }
  });

  it("reads as empty and logs nothing when there is no record", () => {
    const logs: string[] = [];
    expect(readA2aPeers(tempDir(), (line) => logs.push(line))).toEqual({ v: 1, peers: [] });
    expect(logs).toEqual([]);
  });

  it("keeps a peer with a field it does not know, and drops that field", () => {
    const dataDir = tempDir();
    rawFile(dataDir, { v: 1, peers: [{ ...peer(hexId(1)), later: { anything: true } }], more: 1 });
    expect(readA2aPeers(dataDir).peers).toEqual([peer(hexId(1))]);
  });

  it("drops each peer whose known fields are wrong, and keeps the rest", () => {
    const dataDir = tempDir(), logs: string[] = [];
    const bad: unknown[] = [
      { ...peer("not-hex") },
      { ...peer(hexId(2)), name: "" },
      { ...peer(hexId(3)), name: "Bad‮name" },
      { ...peer(hexId(4)), url: "http://agent.example/" },
      { ...peer(hexId(5)), url: undefined, tokenHash: undefined },
      { ...peer(hexId(6)), tokenHash: "XYZ" },
      { ...peer(hexId(7)), endpoint: "https://elsewhere.example/rpc" },
      { ...peer(hexId(8)), cap: "full" },
      { ...peer(hexId(9)), exposed: ["../etc"] },
      { ...peer(hexId(10)), url: "https://user:pass@agent.example/" },
      "a string",
    ];
    rawFile(dataDir, { v: 1, peers: [peer(hexId(1)), ...bad, peer(hexId(1), { name: "Second copy" }), peer(hexId(11))] });
    expect(readA2aPeers(dataDir, (line) => logs.push(line)).peers.map((one) => one.id)).toEqual([hexId(1), hexId(11)]);
    expect(readA2aPeers(dataDir).peers[0]!.name).toBe("Partner agent");
    expect(logs).toHaveLength(1);
  });

  it("keeps at most LINKS_MAX peers, and refuses to write more", () => {
    const dataDir = tempDir();
    const many = Array.from({ length: LINKS_MAX + 3 }, (_, n) => peer(hexId(n + 1)));
    rawFile(dataDir, { v: 1, peers: many });
    expect(readA2aPeers(dataDir).peers).toHaveLength(LINKS_MAX);
    expect(() => writeA2aPeers(dataDir, { v: 1, peers: many })).toThrow();
  });

  it("refuses to write a peer that does not parse", () => {
    expect(() => writeA2aPeers(tempDir(), { v: 1, peers: [peer(hexId(1), { url: "ftp://agent.example/" })] })).toThrow();
  });
});

describe("counting against the shared maximum (AC-03 support)", () => {
  it("counts stage 1 links and A2A peers together", () => {
    const file: A2aPeersFile = { v: 1, peers: Array.from({ length: 5 }, (_, n) => peer(hexId(n + 1))) };
    expect(linksInUse(Array.from({ length: 14 }), file)).toBe(19);
    expect(linksFull(Array.from({ length: 14 }), file)).toBe(false);
    expect(linksFull(Array.from({ length: 15 }), file)).toBe(true);
    expect(a2aPeerIds(file)).toEqual([1, 2, 3, 4, 5].map(hexId));
  });
});

describe("an outbound address (AC-30, the parts that need no DNS)", () => {
  it("takes https at a public host or address, and drops the fragment", () => {
    expect(outboundUrl("https://agent.example/a2a", false)?.href).toBe("https://agent.example/a2a");
    expect(outboundUrl("  https://agent.example/card#part ", false)?.href).toBe("https://agent.example/card");
    expect(outboundUrl("https://8.8.8.8/", false)?.href).toBe("https://8.8.8.8/");
  });

  it("refuses another scheme, a credential, and plain http to a public host", () => {
    for (const raw of ["http://agent.example/", "ftp://agent.example/", "file:///etc/passwd", "https://user@agent.example/", "https://:secret@agent.example/", "not a url", ""]) {
      expect(outboundUrl(raw, false)).toBeNull();
      expect(outboundUrl(raw, true)).toBeNull();
    }
  });

  it("refuses a private or reserved address literal, with or without the test switch", () => {
    for (const raw of ["https://10.0.0.1/", "https://192.168.1.10/", "https://172.16.0.1/", "https://169.254.169.254/", "https://[fd00::1]/", "https://0.0.0.0/", "https://[::]/"]) {
      expect(outboundUrl(raw, false)).toBeNull();
      expect(outboundUrl(raw, true)).toBeNull();
    }
  });

  it("takes loopback, over http too, only under the test switch", () => {
    for (const raw of ["http://127.0.0.1:4000/", "https://127.0.0.1/", "http://localhost:4000/", "http://[::1]:4000/"]) {
      expect(outboundUrl(raw, false)).toBeNull();
      expect(outboundUrl(raw, true)).not.toBeNull();
    }
  });

  it("refuses an address over URL_MAX", () => {
    expect(outboundUrl(`https://agent.example/${"a".repeat(URL_MAX)}`, false)).toBeNull();
  });
});
