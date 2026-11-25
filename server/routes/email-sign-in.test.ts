import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmailSignIn } from "../account-signin.ts";
import { createPeopleLimit, type PeopleLimit } from "../people-limit.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { userError } from "../user-errors.ts";
import { emailSignInRoute } from "./email-sign-in.ts";

const servers: Server[] = [];
const dirs: string[] = [];
const openPeople: PeopleLimit = { refuses: () => false, admit: () => null } as unknown as PeopleLimit;
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(verify: EmailSignIn["verify"], people: Pick<PeopleLimit, "refuses" | "admit"> = openPeople, path = "/api/auth/email/verify") {
  const noteFailure = vi.fn();
  const issue = vi.fn(() => { throw new Error("no session expected"); });
  const start = vi.fn(async () => ({ ok: true }) as const);
  const deps = {
    cloudHome: false,
    emailSignIn: { enabled: () => true, start, verify } as EmailSignIn,
    sessions: {
      attemptAllowed: () => ({ ok: true }) as const,
      noteFailure,
      clearFailures: () => {},
      issue,
    },
    people,
    cookieName: "seira_session",
    environment: () => ({}),
    target: () => null,
  };
  const server = createServer((req, res) => {
    void emailSignInRoute(deps, req, res, path, "POST");
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const post = (email = "her@example.test") => fetch(`http://127.0.0.1:${address.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code: "00000000" }),
  });
  return { noteFailure, post, issue, start };
}

describe("email sign-in verify", () => {
  it.each([
    [401, true],
    [403, true],
    [429, true],
    [400, false],
    [502, false],
  ])("counts a failure for the source when verify answers %i: %s", async (status, counted) => {
    const { noteFailure, post } = await fixture(async () => ({ ok: false, status, ...userError("serverError.email.codeWrong") }));
    expect((await post()).status).toBe(status);
    expect(noteFailure).toHaveBeenCalledTimes(counted ? 1 : 0);
  });
});

describe("email sign-in and the free people limit", () => {
  const roster = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}@corp.test`);
  /** Five people signed in; `listed` names more addresses that hold no place yet, as an environment list does. */
  function fullTeam(listed: string[] = ["@corp.test"]) {
    const dataDir = mkdtempSync(join(tmpdir(), "seira-email-limit-"));
    dirs.push(dataDir);
    const lists = { admins: [...roster(5), ...listed], members: [] };
    const people = createPeopleLimit({ dataDir, env: {}, lists: () => lists, sessions: () => [], revoke() {}, applies: true, enterpriseUnlimited: () => false });
    for (const email of roster(5)) people.admit(email);
    return people;
  }
  const refusal = { errorKey: "serverError.email.workspaceFull", code: "workspace_full" };

  it("AC-05 refuses a sixth person through an @domain entry at the start, without counting a failure", async () => {
    const people = fullTeam();
    const { post, start, noteFailure } = await fixture(async () => ({ ok: true, email: "sixth@corp.test", userId: "u", scopes: ["admin"] }), people, "/api/auth/email/start");
    const reply = await post("sixth@corp.test");
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject(refusal);
    expect(start).not.toHaveBeenCalled();
    expect(noteFailure).not.toHaveBeenCalled();
  });

  it("AC-05 refuses a sixth person through an @domain entry at the verify step and issues no session", async () => {
    const people = fullTeam();
    const { post, issue } = await fixture(async () => ({ ok: true, email: "sixth@corp.test", userId: "u", scopes: ["admin"] }), people);
    const reply = await post("sixth@corp.test");
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject(refusal);
    expect(issue).not.toHaveBeenCalled();
  });

  it("AC-05 refuses a sixth listed address that holds no place, at the start", async () => {
    const people = fullTeam(["p6@corp.test"]);
    const { post, start } = await fixture(async () => ({ ok: true, email: "p6@corp.test", userId: "u", scopes: ["admin"] }), people, "/api/auth/email/start");
    const reply = await post("p6@corp.test");
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject(refusal);
    expect(start).not.toHaveBeenCalled();
  });
});
