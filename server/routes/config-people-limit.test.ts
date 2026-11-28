import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignInAllowList } from "../account-signin.ts";
import { DATA_DIR } from "../config.ts";
import { createPeopleLimit, PEOPLE_FILE, type PeopleLimit, type PeopleSession } from "../people-limit.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

// saveConfig writes to DATA_DIR, the throwaway home of this test file; each test starts it again.
const FILES = ["config.json", "messages.db", PEOPLE_FILE];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of FILES) rmSync(join(DATA_DIR, name), { force: true });
});

const names = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}@corp.test`);

interface PutOptions {
  /** The people sign-in-people.json names before the save. */
  kept?: string[];
  /** More of the same save, with the config it starts from. */
  patch?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** Answers the per-bot Local VM count, an await between the first check and the save. */
  perBotVms?: (people: PeopleLimit) => Promise<number>;
}

async function putSignIn(signIn: SignInAllowList, current: SignInAllowList, sessions: PeopleSession[] = [], options: PutOptions = {}) {
  const home = DATA_DIR;
  mkdirSync(home, { recursive: true });
  vi.stubEnv("SEIRA_SIGNIN_EMAILS", "");
  vi.stubEnv("SEIRA_SIGNIN_MEMBER_EMAILS", "");
  const file = join(home, "config.json");
  writeFileSync(file, `${JSON.stringify({ ...options.config, signIn: current })}\n`);
  const before = readFileSync(file, "utf8");
  // A data folder an earlier version used: everyone listed in config.json holds a place from the first start.
  writeFileSync(join(home, "messages.db"), "");
  if (options.kept) writeFileSync(join(home, PEOPLE_FILE), `${JSON.stringify({ version: 1, people: options.kept })}\n`, { mode: 0o600 });
  const state = { sessions, revoked: [] as string[] };
  // The lists in force are the saved ones, as the server reads them again after a save.
  const lists = (): SignInAllowList => {
    const saved = (JSON.parse(readFileSync(file, "utf8")) as { signIn?: Partial<SignInAllowList> }).signIn;
    return { admins: saved?.admins ?? [], members: saved?.members ?? [] };
  };
  const people = createPeopleLimit({
    dataDir: home, env: {}, lists, sessions: () => state.sessions,
    revoke: (id) => { state.revoked.push(id); }, applies: true, enterpriseUnlimited: () => false,
  });
  const revalidate = vi.fn();
  const route = createConfigRoutes({
    sessions: { revalidateEmailSessions: revalidate }, people, cfg: { ...options.config, signIn: current },
    store: { bots: [], clearVoiceSelections() {} }, registry: { get: () => undefined, forgetSnapshots() {} },
    sharedComputers: { close() {} }, sharedComputerControl: { close() {} }, lendingEnabled: () => true,
    localVmIdles: new Map(), localVmIdleMs: () => 0, localVmActiveThreads: new Set(), localVmLifecycleBusy: new Set(),
    localVmImageBusy: { get: () => false }, localVmModeChangeBusy: { set() {} }, localVmModeChanging: () => () => {},
    configStatus: () => ({}), configForAccess: (status: unknown) => status, broadcast() {}, resyncOpenCodeProviderKeys() {},
    providerConfigBusy: { get: () => false, set() {} }, computerProviderConfigTransitions: new Map(), managedComputerOwners: new Map(),
    providerOperationConflict: () => null, perBotLocalVmCountForModeChange: () => options.perBotVms?.(people) ?? 0, providerConfigs: () => ({}), drainQueuedSends() {}, revokeEngineCapabilities() {}, reloadProviders() {},
    browserCleanup: { hasPendingProfile: () => false, prepare: () => [], abort() {}, commit: async () => [], ensure: async () => {} },
    browserLive: { closeAll() {}, closeForSession() {} }, browserRuntime: { heldBy: () => [] }, usedBrowserSessions: new Map(), closeBrowser: async () => true, browserEngineSwitched() {}, browserEngine: () => "",
    cloudHome: false, cloudTeam: false, hostedModels: false, sharedMembership: () => false,
  } as unknown as ConfigRouteDeps);
  const replies: Array<{ status: number; body: Record<string, unknown> }> = [];
  const auth: RequestAuth = { kind: "session", session: { id: "admin", scopes: ["admin", "client"] } as never, via: "bearer", scopes: ["admin", "client"] };
  await route({
    req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PATCH", auth,
    json: (_res: unknown, status: number, body: Record<string, unknown>) => { replies.push({ status, body }); },
    readBody: async () => ({ ...options.patch, signIn }),
  } as unknown as Parameters<typeof route>[0]);
  return { replies, state, people, unchanged: readFileSync(file, "utf8") === before, revalidate };
}

describe("the people limit in /api/config", () => {
  it("AC-03 answers 409 people_full and leaves config.json unchanged when a save adds a sixth person", async () => {
    const result = await putSignIn({ admins: names(6), members: [] }, { admins: names(5), members: [] });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ status: 409, body: { code: "people_full", errorKey: "serverError.people.full", errorParams: { limit: 5 } } });
    expect(result.unchanged).toBe(true);
    expect(result.revalidate).not.toHaveBeenCalled();
  });

  it("AC-03 lets an @domain entry bring back no place that a hand edit took off: that person is checked at sign-in", async () => {
    // x@corp.test joined through @corp.test; a hand edit of config.json took the entry out, and the start dropped the place.
    const current = { admins: names(5), members: [] };
    const result = await putSignIn({ admins: [...names(5), "@corp.test"], members: [] }, current, [], { kept: [...names(5), "x@corp.test"] });
    expect(result.replies[0]?.status).toBe(200);
    expect(result.people.status()).toMatchObject({ people: 5, full: true });
    expect(result.people.admit("x@corp.test")).toBe("full");
  });

  it("AC-03 checks again after the awaits, so a person who signs in meanwhile keeps the last place", async () => {
    const current = { admins: [...names(4), "@corp.test"], members: [] };
    const result = await putSignIn({ admins: [...names(5), "@corp.test"], members: [] }, current, [], {
      config: { localVm: { mode: "per-bot" } },
      patch: { localVm: { mode: "shared" } },
      async perBotVms(people) {
        expect(people.admit("late@corp.test")).toBeNull();
        return 0;
      },
    });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ status: 409, body: { code: "people_full" } });
    expect(result.unchanged).toBe(true);
    expect(result.people.status()).toMatchObject({ people: 5 });
  });

  it("AC-06 ends the sessions of an address taken off the list through the config route", async () => {
    const current = { admins: names(5), members: [] };
    const result = await putSignIn({ admins: names(5).slice(1), members: [] }, current, [{ id: "s1", email: "p1@corp.test" }, { id: "s2", email: "p2@corp.test" }]);
    expect(result.replies[0]?.status).toBe(200);
    expect(result.state.revoked).toEqual(["s1"]);
    expect(result.revalidate).toHaveBeenCalled();
  });
});
