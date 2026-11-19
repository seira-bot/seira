import { describe, expect, it } from "vitest";

import { bugHarness, validReport } from "./test-harness";

const NO_SECRETS = { GITHUB_APP_ID: "", GITHUB_APP_INSTALLATION_ID: "", GITHUB_APP_PRIVATE_KEY: "" };
const dryHarness = () => bugHarness({ DRY_RUN: "true", ...NO_SECRETS });
const MARKER = /^<!-- seira-fp:[0-9a-f]{16} -->/;

interface Answer {
  id: string;
  issue: number;
  joined: boolean;
  dryRun?: { title: string; body: string };
}

describe("AC-04 a report in dry-run mode", () => {
  it("answers id, issue, joined and the issue text, and sends no request to GitHub", async () => {
    const h = dryHarness();
    const response = await h.send(validReport());
    expect(response.status).toBe(201);
    const body = (await response.json()) as Answer;
    expect(body.id).toMatch(/^br_/);
    expect(body.issue).toBeGreaterThanOrEqual(9_000_000);
    expect(body.joined).toBe(false);
    expect(body.dryRun?.title).toBe("The Bash tool failed twice in a row.");
    expect(body.dryRun?.body).toMatch(MARKER);
    expect(h.github.requests).toHaveLength(0);
    expect(h.github.issues.size).toBe(0);
  });

  it("keeps the row and the fingerprint in D1, so the report counts in the limits", async () => {
    const h = dryHarness();
    const body = (await (await h.send(validReport())).json()) as Answer;
    expect(h.reportRows().map((row) => [row.id, row.issue_number])).toEqual([[body.id, body.issue]]);
    expect(h.d1.rows("SELECT * FROM fingerprints")).toHaveLength(1);
  });

  it("redacts the text in the issue text it answers", async () => {
    const h = dryHarness();
    const body = (await (await h.send(validReport({ description: "Mail me at someone@example.test, key sk-abcdefghijklmnopqrstuvwxyz123456." }))).json()) as Answer;
    const text = JSON.stringify(body.dryRun);
    expect(text).not.toContain("someone@example.test");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("gives the same issue number to the same error in a new Worker", async () => {
    const first = (await (await dryHarness().send(validReport())).json()) as Answer;
    const second = (await (await dryHarness().send(validReport())).json()) as Answer;
    expect(second.issue).toBe(first.issue);
  });

  it("still applies the per-install limit", async () => {
    const h = dryHarness();
    for (let n = 1; n <= 5; n += 1) expect((await h.sendNumbered(n)).response.status).toBe(201);
    expect((await h.sendNumbered(6)).response.status).toBe(429);
  });

  it("still answers 503 while reports are paused", async () => {
    const h = bugHarness({ DRY_RUN: "true", REPORTS_PAUSED: "true", ...NO_SECRETS });
    expect((await h.send(validReport())).status).toBe(503);
  });
});

describe("AC-05 no GitHub App secrets", () => {
  it("accepts a report when the three secrets are empty", async () => {
    const h = dryHarness();
    expect(h.env.GITHUB_APP_ID).toBe("");
    expect(h.env.GITHUB_APP_INSTALLATION_ID).toBe("");
    expect(h.env.GITHUB_APP_PRIVATE_KEY).toBe("");
    expect((await h.send(validReport())).status).toBe(201);
  });

  it("stores an IP hash although the private key is empty", async () => {
    const h = dryHarness();
    await h.send(validReport());
    expect(h.d1.rows<{ ip_hash: string }>("SELECT ip_hash FROM reports")[0]!.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AC-06 joined in dry-run mode", () => {
  it("answers joined true with the first issue number for the same error", async () => {
    const h = dryHarness();
    const first = await h.sendNumbered(1);
    const second = await h.sendNumbered(2);
    expect(second.body.joined).toBe(true);
    expect(second.body.issue).toBe(first.body.issue);
    expect(h.github.requests).toHaveLength(0);
  });

  it("answers the text of the comment, not of a new issue", async () => {
    const h = dryHarness();
    await h.sendNumbered(1);
    const second = await h.sendNumbered(2);
    const { dryRun } = (await second.response.json()) as Answer;
    expect(dryRun?.body).not.toMatch(MARKER);
    expect(dryRun?.body).toContain("The Bash tool failed, case 2.");
  });

  it("answers the same report again with joined true and the same issue", async () => {
    const h = dryHarness();
    await h.sendNumbered(1);
    const joined = await h.sendNumbered(2);
    const again = await h.sendNumbered(2);
    expect(again.body.id).toBe(joined.body.id);
    expect(again.body.issue).toBe(joined.body.issue);
    expect(again.body.joined).toBe(true);
  });

  it("answers joined false for another error", async () => {
    const h = dryHarness();
    await h.sendNumbered(1);
    const other = (await (await h.send(validReport({ diagnostics: "RangeError: z\n    at far (/srv/app/y.js:2:2)" }))).json()) as Answer;
    expect(other.joined).toBe(false);
  });
});

describe("AC-07 status in dry-run mode", () => {
  it("answers received for a report and sends no request to GitHub", async () => {
    const h = dryHarness();
    const { id } = (await (await h.send(validReport())).json()) as Answer;
    const response = await h.status({ installId: "install-id-for-tests-0001", ids: [id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reports: [{ id, status: "received", fixedIn: null }], notify: true });
    expect(h.github.requests).toHaveLength(0);
  });

  it("calls GitHub for the same status request when dry-run mode is off", async () => {
    const h = bugHarness();
    const { id } = (await (await h.send(validReport())).json()) as Answer;
    const before = h.github.requests.length;
    await h.status({ installId: "install-id-for-tests-0001", ids: [id] });
    expect(h.github.requests.length).toBeGreaterThan(before);
  });
});

describe("AC-08 health in dry-run mode", () => {
  it("answers ok dry-run", async () => {
    const h = dryHarness();
    const response = await h.call("/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok dry-run");
  });
});

describe("AC-09 dry-run mode needs the exact value true", () => {
  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true"])("calls GitHub when DRY_RUN is %j", async (value) => {
    const h = bugHarness(value === undefined ? {} : { DRY_RUN: value });
    const response = await h.send(validReport());
    expect(response.status).toBe(201);
    const body = (await response.json()) as Answer;
    expect(body.dryRun).toBeUndefined();
    expect(h.github.issues.size).toBe(1);
    expect(body.issue).toBe([...h.github.issues.values()][0]!.number);
    expect(h.github.requests.length).toBeGreaterThan(0);
    expect(await (await h.call("/health")).text()).toBe("ok");
  });
});
