import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { githubLevelPermissions } from "../../shared/github-app.ts";
import { fakeInstallation, startGithubBrokerFake, type GithubBrokerFake } from "../testing/github-broker-fake.ts";
import { createGithubBrokerClient, GithubBrokerError, GITHUB_RECONNECT_MESSAGE, GITHUB_UNREACHABLE_MESSAGE } from "./broker-client.ts";

let fake: GithubBrokerFake;
beforeEach(async () => { fake = await startGithubBrokerFake(); });
afterEach(async () => { await fake.close(); vi.restoreAllMocks(); });
const client = (now?: () => number) => createGithubBrokerClient({ access: () => ({ url: fake.url, token: fake.token }), now });

describe("github broker client", () => {
  it("asks for exactly one repository and the smallest permissions of the level", async () => {
    await client().mintToken(1, 10, "read");
    await client().mintToken(1, 11, "write");
    expect(fake.tokenRequests[0]).toEqual({ installationId: 1, repositoryIds: [10], permissions: githubLevelPermissions("read") });
    expect(fake.tokenRequests[1]).toEqual({ installationId: 1, repositoryIds: [11], permissions: githubLevelPermissions("write") });
    expect(fake.tokenRequests[0]!.permissions.contents).toBe("read");
  });

  it("caches per installation, repository and level until five minutes before expiry", async () => {
    let at = Date.now();
    const c = client(() => at);
    const first = await c.mintToken(1, 10, "read");
    expect((await c.mintToken(1, 10, "read")).token).toBe(first.token);
    await c.mintToken(1, 10, "pull_requests");
    await c.mintToken(1, 11, "read");
    expect(fake.tokenRequests).toHaveLength(3);
    at += 56 * 60_000;
    const renewed = await c.mintToken(1, 10, "read");
    expect(renewed.token).not.toBe(first.token);
    expect(fake.tokenRequests).toHaveLength(4);
  });

  it("maps a refusal to a reconnect message and an outage to a not reachable message", async () => {
    fake.failNext("token", 403);
    await expect(client().mintToken(1, 10, "read")).rejects.toMatchObject({ kind: "reconnect", message: GITHUB_RECONNECT_MESSAGE });
    fake.failNext("token", 502);
    await expect(client().mintToken(1, 10, "read")).rejects.toMatchObject({ kind: "unreachable", message: GITHUB_UNREACHABLE_MESSAGE });
    fake.failNext("token", 401);
    await expect(client().mintToken(1, 10, "read")).rejects.toBeInstanceOf(GithubBrokerError);
    const down = createGithubBrokerClient({ access: () => ({ url: "http://127.0.0.1:1", token: "t" }) });
    await expect(down.mintToken(1, 10, "read")).rejects.toMatchObject({ kind: "unreachable" });
    const none = createGithubBrokerClient({ access: () => null });
    await expect(none.installations()).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("never logs or returns a token in an error", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const out = await client().mintToken(1, 10, "read");
    fake.failNext("token", 502);
    const error = await client().mintToken(1, 10, "write").catch((e) => e as Error);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(out.token);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toContain(out.token);
  });

  it("reads installations and answers a complete with a bad code as bad_code", async () => {
    fake.installations.push(fakeInstallation(1, "shop", [{ id: 10, name: "site" }]));
    fake.pending.push({ account: "acme" });
    const found = await client().installations();
    expect(found.installations[0]!.repositories[0]!.fullName).toBe("shop/site");
    expect(found.pending).toEqual([{ account: "acme" }]);
    fake.expectCode("ABCDEFGHJK", [1]);
    expect((await client().complete("ABCDEFGHJK")).linked[0]!.account.login).toBe("shop");
    await expect(client().complete("ZZZZZZZZZZ")).rejects.toMatchObject({ kind: "bad_code" });
  });

  it("sends returnTo only when given and unlinks", async () => {
    await client().connect();
    await client().connect("http://127.0.0.1:5000/github/return");
    expect(fake.connectBodies).toEqual([{}, { returnTo: "http://127.0.0.1:5000/github/return" }]);
    fake.installations.push(fakeInstallation(1, "shop", []));
    expect(await client().unlink(1)).toEqual({ manageUrl: "https://github.com/settings/installations" });
    await expect(client().unlink(1)).rejects.toMatchObject({ kind: "gone" });
  });
});
