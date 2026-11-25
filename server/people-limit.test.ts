import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignInAllowList } from "./account-signin.ts";
import { applySignIn } from "./fleet.ts";
import { accessChange, createPeopleLimit, PEOPLE_FILE, peopleLimitApplies, type PeopleSession } from "./people-limit.ts";
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

/** `earlier`: a data folder an earlier version used, which has its messages database. */
function setup(initial: SignInAllowList, extra: { applies?: boolean; enterprise?: boolean; env?: NodeJS.ProcessEnv; sessions?: PeopleSession[]; earlier?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
  dirs.push(dataDir);
  if (extra.earlier) writeFileSync(join(dataDir, "messages.db"), "");
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
    const { people } = setup(domain(...named(4)), { earlier: true, sessions: [{ id: "pair", scopes: ["admin"] }, { id: "tok", token: true, scopes: ["admin"] }] });
    expect(people.status().people).toBe(4);
    expect(people.admit("p5@corp.test")).toBeNull();
    expect(people.admit("p6@corp.test")).toBe("full");
  });

  it("AC-06 frees a place and ends the sessions when a listed address is taken off", () => {
    const { people, state } = setup({ admins: named(5), members: [] }, { earlier: true, sessions: [{ id: "s1", email: "p1@corp.test" }, { id: "s2", email: "p1@corp.test" }, { id: "s3", email: "p2@corp.test" }] });
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

  it("AC-07 records everyone on the first start of an earlier data folder with 7 people and still admits each", () => {
    const seven = named(7);
    const { people, dataDir } = setup({ admins: seven, members: [] }, { earlier: true });
    expect([...kept(dataDir)].sort()).toEqual([...seven].sort());
    for (const email of seven) expect(people.admit(email)).toBeNull();
    expect(people.status()).toMatchObject({ people: 7, full: true });
  });

  it("AC-08 refuses a new 8th person after the first start with 7", () => {
    const state = setup({ admins: named(7), members: [] }, { earlier: true });
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
    writeFileSync(join(dataDir, "messages.db"), "");
    const lists = domain(...named(7));
    const people = createPeopleLimit({ dataDir, env: {}, publicKeys: [pair.publicKey], lists: () => lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false, now: () => NOW });
    expect(people.status()).toMatchObject({ plan: "free", key: { state: "unreadable" } });
    for (const email of named(7)) expect(people.admit(email)).toBeNull();
    expect(people.admit("new@corp.test")).toBe("full");
  });

  it("AC-07 gives a new data folder no places for a long list: the first 5 to sign in get them", () => {
    const { people, dataDir } = setup({ admins: named(20), members: [] });
    expect(kept(dataDir)).toEqual([]);
    for (const email of named(5)) expect(people.admit(email)).toBeNull();
    expect(people.admit("p6@corp.test")).toBe("full");
    expect(people.status()).toMatchObject({ people: 5, full: true });
  });

  it("AC-08 refuses addresses that only the environment lists once 5 people hold places", () => {
    const { people, state } = setup({ admins: named(3), members: [] });
    for (const email of named(3)) expect(people.admit(email)).toBeNull();
    // A restart with SEIRA_SIGNIN_MEMBER_EMAILS set: these addresses hold no place until they sign in.
    state.lists = { admins: named(3), members: named(8).slice(3) };
    expect(people.status().people).toBe(3);
    expect(people.admit("p4@corp.test")).toBeNull();
    expect(people.admit("p5@corp.test")).toBeNull();
    for (const email of ["p6@corp.test", "p7@corp.test", "p8@corp.test"]) {
      expect(people.refuses(email)).toBe(true);
      expect(people.admit(email)).toBe("full");
    }
    expect(people.status()).toMatchObject({ people: 5, full: true });
  });

  it("AC-08 refuses an address that `seira fleet users add` lists once 5 people hold places", () => {
    const { people, state } = setup({ admins: named(5), members: [] }, { earlier: true });
    const config = applySignIn(JSON.stringify({ signIn: state.lists }), "add", "p6@corp.test", true).config;
    state.lists = JSON.parse(config).signIn;
    expect(state.lists.members).toEqual(["p6@corp.test"]);
    expect(people.admit("p6@corp.test")).toBe("full");
    expect(people.removeJoined("p6@corp.test")).toBe("listed");
    state.lists = { ...state.lists, admins: named(4) };
    expect(people.admit("p6@corp.test")).toBeNull();
  });

  it("AC-08 drops the place of an address taken off, so listing it again after a sixth person joined is refused", () => {
    const { people, state, dataDir } = setup({ admins: named(5), members: [] }, { earlier: true });
    const fleet = (action: "add" | "remove", email: string) => { state.lists = JSON.parse(applySignIn(JSON.stringify({ signIn: state.lists }), action, email, false).config).signIn; };
    fleet("remove", "p5@corp.test");
    fleet("add", "p6@corp.test");
    expect(people.admit("p6@corp.test")).toBeNull();
    expect([...kept(dataDir)].sort()).toEqual([...named(4), "p6@corp.test"]);
    fleet("add", "p5@corp.test");
    expect(people.refuses("p5@corp.test")).toBe(true);
    expect(people.admit("p5@corp.test")).toBe("full");
    expect(people.status()).toMatchObject({ people: 5, full: true });
  });

  it("AC-08 drops the places of a swapped @domain entry, so listing both domains lets nobody past five", () => {
    const at = (domainName: string, count: number) => Array.from({ length: count }, (_, index) => `x${index + 1}@${domainName}`);
    const { people, state } = setup({ admins: ["@a.test"], members: [] });
    for (const email of at("a.test", 5)) expect(people.admit(email)).toBeNull();
    state.lists = { admins: ["@b.test"], members: [] };
    for (const email of at("b.test", 5)) expect(people.admit(email)).toBeNull();
    state.lists = { admins: ["@a.test", "@b.test"], members: [] };
    expect(people.admit("x1@a.test")).toBe("full");
    expect(people.status()).toMatchObject({ people: 5 });
  });

  it("drops a kept address the lists no longer let in when it starts, but never on empty lists", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
    dirs.push(dataDir);
    writeFileSync(join(dataDir, PEOPLE_FILE), JSON.stringify({ version: 1, people: named(5) }));
    const start = (lists: SignInAllowList) => createPeopleLimit({ dataDir, env: {}, lists: () => lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false });
    start({ admins: [], members: [] });
    expect(kept(dataDir)).toEqual(named(5));
    start({ admins: named(4), members: [] });
    expect(kept(dataDir)).toEqual(named(4));
  });

  it("keeps a removed joined person out of an @domain entry, on the free plan and with a key", () => {
    for (const enterprise of [false, true]) {
      const { people } = setup(domain(), { enterprise });
      for (const email of named(3)) people.admit(email);
      expect(people.wasRemoved("p3@corp.test")).toBe(false);
      expect(people.removeJoined("p3@corp.test")).toBe("removed");
      expect(people.wasRemoved("p3@corp.test")).toBe(true);
      expect(people.wasRemoved("  P3@Corp.test ")).toBe(true);
      expect(people.wasRemoved("p2@corp.test")).toBe(false);
      expect(people.status().joined.map((person) => person.email)).toEqual(["p1@corp.test", "p2@corp.test"]);
    }
  });

  it("remembers a removed person after a restart of the server", () => {
    const { people, state, dataDir } = setup(domain());
    people.admit("p1@corp.test");
    people.removeJoined("p1@corp.test");
    const again = createPeopleLimit({ dataDir, env: {}, publicKeys: [pair.publicKey], lists: () => state.lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false, now: () => NOW });
    expect(again.wasRemoved("p1@corp.test")).toBe(true);
  });

  it("lets a removed person in again once an admin lists the address itself", () => {
    const { people, state } = setup(domain());
    people.admit("p1@corp.test");
    people.removeJoined("p1@corp.test");
    const lists = domain("p1@corp.test");
    const change = people.listsChanging(lists);
    if (!("saved" in change)) throw new Error("room for one more");
    state.lists = lists;
    change.saved();
    expect(people.wasRemoved("p1@corp.test")).toBe(false);
    // Taken off the list again, the address is a plain @domain person with no bar.
    state.lists = domain();
    expect(people.wasRemoved("p1@corp.test")).toBe(false);
  });

  it("lets a removed person in again through `seira access add`", async () => {
    const { people, dataDir } = setup(domain());
    people.admit("p1@corp.test");
    people.removeJoined("p1@corp.test");
    const change = await accessChange(dataDir, domain(), domain("p1@corp.test"), {});
    if (typeof change === "string") throw new Error(change);
    change.saved();
    expect(readFileSync(join(dataDir, "sign-in-removed.json"), "utf8")).not.toContain("p1@corp.test");
  });

  it("does not bar anybody where the server does not decide who comes in", () => {
    const { people } = setup(domain(), { applies: false });
    expect(people.wasRemoved("p1@corp.test")).toBe(false);
  });

  it("AC-03 gives an address that Settings adds its place at once", () => {
    const { people, state, dataDir } = setup({ admins: named(1), members: [] });
    expect(people.admit("p1@corp.test")).toBeNull();
    const change = people.listsChanging({ admins: named(3), members: [] });
    if (!("saved" in change)) throw new Error("room for two more");
    state.lists = { admins: named(3), members: [] };
    change.saved();
    expect([...kept(dataDir)].sort()).toEqual(named(3));
    state.lists = { admins: [...named(3), "@corp.test"], members: [] };
    expect(people.admit("j1@corp.test")).toBeNull();
    expect(people.admit("j2@corp.test")).toBeNull();
    expect(people.admit("j3@corp.test")).toBe("full");
    expect("refusal" in people.listsChanging({ admins: [...named(4), "@corp.test"], members: [] })).toBe(true);
  });

  it("AC-17 never writes over a sign-in-people.json it cannot read and keeps everyone listed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
    dirs.push(dataDir);
    const file = join(dataDir, PEOPLE_FILE);
    writeFileSync(file, "{ not json");
    const lists = domain(...named(7));
    const sessions: PeopleSession[] = [{ id: "j", email: "joined@corp.test" }];
    const people = createPeopleLimit({ dataDir, env: {}, publicKeys: [pair.publicKey], lists: () => lists, sessions: () => sessions, revoke() {}, applies: true, enterpriseUnlimited: () => false, now: () => NOW });
    for (const email of named(7)) expect(people.admit(email)).toBeNull();
    expect(people.admit("new@corp.test")).toBe("full");
    expect(people.removeJoined("joined@corp.test")).toBe("removed");
    const change = people.listsChanging({ admins: [...named(6), "@corp.test"], members: [] });
    if ("saved" in change) change.saved();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("applies the limit in the CLI as the server does, also under another SEIRA_CLOUD_ROLE", async () => {
    expect(peopleLimitApplies({})).toBe(true);
    expect(peopleLimitApplies({ SEIRA_CLOUD_ROLE: "x" })).toBe(true);
    expect(peopleLimitApplies({ SEIRA_CLOUD_ROLE: "home" })).toBe(false);
    expect(peopleLimitApplies({ SEIRA_CLOUD_ROLE: "team" })).toBe(false);
    expect(peopleLimitApplies({ SEIRA_ADMIN_URL: "https://admin.example.test" })).toBe(false);
    const dataDir = mkdtempSync(join(tmpdir(), "seira-people-"));
    dirs.push(dataDir);
    const env = { SEIRA_CLOUD_ROLE: "x" };
    let admins: string[] = [];
    for (const email of named(5)) {
      const change = await accessChange(dataDir, { admins, members: [] }, { admins: [...admins, email], members: [] }, env);
      if (typeof change === "string") throw new Error(change);
      change.saved();
      admins = [...admins, email];
    }
    // Before the server's first start on this version, everyone listed counts and the file is left for that start.
    expect(existsSync(join(dataDir, PEOPLE_FILE))).toBe(false);
    expect(await accessChange(dataDir, { admins, members: [] }, { admins: [...admins, "p6@corp.test"], members: [] }, env)).toMatch(/free plan includes 5 people/);
  });

  it("never drops a place in the CLI, which cannot see the server's environment lists", async () => {
    // The server let j1 and j2 in through SEIRA_SIGNIN_EMAILS=@corp.test; the CLI runs without that variable.
    const { dataDir, people } = setup({ admins: ["p1@corp.test", "@corp.test"], members: [] });
    for (const email of ["p1@corp.test", "j1@corp.test", "j2@corp.test"]) expect(people.admit(email)).toBeNull();
    const add = async (admins: string[], email: string) => accessChange(dataDir, { admins, members: [] }, { admins: [...admins, email], members: [] }, {});
    const change = await add(["p1@corp.test"], "p2@corp.test");
    if (typeof change === "string") throw new Error(change);
    change.saved();
    expect([...kept(dataDir)].sort()).toEqual(["j1@corp.test", "j2@corp.test", "p1@corp.test", "p2@corp.test"]);
    const fifth = await add(["p1@corp.test", "p2@corp.test"], "p3@corp.test");
    if (typeof fifth === "string") throw new Error(fifth);
    fifth.saved();
    expect(await add(["p1@corp.test", "p2@corp.test", "p3@corp.test"], "p4@corp.test")).toMatch(/free plan includes 5 people/);
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
