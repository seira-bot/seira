// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "./control-seira.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "seira-fixture-env"), 9100);

describe("a fixture driven from a real browser", () => {
  it("trusts this machine's browsers as `pnpm dev` does, unless the caller tests the sign-in", () => {
    expect(childEnv({}).SEIRA_DEV_TRUST_LOCAL_BROWSER).toBe("1");
    expect(childEnv({ SEIRA_DEV_TRUST_LOCAL_BROWSER: "0" })).not.toHaveProperty("SEIRA_DEV_TRUST_LOCAL_BROWSER");
  });
});

describe("the fixture's fake engine knobs", () => {
  it("lets the Claude fake's knobs and the Codex fake's background-call knobs cross, and nothing else", () => {
    const env = childEnv({
      FAKE_CLAUDE_TEXT_ROUTES: "/tmp/routes.json", FAKE_CODEX_TEXT_ROUTES: "/tmp/codex-routes.json", FAKE_CODEX_TEXT_LOG: "/tmp/codex.jsonl",
      FAKE_CODEX_MODE: "approval", FAKE_CODEX_DUMP: "/tmp/codex-dump.json", SOME_SECRET: "x",
    });
    expect(env).toMatchObject({ FAKE_CLAUDE_TEXT_ROUTES: "/tmp/routes.json", FAKE_CODEX_TEXT_ROUTES: "/tmp/codex-routes.json", FAKE_CODEX_TEXT_LOG: "/tmp/codex.jsonl" });
    for (const key of ["FAKE_CODEX_MODE", "FAKE_CODEX_DUMP", "SOME_SECRET"]) expect(env, key).not.toHaveProperty(key);
  });

  it("lets every fake's scripted stream cross, for a reply that arrives in pieces", () => {
    const env = childEnv({ FAKE_STREAM_SCRIPT: "/tmp/script.json", FAKE_STREAM_CADENCE: "3:90", FAKE_ACP_DUMP: "/tmp/acp.json" });
    expect(env).toMatchObject({ FAKE_STREAM_SCRIPT: "/tmp/script.json", FAKE_STREAM_CADENCE: "3:90" });
    expect(env).not.toHaveProperty("FAKE_ACP_DUMP");
  });
});

describe("the fixture's Netlify stand-in", () => {
  it("lets only a loopback stand-in's API address cross, so a fixture never lists or deletes on Netlify", () => {
    expect(childEnv({ SEIRA_NETLIFY_API_URL: " http://127.0.0.1:4010/api/v1 " }).SEIRA_NETLIFY_API_URL).toBe("http://127.0.0.1:4010/api/v1");
    for (const url of ["https://api.netlify.com/api/v1", "http://localhost:4010/api/v1", "http://127.0.0.1:4010", "http://127.0.0.1:4010/api/v1@evil.test", "http://192.0.2.1:4010/api/v1", ""]) {
      expect(childEnv({ SEIRA_NETLIFY_API_URL: url }), url).not.toHaveProperty("SEIRA_NETLIFY_API_URL");
    }
  });
});

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ SEIRA_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", SEIRA_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ SEIRA_OPENAI_LIVE_URL: "http://127.0.0.1:4100", SEIRA_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ SEIRA_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.SEIRA_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("SEIRA_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ SEIRA_OPENAI_LIVE_URL: url, SEIRA_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("SEIRA_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("SEIRA_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ SEIRA_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("SEIRA_OPENAI_LIVE_KEY");
  });
});

describe("the fixture's included app hosting relay", () => {
  it("passes a loopback stand-in and its token through together, and neither for any other address", () => {
    expect(childEnv({ SEIRA_CLOUD_HOSTING_URL: " http://127.0.0.1:4400/api/cloud/services/hosting/v1 ", SEIRA_CLOUD_HOSTING_TOKEN: "seira_host_fixture" }))
      .toMatchObject({ SEIRA_CLOUD_HOSTING_URL: "http://127.0.0.1:4400/api/cloud/services/hosting/v1", SEIRA_CLOUD_HOSTING_TOKEN: "seira_host_fixture" });
    for (const url of ["https://cloud.seira.bot/api/cloud/services/hosting/v1", "http://localhost:4400/api/cloud/services/hosting/v1", "http://192.0.2.1:4400", "http://127.0.0.1:4400/../x?y", ""]) {
      const env = childEnv({ SEIRA_CLOUD_HOSTING_URL: url, SEIRA_CLOUD_HOSTING_TOKEN: "seira_host_real" });
      expect(env, url).not.toHaveProperty("SEIRA_CLOUD_HOSTING_URL");
      expect(env, url).not.toHaveProperty("SEIRA_CLOUD_HOSTING_TOKEN");
    }
    expect(childEnv({ SEIRA_CLOUD_HOSTING_URL: "http://127.0.0.1:4400/api/cloud/services/hosting/v1" })).not.toHaveProperty("SEIRA_CLOUD_HOSTING_URL");
  });
});

describe("the fixture's X research relay", () => {
  it("passes a loopback relay stub and its token through, the token only with the stub", () => {
    expect(childEnv({ SEIRA_CLOUD_X_URL: " http://127.0.0.1:4200/api/cloud/services/x ", SEIRA_CLOUD_X_TOKEN: "seira_x_fixture" }))
      .toMatchObject({ SEIRA_CLOUD_X_URL: "http://127.0.0.1:4200/api/cloud/services/x", SEIRA_CLOUD_X_TOKEN: "seira_x_fixture" });
    for (const url of ["https://cloud.seira.bot/api/cloud/services/x", "http://localhost:4200/api/cloud/services/x", "http://192.0.2.1:4200", "http://127.0.0.1:4200/../x?y", ""]) {
      const env = childEnv({ SEIRA_CLOUD_X_URL: url, SEIRA_CLOUD_X_TOKEN: "seira_x_real" });
      expect(env, url).not.toHaveProperty("SEIRA_CLOUD_X_URL");
      expect(env, url).not.toHaveProperty("SEIRA_CLOUD_X_TOKEN");
    }
    expect(childEnv({ SEIRA_TREG_URL: " http://127.0.0.1:4300 " })).toMatchObject({ SEIRA_TREG_URL: "http://127.0.0.1:4300" });
    for (const url of ["https://treg.to", "http://localhost:4300", "http://127.0.0.1:4300/x", ""]) expect(childEnv({ SEIRA_TREG_URL: url }), url).not.toHaveProperty("SEIRA_TREG_URL");
  });
});

describe("the fixture's @devs reports", () => {
  it("go to a loopback fake endpoint, else to a closed port: never to the Seira team", () => {
    const closed = "http://127.0.0.1:9/api/bug-reports";
    expect(childEnv({ SEIRA_BUG_REPORT_URL: " http://127.0.0.1:4400/api/bug-reports " }).SEIRA_BUG_REPORT_URL).toBe("http://127.0.0.1:4400/api/bug-reports");
    for (const url of ["https://cloud.seira.bot/api/bug-reports", "http://localhost:4400/api/bug-reports", "http://192.0.2.1:4400/x", "http://127.0.0.1:4400/../x?y", ""]) {
      expect(childEnv({ SEIRA_BUG_REPORT_URL: url }).SEIRA_BUG_REPORT_URL, url).toBe(closed);
    }
    expect(childEnv({}).SEIRA_BUG_REPORT_URL).toBe(closed);
  });
});
