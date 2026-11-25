import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createPeopleLimit, type PeopleSession } from "../people-limit.ts";
import { TEAM_KEY_ENV, TEAM_KEY_FILE } from "../plan-key.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DAY, planKeyPair } from "../testing/plan-keys.ts";
import { PASS } from "./table.ts";
import { createPeoplePlanRoutes } from "./people-plan.ts";

const NOW = Date.now();
const pair = planKeyPair();
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "seira-people-route-"));
  dirs.push(dataDir);
  const state = { sessions: [] as PeopleSession[], revoked: [] as string[] };
  const people = createPeopleLimit({
    dataDir, env, publicKeys: [pair.publicKey], lists: () => ({ admins: ["boss@corp.test", "@corp.test"], members: [] }),
    sessions: () => state.sessions, revoke: (id) => { state.revoked.push(id); state.sessions = state.sessions.filter((s) => s.id !== id); },
    applies: true, enterpriseUnlimited: () => false,
  });
  people.admit("boss@corp.test");
  const audits: unknown[] = [];
  const route = createPeoplePlanRoutes({ people, audit: (_auth, _req, row) => audits.push(row) });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://host").pathname;
    void route({ req, res, url: new URL(req.url ?? "/", "http://host"), path, method: req.method ?? "GET", auth: {} as never, json, readBody }).then((out) => {
      if (out === PASS) json(res, 404, { error: "pass" });
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  const call = async (method: string, path: string, body?: unknown) => {
    const reply = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: reply.status, body: await reply.json() as Record<string, unknown> };
  };
  return { dataDir, people, state, audits, call };
}

describe("people plan routes", () => {
  it("answers the plan status", async () => {
    const { call } = await fixture();
    const reply = await call("GET", "/api/people/plan");
    expect(reply).toMatchObject({ status: 200, body: { applies: true, plan: "free", limit: 5, people: 1 } });
  });

  it("AC-09 saves a valid key to team-key with owner-only mode and records customer and end date only", async () => {
    const { call, dataDir, audits } = await fixture();
    const key = pair.mint({ customer: "Acme", issuedAt: NOW, expiresAt: NOW + 90 * DAY });
    const reply = await call("PUT", "/api/people/plan/key", { key });
    expect(reply).toMatchObject({ status: 200, body: { plan: "premium", key: { state: "active", customer: "Acme", source: "settings" } } });
    const file = join(dataDir, TEAM_KEY_FILE);
    expect(readFileSync(file, "utf8").trim()).toBe(key);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(audits)).not.toContain(key);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(reply.body)).not.toContain(key);
  });

  it("AC-10 answers 400 for a bad signature, an unknown format and another product, and keeps the previous key", async () => {
    const { call, dataDir } = await fixture();
    const good = pair.mint({ customer: "Acme", issuedAt: NOW, expiresAt: NOW + 90 * DAY });
    await call("PUT", "/api/people/plan/key", { key: good });
    const bad = [
      planKeyPair().mint({ issuedAt: NOW, expiresAt: NOW + 90 * DAY }),
      "garbage",
      pair.mint({ product: "other", issuedAt: NOW, expiresAt: NOW + 90 * DAY }),
    ];
    for (const key of bad) {
      const reply = await call("PUT", "/api/people/plan/key", { key });
      expect(reply).toMatchObject({ status: 400, body: { code: "key_invalid", errorKey: "serverError.premiumKey.invalid" } });
    }
    expect(await call("PUT", "/api/people/plan/key", { key: 5 })).toMatchObject({ status: 400, body: { code: "key_invalid" } });
    expect(await call("PUT", "/api/people/plan/key", { key: "x".repeat(5000) })).toMatchObject({ status: 400, body: { code: "key_invalid" } });
    expect(readFileSync(join(dataDir, TEAM_KEY_FILE), "utf8").trim()).toBe(good);
    expect((await call("GET", "/api/people/plan")).body).toMatchObject({ plan: "premium" });
    const ended = pair.mint({ issuedAt: NOW - 90 * DAY, expiresAt: NOW - 30 * DAY });
    expect(await call("PUT", "/api/people/plan/key", { key: ended })).toMatchObject({ status: 400, body: { code: "key_ended", errorKey: "serverError.premiumKey.ended" } });
  });

  it("AC-14 answers 409 key_locked when SEIRA_TEAM_KEY is set", async () => {
    const env = { [TEAM_KEY_ENV]: pair.mint({ issuedAt: NOW, expiresAt: NOW + 90 * DAY }) };
    const { call, dataDir } = await fixture(env);
    writeFileSync(join(dataDir, TEAM_KEY_FILE), "ignored");
    const reply = await call("PUT", "/api/people/plan/key", { key: pair.mint({ issuedAt: NOW, expiresAt: NOW + 90 * DAY }) });
    expect(reply).toMatchObject({ status: 409, body: { code: "key_locked", errorKey: "serverError.premiumKey.locked" } });
    expect((await call("GET", "/api/people/plan")).body).toMatchObject({ key: { source: "environment" } });
  });

  it("AC-06 removes a joined person, ends their sessions and frees the place", async () => {
    const { call, people, state } = await fixture();
    for (const email of ["a", "b", "c", "d"]) people.admit(`${email}@corp.test`);
    state.sessions = [{ id: "sa", email: "a@corp.test" }];
    expect(people.admit("e@corp.test")).toBe("full");
    expect(await call("POST", "/api/people/plan/remove", { email: "A@corp.test" })).toMatchObject({ status: 200, body: { people: 4 } });
    expect(state.revoked).toEqual(["sa"]);
    expect(people.admit("e@corp.test")).toBeNull();
    expect(await call("POST", "/api/people/plan/remove", { email: "boss@corp.test" })).toMatchObject({ status: 409, body: { code: "listed" } });
    expect(await call("POST", "/api/people/plan/remove", { email: "nobody@corp.test" })).toMatchObject({ status: 404, body: { code: "unknown" } });
  });
});
