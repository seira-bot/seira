import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPlanKey, premiumKeyStatus, premiumUnlimited, savePlanKey, TEAM_KEY_ENV, TEAM_KEY_FILE } from "./plan-key.ts";
import { DAY, planKeyPair } from "./testing/plan-keys.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const dirs: string[] = [];
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "seira-plan-key-")); dirs.push(dir); return dir; };
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("Premium key check", () => {
  const pair = planKeyPair();
  const valid = pair.mint({ issuedAt: NOW - DAY, expiresAt: NOW + 90 * DAY });

  it("AC-09 saves a valid key to the data folder with owner-only mode", () => {
    const dir = folder();
    expect(savePlanKey({ dataDir: dir, env: {}, publicKeys: [pair.publicKey] }, ` ${valid.slice(0, 20)}\n${valid.slice(20)} `, NOW).ok).toBe(true);
    const file = join(dir, TEAM_KEY_FILE);
    expect(readFileSync(file, "utf8").trim()).toBe(valid);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("AC-10 refuses a bad signature, an unknown format and another product, and keeps the saved key", () => {
    const dir = folder();
    const options = { dataDir: dir, env: {}, publicKeys: [pair.publicKey] };
    expect(savePlanKey(options, valid, NOW).ok).toBe(true);
    const other = planKeyPair();
    const forged = other.mint({ issuedAt: NOW, expiresAt: NOW + DAY });
    const otherProduct = pair.mint({ product: "something-else", issuedAt: NOW, expiresAt: NOW + 90 * DAY });
    expect(savePlanKey(options, forged, NOW)).toEqual({ ok: false, reason: "signature" });
    expect(savePlanKey(options, "not a key", NOW)).toEqual({ ok: false, reason: "format" });
    expect(savePlanKey(options, "seira-team.abc.def", NOW)).toEqual({ ok: false, reason: "format" });
    expect(savePlanKey(options, otherProduct, NOW)).toEqual({ ok: false, reason: "product" });
    expect(readFileSync(join(dir, TEAM_KEY_FILE), "utf8").trim()).toBe(valid);
    expect(checkPlanKey(valid, [other.publicKey])).toEqual({ ok: false, reason: "signature" });
  });

  it("AC-10 refuses the Seira Cloud self-test sample, which the production key signs for another product", () => {
    // Published by Seira Cloud for clients to check their verifier; it expired in 1970 and unlocks nothing.
    const sample = "seira-team.eyJ2IjoxLCJwcm9kdWN0Ijoic2VpcmEtY2xvdWQtc2VsZnRlc3QiLCJjdXN0b21lciI6InNlbGZ0ZXN0IiwiaXNzdWVkQXQiOiIxOTcwLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJleHBpcmVzQXQiOiIxOTcwLTAxLTAxVDAwOjAwOjAwLjAwMFoifQ.TnvwLJcL7IdTlh4dA2pZ8rh2pboZgZh6AvpUA6cw947BgWLe8l9UjRaqPfbUmXoyAqdhhOue2GpwwfBqWTELCw";
    expect(checkPlanKey(sample)).toEqual({ ok: false, reason: "product" });
    expect(checkPlanKey(sample, [planKeyPair().publicKey])).toEqual({ ok: false, reason: "signature" });
    expect(savePlanKey({ dataDir: folder(), env: {} }, sample, NOW)).toEqual({ ok: false, reason: "product" });
  });

  it("AC-12 reads active, ending soon, grace and ended states from a fixed clock", () => {
    const key = pair.mint({ issuedAt: NOW - 100 * DAY, expiresAt: NOW });
    const dir = folder();
    writeFileSync(join(dir, TEAM_KEY_FILE), key);
    const at = (now: number) => premiumKeyStatus({ dataDir: dir, env: {}, publicKeys: [pair.publicKey] }, now);
    expect(at(NOW - 60 * DAY)?.state).toBe("active");
    expect(at(NOW - 10 * DAY)?.state).toBe("endingSoon");
    expect(at(NOW + 3 * DAY)?.state).toBe("grace");
    expect(at(NOW + 8 * DAY)?.state).toBe("ended");
    expect(premiumUnlimited(at(NOW + 3 * DAY))).toBe(true);
    expect(premiumUnlimited(at(NOW + 8 * DAY))).toBe(false);
  });

  it("AC-14 lets the environment key win over the saved key", () => {
    const dir = folder();
    writeFileSync(join(dir, TEAM_KEY_FILE), pair.mint({ customer: "Saved", issuedAt: NOW, expiresAt: NOW + 90 * DAY }));
    const fromEnv = pair.mint({ customer: "From Env", issuedAt: NOW, expiresAt: NOW + 90 * DAY });
    const status = premiumKeyStatus({ dataDir: dir, env: { [TEAM_KEY_ENV]: fromEnv }, publicKeys: [pair.publicKey] }, NOW);
    expect(status).toMatchObject({ source: "environment", customer: "From Env" });
  });

  it("AC-18 never calls the network to check, save or read a key", () => {
    const fetchStub = vi.fn(() => { throw new Error("network used"); });
    vi.stubGlobal("fetch", fetchStub);
    const dir = folder();
    const options = { dataDir: dir, env: {}, publicKeys: [pair.publicKey] };
    checkPlanKey(valid, [pair.publicKey]);
    savePlanKey(options, valid, NOW);
    expect(premiumKeyStatus(options, NOW)?.state).toBe("active");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("AC-18 keeps the key check source free of network modules and fetch calls", () => {
    const source = readFileSync(new URL("./plan-key.ts", import.meta.url), "utf8");
    for (const module of ["node:http", "node:https", "node:net", "node:dns"]) expect(source).not.toContain(`"${module}"`);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
