import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { ADMIT, BUSY_TEXT, createAdmission, createRefusalRecord } from "./linked-servers-admit.ts";
import { INVITE_TTL_MS, addInvite, cleanName, decodeInvite, encodeInvite, guestOrigin, hashSecret, liveInvite, pruneInvites, readLinks, writeLinks, type LinksFile } from "./linked-servers-store.ts";

const dirs: string[] = [];
const tempDir = (label = "store") => { const dir = mkdtempSync(join(tmpdir(), `linked-servers-${label}-`)); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

describe("the link record", () => {
  it("keeps an invite as a hash, good once and for fifteen minutes", () => {
    const file: LinksFile = { v: 1, links: [], invites: [] };
    const start = 1_000_000;
    const { code, expiresAt } = addInvite(file, start);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expiresAt).toBe(start + INVITE_TTL_MS);
    expect(JSON.stringify(file)).not.toContain(code);
    expect(file.invites[0]!.hash).toBe(hashSecret(code));

    expect(liveInvite(file, code, start + INVITE_TTL_MS - 1)).toBeDefined();
    expect(liveInvite(file, code, start + INVITE_TTL_MS)).toBeUndefined();
    expect(liveInvite(file, "x".repeat(43), start)).toBeUndefined();
    expect(liveInvite(file, `${code}=`, start)).toBeUndefined();

    liveInvite(file, code, start + 1)!.usedAt = start + 1;
    expect(liveInvite(file, code, start + 2)).toBeUndefined();
    pruneInvites(file, start + 2);
    expect(file.invites).toEqual([]);

    const late = addInvite(file, start);
    pruneInvites(file, start + INVITE_TTL_MS);
    expect(liveInvite(file, late.code, start)).toBeUndefined();
    expect(file.invites).toEqual([]);
  });

  it("writes mode 600 and reads back only a record that parses", () => {
    const dir = tempDir();
    expect(readLinks(dir)).toEqual({ v: 1, links: [], invites: [] });
    const file: LinksFile = { v: 1, invites: [], links: [{ id: "0123456789abcdef", role: "inviter", place: { id: "far", name: "Far" }, exposed: ["writer"], cap: "ask", tokenHash: hashSecret("lsk_x"), createdAt: 1 }] };
    writeLinks(dir, file);
    const path = join(dir, "linked-servers", "links.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readLinks(dir)).toEqual(file);
    expect(readFileSync(path, "utf8")).not.toContain("lsk_x");

    const lines: string[] = [];
    writeLinks(dir, { ...file, links: [{ ...file.links[0]!, tokenHash: undefined }] } as LinksFile);
    expect(readLinks(dir, (line) => lines.push(line)).links).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("reads back an invite it wrote, and refuses any other text", () => {
    const text = encodeInvite({ origin: "https://a.example", name: "Head office", code: "A".repeat(43) });
    expect(text.startsWith("seira-link:")).toBe(true);
    expect(decodeInvite(`  ${text}\n`)).toEqual({ origin: "https://a.example", name: "Head office", code: "A".repeat(43) });
    expect(decodeInvite(text.replace("seira-link:", "other:"))).toBeNull();
    expect(decodeInvite(`${text}!`)).toBeNull();
    expect(decodeInvite(`seira-link:${Buffer.from(JSON.stringify({ v: 1, origin: "https://a.example", name: "A", code: "short" })).toString("base64url")}`)).toBeNull();
    expect(decodeInvite(`seira-link:${Buffer.from(JSON.stringify({ v: 1, origin: "https://a.example", name: "A", code: "A".repeat(43), more: 1 })).toString("base64url")}`)).toBeNull();
  });

  it("asks another server only at https or at this machine's loopback", () => {
    expect(guestOrigin("https://a.example/path")).toBe("https://a.example");
    expect(guestOrigin("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123");
    expect(guestOrigin("http://localhost:8123")).toBe("http://localhost:8123");
    expect(guestOrigin("http://[::1]:8123")).toBe("http://[::1]:8123");
    expect(guestOrigin("http://192.168.1.4:8123")).toBeNull();
    expect(guestOrigin("http://a.example")).toBeNull();
    expect(guestOrigin("https://user:pass@a.example")).toBeNull();
    expect(guestOrigin("ftp://a.example")).toBeNull();
    expect(guestOrigin("not an address")).toBeNull();
  });

  it("keeps a far name to one clean line", () => {
    expect(cleanName("  Head\noffice\u0007 ‮evil  ")).toBe("Head office evil");
    expect(Array.from(cleanName("😀".repeat(200)))).toHaveLength(120);
    expect(cleanName("\n\t")).toBe("");
  });
});

describe("admission", () => {
  it("refuses at eight open hand-offs, and after thirty admitted in a sliding minute", () => {
    let now = 0;
    const admission = createAdmission(() => now);
    expect(admission.admit("a", ADMIT.open)).toBe(BUSY_TEXT);
    expect(BUSY_TEXT).not.toMatch(/\d/u);
    for (let index = 0; index < ADMIT.perWindow; index++) { now = index * 1_000; expect(admission.admit("a", 0)).toBeNull(); }
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    expect(admission.admit("b", 0)).toBeNull();
    now = ADMIT.windowMs - 1;
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    now = ADMIT.windowMs;
    expect(admission.admit("a", 0)).toBeNull();
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    admission.forget("a");
    expect(admission.admit("a", 0)).toBeNull();
  });

  it("writes one row a minute for refusals over the limits, with their count", () => {
    let now = 0;
    const rows: Array<[string, string, number]> = [];
    const record = createRefusalRecord((linkId, reason, count) => rows.push([linkId, reason, count]), () => now);
    for (let index = 0; index < 5; index++) record.refused("a", "limit");
    record.refused("a", "bot");
    record.refused("b", "limit");
    expect(rows).toEqual([["a", "limit", 1], ["a", "bot", 1], ["b", "limit", 1]]);
    now = ADMIT.windowMs;
    record.refused("a", "limit");
    expect(rows.at(-1)).toEqual(["a", "limit", 5]);
  });
});
