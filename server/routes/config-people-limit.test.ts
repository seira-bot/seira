import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignInAllowList } from "../account-signin.ts";
import { createPeopleLimit, type PeopleSession } from "../people-limit.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const names = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}@corp.test`);

async function putSignIn(signIn: SignInAllowList, current: SignInAllowList, sessions: PeopleSession[] = []) {
  const home = mkdtempSync(join(tmpdir(), "seira-config-people-"));
  dirs.push(home);
  vi.stubEnv("SEIRA_DATA_DIR", home);
  vi.stubEnv("SEIRA_SIGNIN_EMAILS", "");
  vi.stubEnv("SEIRA_SIGNIN_MEMBER_EMAILS", "");
  const file = join(home, "config.json");
  writeFileSync(file, `${JSON.stringify({ signIn: current })}\n`);
  const before = readFileSync(file, "utf8");
  const state = { lists: current, sessions, revoked: [] as string[] };
  const people = createPeopleLimit({
    dataDir: home, env: {}, lists: () => state.lists, sessions: () => state.sessions,
    revoke: (id) => { state.revoked.push(id); }, applies: true, enterpriseUnlimited: () => false,
  });
  const revalidate = vi.fn();
  const route = createConfigRoutes({
    sessions: { revalidateEmailSessions: revalidate }, people, cfg: { signIn: current },
    store: { bots: [], clearVoiceSelections() {} }, registry: { get: () => undefined, forgetSnapshots() {} },
    sharedComputers: { close() {} }, sharedComputerControl: { close() {} }, lendingEnabled: () => true,
    localVmIdles: new Map(), localVmIdleMs: () => 0, localVmActiveThreads: new Set(), localVmLifecycleBusy: new Set(),
    localVmImageBusy: { get: () => false }, localVmModeChangeBusy: { set() {} }, localVmModeChanging: () => () => {},
    configStatus: () => ({}), configForAccess: (status: unknown) => status, broadcast() {}, resyncOpenCodeProviderKeys() {},
    cloudHome: false, cloudTeam: false, hostedModels: false, sharedMembership: () => false,
  } as unknown as ConfigRouteDeps);
  const replies: Array<{ status: number; body: Record<string, unknown> }> = [];
  const auth: RequestAuth = { kind: "session", session: { id: "admin", scopes: ["admin", "client"] } as never, via: "bearer", scopes: ["admin", "client"] };
  await route({
    req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method: "PATCH", auth,
    json: (_res: unknown, status: number, body: Record<string, unknown>) => { replies.push({ status, body }); },
    readBody: async () => ({ signIn }),
  } as unknown as Parameters<typeof route>[0]);
  return { replies, state, unchanged: readFileSync(file, "utf8") === before, revalidate };
}

describe("the people limit in /api/config", () => {
  it("AC-03 answers 409 people_full and leaves config.json unchanged when a save adds a sixth person", async () => {
    const result = await putSignIn({ admins: names(6), members: [] }, { admins: names(5), members: [] });
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ status: 409, body: { code: "people_full", errorKey: "serverError.people.full", errorParams: { limit: 5 } } });
    expect(result.unchanged).toBe(true);
    expect(result.revalidate).not.toHaveBeenCalled();
  });

  it("AC-06 ends the sessions of an address taken off the list through the config route", async () => {
    const current = { admins: names(5), members: [] };
    const result = await putSignIn({ admins: names(5).slice(1), members: [] }, current, [{ id: "s1", email: "p1@corp.test" }, { id: "s2", email: "p2@corp.test" }]);
    expect(result.replies[0]?.status).toBe(200);
    expect(result.state.revoked).toEqual(["s1"]);
    expect(result.revalidate).toHaveBeenCalled();
  });
});
