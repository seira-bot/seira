import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignInAllowList } from "./account-signin.ts";
import { createPeopleLimit, PEOPLE_FILE, type PeopleSession } from "./people-limit.ts";
import { TEAM_KEY_ENV, TEAM_KEY_FILE } from "./plan-key.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { DAY, planKeyPair } from "./testing/plan-keys.ts";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const pair = planKeyPair();
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function setup(initial: SignInAllowList, extra: { applies?: boolean; enterprise?: boolean; env?: NodeJS.ProcessEnv; sessions?: PeopleSession[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
  dirs.push(dataDir);
  const state = { lists: initial, sessions: extra.sessions ?? [], clock: NOW, revoked: [] as string[] };
  const people = createPeopleLimit({
    dataDir, env: extra.env ?? {}, publicKeys: [pair.publicKey],
    lists: () => state.lists, sessions: () => state.sessions,
    revoke: (id) => { state.revoked.push(id); state.sessions = state.sessions.filter((session) => session.id !== id); },
    applies: extra.applies ?? true, enterpriseUnlimited: () => extra.enterprise ?? false, now: () => state.clock,
  });
  return { dataDir, state, people };
}

const domain = (...listed: string[]): SignInAllowList => ({ admins: [...listed, "@corp.test"], members: [] });
const named = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}@corp.test`);
const kept = (dataDir: string): string[] => JSON.parse(readFileSync(join(dataDir, PEOPLE_FILE), "utf8")).people;

describe("the free people limit", () => {
  it("AC-01 lets at most 5 distinct email people in on the free plan", () => {
    const { people, dataDir } = setup(domain());
    for (const email of named(5)) expect(people.admit(email)).toBeNull();
    expect(people.admit("P1@Corp.test")).toBeNull();
    expect(people.admit("p6@corp.test")).toBe("full");
    expect(people.refuses("p6@corp.test")).toBe(true);
    expect(people.status()).toMatchObject({ plan: "free", people: 5, limit: 5, full: true });
    expect(kept(dataDir)).toHaveLength(5);
  });

  it("AC-02 does not count a device paired without email or an API token", () => {
    const { people } = setup(domain(...named(4)), { sessions: [{ id: "pair", scopes: ["admin"] }, { id: "tok", token: true, scopes: ["admin"] }] });
    expect(people.status().people).toBe(4);
    expect(people.admit("p5@corp.test")).toBeNull();
    expect(people.admit("p6@corp.test")).toBe("full");
  });

  it("AC-06 frees a place and ends the sessions when a listed address is taken off", () => {
    const { people, state } = setup({ admins: named(5), members: [] }, { sessions: [{ id: "s1", email: "p1@corp.test" }, { id: "s2", email: "p1@corp.test" }, { id: "s3", email: "p2@corp.test" }] });
    const change = people.listsChanging({ admins: named(5).slice(1), members: [] });
    if (!("saved" in change)) throw new Error("a removal is never refused");
    state.lists = { admins: named(5).slice(1), members: [] };
    change.saved();
    expect(state.revoked.sort()).toEqual(["s1", "s2"]);
    expect(people.status().people).toBe(4);
    expect(people.refuses("p1@corp.test")).toBe(false);
  });

  it("AC-06 frees a place and ends the sessions of a joined person that an admin removes", () => {
    const { people, state } = setup(domain());
    for (const email of named(5)) people.admit(email);
    state.sessions = [{ id: "j1", email: "p3@corp.test" }];
    expect(people.admit("p6@corp.test")).toBe("full");
    expect(people.removeJoined("p3@corp.test")).toBe("removed");
    expect(state.revoked).toEqual(["j1"]);
    expect(people.admit("p6@corp.test")).toBeNull();
    expect(people.removeJoined("nobody@corp.test")).toBe("unknown");
    expect(setup(domain("l@corp.test")).people.removeJoined("l@corp.test")).toBe("listed");
  });

  it("AC-07 records everyone on the first start with 7 people and still admits each", () => {
    const seven = named(7);
    const { people, dataDir } = setup({ admins: seven, members: [] });
    expect([...kept(dataDir)].sort()).toEqual([...seven].sort());
    for (const email of seven) expect(people.admit(email)).toBeNull();
    expect(people.status()).toMatchObject({ people: 7, full: true });
  });

  it("AC-08 refuses a new 8th person after the first start with 7", () => {
    const state = setup({ admins: named(7), members: [] });
    state.state.lists = { admins: [...named(7), "@corp.test"], members: [] };
    expect(state.people.refuses("p8@corp.test")).toBe(true);
    expect(state.people.admit("p8@corp.test")).toBe("full");
    expect(state.people.admit("p7@corp.test")).toBeNull();
  });

  it("AC-11 lets any number of people in with a valid key", () => {
    const { people, dataDir } = setup(domain());
    expect(people.saveKey(pair.mint({ issuedAt: NOW, expiresAt: NOW + 90 * DAY }))).toEqual({ ok: true });
    for (const email of named(12)) expect(people.admit(email)).toBeNull();
    expect(people.status()).toMatchObject({ plan: "premium", people: 12, full: false });
    expect(existsSync(join(dataDir, TEAM_KEY_FILE))).toBe(true);
  });

  it("AC-12 keeps people unlimited in the 7 days of grace and refuses only new people after it", () => {
    const { people, state } = setup(domain());
    people.saveKey(pair.mint({ issuedAt: NOW - 30 * DAY, expiresAt: NOW + DAY }));
    for (const email of named(7)) expect(people.admit(email)).toBeNull();
    state.clock = NOW + 4 * DAY;
    expect(people.status()).toMatchObject({ plan: "premium", key: { state: "grace" } });
    expect(people.admit("p8@corp.test")).toBeNull();
    state.clock = NOW + 9 * DAY;
    expect(people.status()).toMatchObject({ plan: "free", key: { state: "ended" } });
    expect(people.admit("p9@corp.test")).toBe("full");
    for (const email of named(7)) expect(people.admit(email)).toBeNull();
    expect(people.admit("p8@corp.test")).toBeNull();
  });

  it("AC-14 lets SEIRA_TEAM_KEY win over the saved key and refuses saving over it", () => {
    const env = { [TEAM_KEY_ENV]: pair.mint({ customer: "Env", issuedAt: NOW, expiresAt: NOW + 90 * DAY }) };
    const { people, dataDir } = setup(domain(), { env });
    writeFileSync(join(dataDir, TEAM_KEY_FILE), pair.mint({ customer: "Saved", issuedAt: NOW, expiresAt: NOW + 90 * DAY }));
    expect(people.status().key).toMatchObject({ source: "environment", customer: "Env" });
    expect(people.saveKey(pair.mint({ issuedAt: NOW, expiresAt: NOW + 90 * DAY }))).toEqual({ ok: false, reason: "environment" });
  });

  it("AC-15 lets any number of people in with an Enterprise people-unlimited entitlement", () => {
    const { people } = setup(domain(), { enterprise: true });
    for (const email of named(9)) expect(people.admit(email)).toBeNull();
    expect(people.status()).toMatchObject({ plan: "unlimited", full: false });
  });

  it("AC-16 never refuses where the server does not decide who comes in", () => {
    const { people, dataDir } = setup(domain(), { applies: false });
    for (const email of named(9)) expect(people.admit(email)).toBeNull();
    expect(people.refuses("p10@corp.test")).toBe(false);
    expect(people.status()).toMatchObject({ applies: false, full: false });
    expect(existsSync(join(dataDir, PEOPLE_FILE))).toBe(false);
  });

  it("AC-17 uses the free plan and admits existing people when the saved key cannot be read", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, TEAM_KEY_FILE));
    const lists = domain(...named(7));
    const people = createPeopleLimit({ dataDir, env: {}, publicKeys: [pair.publicKey], lists: () => lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false, now: () => NOW });
    expect(people.status()).toMatchObject({ plan: "free", key: { state: "unreadable" } });
    for (const email of named(7)) expect(people.admit(email)).toBeNull();
    expect(people.admit("new@corp.test")).toBe("full");
  });

  it("AC-18 never calls the network for a check, a save or a status", () => {
    const fetchStub = vi.fn(() => { throw new Error("network used"); });
    vi.stubGlobal("fetch", fetchStub);
    const { people } = setup(domain());
    people.saveKey(pair.mint({ issuedAt: NOW, expiresAt: NOW + DAY }));
    people.refuses("a@corp.test");
    people.admit("a@corp.test");
    people.status();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
