// The native GitHub connection in the real Apps pop-up and bot panel, against fake-engine servers and a loopback
// stand-in for the broker: no real GitHub, broker or Composio call.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlSeira, type VerificationServer } from "./control-seira.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { fakeInstallation, startGithubBrokerFake } from "../server/testing/github-broker-fake.ts";
import { GITHUB_STORE_FILE } from "../server/github/store.ts";
import type { GithubAppStatus, GithubBotPolicy } from "../shared/github-app.ts";

const BROKER_BEARER = "0123456789abcdef".repeat(4);
const OWNER_NAME = "Alex";
const OTHER_OWNER = { key: "p:other@example.com", label: "Sam" };
const STARTER = "Fixture Starter";

const broker = await startGithubBrokerFake({ token: BROKER_BEARER });
broker.installations = [
  fakeInstallation(101, "octo-user", [{ id: 1, name: "notes" }, { id: 2, name: "dotfiles" }]),
  fakeInstallation(202, "octo-org", [{ id: 11, name: "api" }, { id: 12, name: "web" }, { id: 13, name: "infra" }], {
    account: { login: "octo-org", type: "Organization", avatarUrl: "https://avatars.example/octo-org.png" },
  }),
];
broker.installations[1]!.repositories[2]!.private = true;
broker.pending = [{ account: "octo-corp" }];

const output = process.env.SEIRA_UI_EVIDENCE_DIR || "/tmp/seira-github-app-evidence";
mkdirSync(output, { recursive: true });
const { chromium } = await import(process.env.SEIRA_VERIFY_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.SEIRA_VERIFY_BROWSER_CHROME || undefined });
const opened: Array<{ fixture: VerificationServer; ui: MountedPreview }> = [];
const pages: any[] = [];

const checks: Array<{ ac?: string; check: string; passed: boolean; detail?: string }> = [];
async function check(name: string, run: () => Promise<void>, ac?: string) {
  try {
    await run();
    checks.push({ ...(ac ? { ac } : {}), check: name, passed: true });
  } catch (error) {
    checks.push({ ...(ac ? { ac } : {}), check: name, passed: false, detail: error instanceof Error ? error.message : String(error) });
    throw new Error(`check failed: ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const installationsFor = () => broker.installations.map((one) => ({
  installationId: one.id,
  login: one.account.login,
  type: one.account.type,
  avatarUrl: one.account.avatarUrl,
  repositorySelection: one.repositorySelection,
  suspended: one.suspended,
  repositories: one.repositories,
}));

const starterPolicy = (): GithubBotPolicy => ({
  repos: [
    { installationId: 101, repositoryId: 1, fullName: "octo-user/notes", level: "read" },
    { installationId: 202, repositoryId: 11, fullName: "octo-org/api", level: "pull_requests" },
  ],
  askBeforeBigChanges: true,
  ownBranchesOnly: true,
});

type Who = "none" | "owner" | "other";

async function open(who: Who, viewport = { width: 900, height: 900 }) {
  const fixture = await launchVerificationServer({
    ...process.env,
    SEIRA_GITHUB_APP: "1",
    SEIRA_COMPOSIO_BROKER_URL: broker.url,
    SEIRA_COMPOSIO_BROKER_BEARER: broker.token,
  });
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  await runControlSeira(["new-bot", "--name", "Fixture Helper", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; name: string }> };
  const starter = bots.find((bot) => bot.name === STARTER);
  assert.ok(starter, "the starter bot exists");
  const helper = bots.find((bot) => bot.name === "Fixture Helper");
  assert.ok(helper, "the second bot exists");
  const seeded = who === "none" ? null : {
    version: 1,
    ownerKey: who === "owner" ? "local" : OTHER_OWNER.key,
    ownerLabel: who === "owner" ? OWNER_NAME : OTHER_OWNER.label,
    connectedAt: Date.now(),
    accounts: installationsFor(),
    pending: broker.pending.map((one) => ({ login: one.account })),
    bots: { [starter.id]: starterPolicy() },
  };
  if (seeded) writeFileSync(join(fixture.info.dataDir, GITHUB_STORE_FILE), `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });

  const ui = await mountPreview(fixture, {
    entry: "/scripts/testing/github-app-preview.tsx", route: "/__github.html", title: "Isolated GitHub app",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: true, mode: "managed", source: "curated",
          cards: [["gmail", "Gmail", "gmail.com"], ["slack", "Slack", "slack.com"], ["notion", "Notion", "notion.so"]].map(([slug, label, domain]) => ({ slug, label, blurb: "Connect your account", logo: null, domain })) }));
      } },
      { path: "/api/connectors/tools", handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ configured: false, services: {} }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ services: {} }));
      } },
    ],
  });
  opened.push({ fixture, ui });
  const pairing = await fixtureApi(fixture.info.url)("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  pages.push(page);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(ui.previewUrl);
  assert.equal(await page.evaluate(async (code: string) => (await fetch("/api/auth/pair", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, cookie: true, label: "GitHub fixture" }) })).status, pairing.code), 200);
  await page.evaluate(() => localStorage.setItem("seira-advanced-mode", "0"));
  await page.reload();
  await page.locator('[data-app-tile="github"]').waitFor();
  const tile = page.locator('[data-app-tile="github"]');
  const status = () => page.evaluate(async () => (await fetch("/api/github-app")).json()) as Promise<GithubAppStatus>;
  const openBot = async (target?: "apps" | "github") => {
    // The bots may still be loading after a reload, and opening a bot that is not loaded does nothing: try until the panel is open.
    await page.waitForFunction(([id, wanted]: [string, string | undefined]) => {
      const fixtureApi = (window as any).__githubFixture;
      if (!fixtureApi) return false;
      if (!document.querySelector("aside[role=dialog]")) fixtureApi.openBot(id, wanted);
      return Boolean(document.querySelector("aside[role=dialog]"));
    }, [starter.id, target], { polling: 250 });
  };
  return { page, tile, errors, status, openBot, starterId: starter.id, helperId: helper.id, fixture };
}

const shot = async (page: any, name: string) => {
  await page.screenshot({ path: join(output, `${name}.png`) });
};
const text = (locator: any) => locator.innerText() as Promise<string>;
const contains = async (locator: any, expected: string | RegExp, label: string) => {
  const actual = await text(locator);
  assert.ok(typeof expected === "string" ? actual.includes(expected) : expected.test(actual), `${label}: "${actual}" does not match ${String(expected)}`);
};

const startedAt = new Date().toISOString();
let failure: unknown;
try {
  // A third run with no connection file: the tile offers Connect.
  const fresh = await open("none");
  await check("01 the GitHub tile is in Featured with a Connect button and nothing to manage", async () => {
    await fresh.tile.waitFor();
    assert.equal(await fresh.page.locator('[data-featured-slot] [data-app-tile="github"]').count(), 1, "the tile is in the Featured slot");
    assert.equal(await fresh.tile.getAttribute("data-github-state"), "idle");
    await fresh.tile.getByRole("button", { name: "Connect GitHub", exact: true }).waitFor();
    assert.equal(await fresh.tile.locator("details").count(), 0, "no Manage section before GitHub is connected");
    await fresh.tile.scrollIntoViewIfNeeded();
    await shot(fresh.page, "01-apps-tile-not-connected");
    assert.deepEqual(fresh.errors, []);
  }, "AC-01");

  const owner = await open("owner");
  await check("02 the owner sees the connected tile", async () => {
    await owner.tile.waitFor();
    await owner.page.locator('[data-app-tile="github"][data-github-state="connected"]').waitFor();
    assert.equal(await owner.page.locator('[data-featured-slot] [data-app-tile="github"][data-github-state="connected"]').count(), 1, "the connected tile stays in the Featured slot");
    assert.equal((await text(owner.tile)).includes("Connected by you"), false, "no Connected by you line");
    await contains(owner.tile.locator("[data-github-summary]"), "octo-user, octo-org · 5 repositories", "the accounts summary");
    assert.equal(await owner.tile.getByRole("button", { name: "Add account", exact: true }).isVisible(), false, "Add account is folded");
    const manage = owner.tile.locator("details[data-github-manage]");
    assert.equal(await manage.count(), 1, "one Manage section");
    await manage.locator("summary").click();
    await contains(manage, "Only the person who connected GitHub can give a bot access.", "the access text");
    for (const login of ["octo-user", "octo-org"]) assert.equal(await owner.tile.locator(`[data-github-account="${login}"]`).count(), 1, `the ${login} account row`);
    await contains(owner.tile.locator('[data-github-account="octo-user"]'), "2 repositories", "octo-user count");
    await contains(owner.tile.locator('[data-github-account="octo-org"]'), "3 repositories", "octo-org count");
    await contains(owner.tile.locator("[data-github-pending]"), "octo-corp", "the pending request");
    await contains(owner.tile.locator('[data-app-bots="github_app"]'), `Used by ${STARTER}`, "the bots that use GitHub");
    await manage.getByRole("button", { name: "Add account", exact: true }).waitFor();
    await manage.getByRole("button", { name: "Disconnect octo-user", exact: true }).waitFor();
    assert.equal(await owner.tile.locator("[data-github-readonly]").count(), 0, "no read-only note for the owner");
    await owner.tile.scrollIntoViewIfNeeded();
    await shot(owner.page, "02-apps-tile-connected-owner");
  });

  await check("03 the Which bots can use GitHub dialog lets the owner switch bots", async () => {
    await owner.tile.getByRole("button", { name: "Which bots can use GitHub?", exact: true }).click();
    const dialog = owner.page.locator('[data-app-grant-prompt="github_app"]');
    await dialog.waitFor();
    await dialog.getByRole("heading", { name: "Which bots can use GitHub?", exact: true }).waitFor();
    const starterSwitch = dialog.locator(`[data-github-bot="${owner.starterId}"] [role="switch"]`);
    const helperSwitch = dialog.locator(`[data-github-bot="${owner.helperId}"] [role="switch"]`);
    assert.equal(await starterSwitch.getAttribute("aria-checked"), "true", "the starter bot is on");
    assert.equal(await helperSwitch.getAttribute("aria-checked"), "false", "the second bot is off");
    assert.equal(await starterSwitch.isDisabled(), false, "the owner's switch works");
    assert.equal(await dialog.locator("[data-github-readonly]").count(), 0);
    await shot(owner.page, "03-which-bots-dialog-owner");
    await owner.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  });

  await check("04 the bot's Apps page lists its repositories under GitHub", async () => {
    await owner.openBot("apps");
    const view = owner.page.locator('[data-panel-page-view="apps"]');
    await view.waitFor();
    assert.equal(await view.locator('[data-simple-app="github_app"] [role="switch"]').getAttribute("aria-checked"), "true");
    const row = view.locator('[data-panel-page="github"]');
    await row.waitFor();
    await contains(row, "Repositories", "the Repositories row");
    await contains(row, "notes · api", "the repository names");
    await shot(owner.page, "04-bot-apps-page-repositories-row");
  });

  await check("05 the bot GitHub page shows repositories with levels and the two rules", async () => {
    await owner.page.locator('[data-panel-page="github"]').click();
    const page = owner.page.locator('[data-github-page="bot"]');
    await page.waitFor();
    const rows = page.locator('[data-panel-row="repo"]');
    assert.equal(await rows.count(), 2);
    await contains(rows.nth(0), "notes", "first repository");
    await contains(rows.nth(0), "Read", "first level");
    await contains(rows.nth(1), "api", "second repository");
    await contains(rows.nth(1), "Pull requests", "second level");
    for (const name of ["Ask before big changes", "Own branches only"]) {
      const rule = page.getByRole("switch", { name, exact: true });
      assert.equal(await rule.getAttribute("aria-checked"), "true", `${name} is on`);
      assert.equal(await rule.isDisabled(), false, `${name} can be changed by the owner`);
    }
    assert.equal(await page.locator('[data-panel-link="add-repos"]').count(), 1);
    await contains(page, `${STARTER} can use only the repositories above.`, "the owner note");
    await shot(owner.page, "05-bot-github-page-owner");
  });

  await check("06 the repository level page changes a level and the server stores it", async () => {
    await owner.page.locator('[data-github-page="bot"] [data-panel-row="repo"]').first().click();
    const page = owner.page.locator('[data-github-page="level"]');
    await page.waitFor();
    await contains(page, "octo-user/notes", "the repository title");
    const radios = page.locator('[role="radio"]');
    assert.equal(await radios.count(), 3);
    assert.equal(await page.locator('[data-panel-choice="read"]').getAttribute("aria-checked"), "true");
    await shot(owner.page, "06-repo-level-page");
    await page.locator('[data-panel-choice="write"]').click();
    await owner.page.locator('[data-github-page="level"] [data-panel-choice="write"][aria-checked="true"]').waitFor();
    const stored = (await owner.status()).bots[owner.starterId]!;
    assert.equal(stored.repos.find((repo) => repo.repositoryId === 1)?.level, "write", "the stored level is Write");
    assert.equal(stored.repos.find((repo) => repo.repositoryId === 11)?.level, "pull_requests", "the other repository is unchanged");
    await page.locator("[data-panel-back]").click();
    await owner.page.locator('[data-github-page="bot"]').waitFor();
  });

  await check("07 the add-repositories page lists the account repositories", async () => {
    await owner.page.locator('[data-panel-link="add-repos"]').click();
    const page = owner.page.locator('[data-github-page="add"]');
    await page.waitFor();
    const repo = (name: string) => page.locator(`[data-github-repo="${name}"]`);
    for (const name of ["octo-user/dotfiles", "octo-org/web", "octo-org/infra"]) {
      assert.equal(await repo(name).locator("input").isChecked(), false, `${name} is not chosen`);
      assert.equal(await repo(name).locator("input").isDisabled(), false, `${name} can be chosen`);
    }
    assert.equal(await repo("octo-user/notes").locator("input").isChecked(), true);
    assert.equal(await repo("octo-user/notes").locator("input").isDisabled(), true);
    await contains(repo("octo-user/notes"), "Added", "an added repository");
    await contains(repo("octo-org/infra"), "Private", "the private repository");
    await contains(repo("octo-user/dotfiles"), "Public", "a public repository");
    await page.locator('[data-panel-link="missing-repo"]').waitFor();
    await shot(owner.page, "07-add-repositories-page");
  });

  await check("08 Per-app tools for GitHub shows the repositories and levels above the tool list", async () => {
    await owner.page.evaluate(() => localStorage.setItem("seira-advanced-mode", "1"));
    await owner.page.reload();
    await owner.openBot();
    await owner.page.getByText("Per-app tools", { exact: true }).waitFor();
    await owner.page.locator("button[aria-expanded]", { hasText: "GitHub" }).click();
    const block = owner.page.locator('[data-github-block="summary"]');
    await block.waitFor();
    await contains(block, "octo-user/notes", "first repository");
    await contains(block, "Write", "first level after the change in 06");
    await contains(block, "octo-org/api", "second repository");
    await contains(block, "Pull requests", "second level");
    await contains(block, "The tools below work only in these repositories.", "the tools note");
    const placed = await block.evaluate((element: Element) => ({
      first: element.parentElement?.firstElementChild === element,
      toolsFollow: element.nextElementSibling !== null,
    }));
    assert.deepEqual(placed, { first: true, toolsFollow: true }, "the block opens the expanded panel, with the tools after it");
    await block.scrollIntoViewIfNeeded();
    await shot(owner.page, "08-per-app-tools-github-block");
    assert.deepEqual(owner.errors, []);
  }, "AC-17");

  const other = await open("other");
  await check("09 a person who is not the owner sees the tile read-only", async () => {
    await other.page.locator('[data-app-tile="github"][data-github-state="connected"]').waitFor();
    await contains(other.tile.locator("[data-github-readonly]"), `Only ${OTHER_OWNER.label} can change`, "the read-only text");
    await contains(other.tile.locator("[data-github-readonly]"), `${OTHER_OWNER.label} connected GitHub.`, "who connected GitHub");
    await contains(other.tile.locator("[data-github-summary]"), "octo-user, octo-org · 5 repositories", "the accounts summary");
    await other.tile.locator("details[data-github-manage] summary").click();
    assert.equal(await other.tile.locator('[data-github-account]').count(), 2, "the accounts are shown");
    assert.equal(await other.tile.getByRole("button", { name: "Add account", exact: true }).count(), 0, "no Add account");
    assert.equal(await other.tile.getByRole("button", { name: /^Disconnect / }).count(), 0, "no Disconnect");
    assert.equal(await other.tile.getByRole("button", { name: /^Connect GitHub/ }).count(), 0, "no Connect");
    await contains(other.tile.getByRole("button", { name: "Which bots can use GitHub?", exact: true }), "View", "the view button");
    await other.tile.scrollIntoViewIfNeeded();
    await shot(other.page, "09-apps-tile-non-owner");
  }, "AC-06");

  await check("10 the Which bots dialog is read-only for a person who is not the owner", async () => {
    await other.tile.getByRole("button", { name: "Which bots can use GitHub?", exact: true }).click();
    const dialog = other.page.locator('[data-app-grant-prompt="github_app"]');
    await dialog.waitFor();
    await contains(dialog, `${OTHER_OWNER.label} connected GitHub. Only ${OTHER_OWNER.label} can change which bots use it.`, "the dialog note");
    const switches = dialog.locator('[role="switch"]');
    assert.equal(await switches.count(), 2);
    for (let index = 0; index < 2; index += 1) assert.equal(await switches.nth(index).isDisabled(), true, `switch ${index} is disabled`);
    assert.equal(await dialog.locator(`[data-github-bot="${other.starterId}"] [role="switch"]`).getAttribute("aria-checked"), "true");
    await shot(other.page, "10-which-bots-dialog-non-owner");
    await other.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
  }, "AC-06");

  await check("11 the bot GitHub page is read-only for a person who is not the owner", async () => {
    await other.openBot("github");
    const page = other.page.locator('[data-github-page="bot"]');
    await page.waitFor();
    await contains(page.locator("[data-github-readonly]"), `Only ${OTHER_OWNER.label} can change what ${STARTER} can do there.`, "the read-only text");
    assert.equal(await page.locator('[data-panel-row="repo"]').count(), 2, "the repositories are shown");
    assert.equal(await page.locator('[data-panel-link="add-repos"]').count(), 0, "no Add repositories");
    for (const name of ["Ask before big changes", "Own branches only"]) {
      assert.equal(await page.getByRole("switch", { name, exact: true }).isDisabled(), true, `${name} is disabled`);
    }
    await shot(other.page, "11-bot-github-page-non-owner");
    await page.locator('[data-panel-row="repo"]').first().click();
    const level = other.page.locator('[data-github-page="level"]');
    await level.waitFor();
    for (const choice of ["read", "pull_requests", "write"]) assert.equal(await level.locator(`[data-panel-choice="${choice}"]`).isDisabled(), true, `${choice} is disabled`);
    await contains(level.locator("[data-github-readonly]"), `Only ${OTHER_OWNER.label} can change this.`, "the level page text");
    assert.equal(await level.locator('[data-panel-row="remove-repo"]').count(), 0, "no remove row");
  }, "AC-06");

  await check("12 the server refuses a change from a person who is not the owner", async () => {
    const before = readFileSync(join(other.fixture.info.dataDir, GITHUB_STORE_FILE), "utf8");
    const answer = await other.page.evaluate(async ([id, body]: [string, string]) => {
      const response = await fetch(`/api/github-app/bots/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body });
      return { status: response.status, body: await response.json() };
    }, [other.starterId, JSON.stringify({ ...starterPolicy(), repos: starterPolicy().repos.map((repo) => ({ ...repo, level: "write" })) })]);
    assert.equal(answer.status, 403, `the answer is 403, not ${answer.status}`);
    assert.equal(answer.body.error, `Only ${OTHER_OWNER.label} can change GitHub access.`);
    const status = await other.status();
    assert.deepEqual(status.bots[other.starterId], starterPolicy(), "the policy is unchanged");
    assert.equal(readFileSync(join(other.fixture.info.dataDir, GITHUB_STORE_FILE), "utf8"), before, "the stored file is unchanged");
    assert.deepEqual(other.errors, []);
  }, "AC-06");

  console.log(JSON.stringify({ passed: true, evidence: output, liveGithubTested: false }));
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.message : String(error));
  for (const [index, page] of pages.entries()) await page.screenshot({ path: join(output, `failed-${index}.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, "result.json"), `${JSON.stringify({
    passed: failure === undefined && checks.every((entry) => entry.passed), startedAt, liveGithubTested: false, checks,
  }, null, 2)}\n`);
  await browser.close();
  for (const { ui, fixture } of opened) { await ui.close(); await fixture.close(); }
  await broker.close();
}
