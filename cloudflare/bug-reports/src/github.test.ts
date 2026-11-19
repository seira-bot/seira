import { describe, expect, it } from "vitest";

import { APP_ID, INSTALLATION_ID, bugHarness, pkcs1Pem, pkcs8Pem, validReport } from "./test-harness";

describe("AC-14 token", () => {
  const keys: Array<[string, string]> = [
    ["a PKCS#8 key", pkcs8Pem],
    ["a PKCS#1 key", pkcs1Pem],
    ["a PKCS#1 key on one line with escaped newlines", pkcs1Pem.trim().replace(/\n/g, "\\n")],
    ["a PKCS#8 key on one line with escaped newlines", pkcs8Pem.trim().replace(/\n/g, "\\n")],
  ];

  it.each(keys)("signs a JWT that GitHub accepts with %s", async (_name, key) => {
    const h = bugHarness({ GITHUB_APP_PRIVATE_KEY: key });
    const response = await h.send(validReport());
    expect(response.status).toBe(201);
    expect(h.github.jwts).toHaveLength(1);
    const { header, claims } = h.github.jwts[0]!;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe(APP_ID);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    expect(claims.iat).toBe(Math.floor(h.clock.ms / 1000) - 60);
  });

  it("asks for a token for one repository with issues write", async () => {
    const h = bugHarness();
    await h.send(validReport());
    const [request] = h.github.tokenRequests();
    expect(request?.path).toBe(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(request?.body).toEqual({ repositories: ["seira"], permissions: { issues: "write" } });
    expect(request?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const api = h.github.apiCalls()[0];
    expect(api?.headers.authorization).toMatch(/^Bearer ghs_fake1$/);
  });

  it("reuses the token until 5 minutes before it expires", async () => {
    const h = bugHarness();
    await h.sendNumbered(1);
    await h.sendNumbered(2);
    expect(h.github.tokenRequests()).toHaveLength(1);
    h.clock.advance(3000);
    await h.sendNumbered(3);
    expect(h.github.tokenRequests()).toHaveLength(1);
    h.clock.advance(301);
    await h.sendNumbered(4);
    expect(h.github.tokenRequests()).toHaveLength(2);
    expect(h.github.apiCalls().at(-1)?.headers.authorization).toBe("Bearer ghs_fake2");
  });

  it("asks for a new token when GitHub refuses the cached one", async () => {
    const h = bugHarness();
    await h.sendNumbered(1);
    h.github.revokeTokens();
    expect((await h.sendNumbered(2)).response.status).toBe(201);
    expect(h.github.tokenRequests()).toHaveLength(2);
  });

  it("answers 502 when the private key is not usable", async () => {
    const h = bugHarness({ GITHUB_APP_PRIVATE_KEY: "not a key" });
    expect((await h.send(validReport())).status).toBe(502);
    expect(h.reportRows()).toHaveLength(0);
  });
});
