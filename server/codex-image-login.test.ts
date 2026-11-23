import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexImageLogin, codexImageSources, codexPlanMakesImages, readCodexImageLogin, renewCodexImageLogin } from "./codex-image-login.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { codexAuthFile, fakeJwt } from "./testing/codex-image-auth.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
const NOW = Date.UTC(2026, 10, 21, 12);

describe("Codex image sign-in", () => {
  let home: string;
  const codexHomeDir = () => join(home, ".codex");
  const source = (extra: Record<string, string> = {}) => ({ cli: "codex", env: { HOME: home, USERPROFILE: home, CODEX_HOME: codexHomeDir(), ...extra } });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seira-codex-image-login-"));
    mkdirSync(codexHomeDir());
  });
  afterEach(async () => { await removeTempDir(home); });

  it("reads the token, the account id and the plan from Codex's own sign-in", () => {
    codexAuthFile(codexHomeDir(), { token: "synthetic-access", accountId: "acct-fixture", plan: "Plus", expiresAt: NOW + 3_600_000 });
    expect(readCodexImageLogin(source(), NOW)).toEqual({ token: expect.any(String), accountId: "acct-fixture", plan: "plus", expired: false });
  });

  it("takes the account id from the token when the file has none, and marks a token that ends within a minute as expired", () => {
    const access = fakeJwt({ exp: Math.floor((NOW + 30_000) / 1000), "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-token" } });
    writeFileSync(join(codexHomeDir(), "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access } }));
    expect(readCodexImageLogin(source(), NOW)).toMatchObject({ accountId: "acct-from-token", plan: null, expired: true });
  });

  it.each([
    ["no file", null],
    ["an API key sign-in", { auth_mode: "apikey", OPENAI_API_KEY: "sk-synthetic", tokens: { access_token: fakeJwt({}), account_id: "acct" } }],
    ["no access token", { tokens: { account_id: "acct" } }],
    ["no account id", { tokens: { access_token: fakeJwt({}) } }],
    ["a broken file", "{not json"],
  ])("finds no sign-in with %s", (_name, content) => {
    if (content !== null) writeFileSync(join(codexHomeDir(), "auth.json"), typeof content === "string" ? content : JSON.stringify(content));
    expect(readCodexImageLogin(source(), NOW)).toBeNull();
  });

  it("looks in each plain Codex engine first, then in Codex's default home", () => {
    const sources = codexImageSources({
      plain: { driver: "codex", environment: { CODEX_HOME: "/engine/home" }, config: { cli: "/opt/codex" } },
      plan: { driver: "codex", config: { authMode: "chatgpt-plan" } },
      gateway: { driver: "codex", config: { endpoint: { url: "https://gateway.example", models: ["m"] } } },
      managed: { driver: "codex", config: { managed: {} } },
      off: { driver: "codex", enabled: false },
      claude: { driver: "claude" },
    }, { HOME: "/home/fixture" });
    expect(sources).toEqual([
      { cli: "/opt/codex", env: { HOME: "/home/fixture", CODEX_HOME: "/engine/home" } },
      { cli: "codex", env: { HOME: "/home/fixture" } },
    ]);
  });

  it("uses the first home that has a sign-in", () => {
    const engineHome = join(home, "engine");
    mkdirSync(engineHome);
    codexAuthFile(codexHomeDir(), { token: "default-token", accountId: "acct-default" });
    expect(codexImageLogin({ engine: { driver: "codex", environment: { CODEX_HOME: engineHome } } }, source().env)?.login.accountId).toBe("acct-default");
    codexAuthFile(engineHome, { token: "engine-token", accountId: "acct-engine" });
    expect(codexImageLogin({ engine: { driver: "codex", environment: { CODEX_HOME: engineHome } } }, source().env)?.login.accountId).toBe("acct-engine");
  });

  it("makes no images on the free plan only", () => {
    expect(codexPlanMakesImages("free")).toBe(false);
    for (const plan of ["plus", "pro", "go", "team", null]) expect(codexPlanMakesImages(plan)).toBe(true);
  });

  it("asks Codex to renew its own sign-in, without an API key in its environment, one renewal at a time", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const renew = { cli: FAKE_CLI, env: { ...source().env, PATH: process.env.PATH, OPENAI_API_KEY: "sk-synthetic", FAKE_CODEX_DUMP: join(home, "calls.json") } };
    const first = renewCodexImageLogin(renew);
    expect(renewCodexImageLogin(renew)).toBe(first);
    expect(await first).toBe(true);
    const dump = JSON.parse(readFileSync(join(home, "calls.json"), "utf8"));
    expect(dump.calls).toContainEqual({ method: "account/read", params: { refreshToken: true } });
    expect(dump.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("answers false when Codex cannot renew", async () => {
    chmodSync(FAKE_CLI, 0o755);
    expect(await renewCodexImageLogin({ cli: FAKE_CLI, env: { ...source().env, PATH: process.env.PATH, FAKE_CODEX_ACCOUNT_MODE: "none" } })).toBe(false);
    expect(await renewCodexImageLogin({ cli: join(home, "missing-codex"), env: source().env })).toBe(false);
  });
});
