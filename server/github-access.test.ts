import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GITHUB_STATUS_ARGS, asksForGithubToken, githubAccessText, githubCheckEnvironment, localGithubAccess } from "./github-access.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

describe("a request for a GitHub token", () => {
  it.each([
    [{ label: "GitHub token" }],
    [{ label: "GitHub personal access token" }],
    [{ label: "GitHub PAT" }],
    [{ label: "GH_TOKEN" }],
    [{ label: "GITHUB_TOKEN" }],
    [{ label: "githubToken" }],
    [{ label: "GitHub" }],
    [{ label: "gh auth token" }],
    [{ label: "GitHub access", reason: "To push the fix branch." }],
    [{ label: "Personal access token", placeholder: "ghp_…" }],
    [{ label: "Fine-grained token", placeholder: "github_pat_…" }],
    [{ label: "PAT", reason: "To open a pull request on GitHub." }],
    [{ label: "Personal access token", reason: "gh needs it to push." }],
  ])("matches %j", (ask) => {
    expect(asksForGithubToken(ask)).toBe(true);
  });

  it.each([
    [{ label: "Stripe secret key" }],
    [{ label: "Patreon API key" }],
    [{ label: "Spatial token" }],
    [{ label: "Compatibility PAT" }],
    [{ label: "Figma PAT", reason: "To read the design linked from GitHub." }],
    [{ label: "PAT" }],
    [{ label: "Personal access token", reason: "For the GitLab mirror." }],
    [{ label: "GitHub webhook secret" }],
    [{ label: "GitHub App private key" }],
    [{ label: "GitHub OAuth client secret" }],
    [{ label: "GitHub SSH key" }],
    [{ label: "GitHub deploy key" }],
    [{ label: "GitHub Enterprise token" }],
    [{ label: "GitHub token", reason: "For our GitHub Enterprise server." }],
    [{ label: "GitHub Packages token" }],
    [{ label: "ghcr.io token" }],
    [{ label: "GitHub Actions secret" }],
    [{ label: "GitHub password" }],
    [{ label: "GitHub key" }],
    [{ label: "Access token", reason: "For the GitHub webhook." }],
  ])("does not match %j", (ask) => {
    expect(asksForGithubToken(ask)).toBe(false);
  });
});

describe("the environment gh checks its sign-in in", () => {
  it("keeps the server's HOME and the session bus, sets PATH, and drops every token", () => {
    const env = githubCheckEnvironment({
      HOME: "/srv/person", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", PATH: "/old",
      GH_TOKEN: "fake-gh", GITHUB_TOKEN: "fake-github", GH_ENTERPRISE_TOKEN: "fake-ghe", github_token: "fake-lower",
      COMPOSIO_API_KEY: "fake-composio", ANTHROPIC_API_KEY: "fake-anthropic",
    }, "/new");
    expect(env).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", PATH: "/new", GH_PROMPT_DISABLED: "1" });
    if (process.platform !== "win32") expect(env.HOME).toBe("/srv/person");
    expect(JSON.stringify(env)).not.toMatch(/fake-/u);
  });
});

describe.skipIf(process.platform === "win32")("the gh sign-in check", () => {
  const fakeGh = (script: string) => {
    const bin = folder("seira-gh-bin-");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  };
  const check = (bin: string, timeoutMs?: number) => {
    const home = folder("seira-gh-home-");
    const env = githubCheckEnvironment({ HOME: home, GH_TOKEN: "fake-token" }, bin);
    return { home, access: localGithubAccess({ env, ...(timeoutMs ? { timeoutMs } : {}) }) };
  };

  it("finds access when gh says it is signed in, and asks gh only for its status, in the server's HOME, with no token", async () => {
    const record = join(folder("seira-gh-record-"), "args");
    const bin = fakeGh(`printf '%s\\n' "$*" "$HOME" "\${GH_TOKEN-unset}" > '${record}'\nexit 0`);
    const { home, access } = check(bin);
    expect(await access).toBe(true);
    expect(readFileSync(record, "utf8")).toBe(`${GITHUB_STATUS_ARGS.join(" ")}\n${home}\nunset\n`);
  });

  it("finds no access when gh is signed out", async () => {
    expect(await check(fakeGh("exit 1")).access).toBe(false);
  });

  it("finds no access when gh is not installed", async () => {
    expect(await check(folder("seira-gh-none-")).access).toBe(false);
  });

  it("finds no access when gh does not answer in time, and stops it", async () => {
    const started = Date.now();
    const bin = fakeGh("exec sleep 30");
    const { access } = check(`${bin}${delimiter}/usr/bin${delimiter}/bin`, 300);
    expect(await access).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("what the bot hears instead of a card", () => {
  it("names gh, keeps the token hidden, and gives a way out for another service", () => {
    const text = githubAccessText("GitHub token");
    expect(text).toContain("Seira showed no card for GitHub token");
    expect(text).toContain("gh is signed in to github.com");
    expect(text).toContain("do not run gh auth token or gh auth status -t");
    expect(text).toContain("ask again with a label that names that service");
  });
});
