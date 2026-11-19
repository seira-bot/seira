import { describe, expect, it } from "vitest";

import { sha256 } from "./common";
import { DIAGNOSTICS, bugHarness, validReport, type FakeIssue } from "./test-harness";

type Harness = ReturnType<typeof bugHarness>;
const INSTALL = "install-id-for-tests-0001";

async function fileIssue(h: Harness, tool: string) {
  const response = await h.send(
    validReport({ description: `The ${tool} tool failed.`, diagnostics: DIAGNOSTICS.replaceAll("Bash", tool) }),
  );
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  const row = h.reportRows().find((candidate) => candidate.id === id)!;
  return { id, number: row.issue_number };
}

let counter = 0;
async function seedReport(h: Harness, issue: FakeIssue, installId = INSTALL) {
  counter += 1;
  const id = `br_seed${counter}`;
  h.d1.db
    .prepare("INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
    .run(id, await sha256(installId), `payload${counter}`, "0".repeat(16), issue.number, Math.floor(h.clock.ms / 1000));
  return id;
}

const ask = async (h: Harness, ids: string[], installId = INSTALL) => {
  const response = await h.status({ installId, ids });
  return { response, body: (await response.json()) as { reports: Array<{ id: string; status: string; fixedIn: string | null }>; notify: boolean } };
};

describe("AC-11 status", () => {
  it("answers unknown, received and fixed, and always notify true", async () => {
    const h = bugHarness();
    const open = await fileIssue(h, "Bash");
    const notPlanned = await fileIssue(h, "Edit");
    const done = await fileIssue(h, "Read");
    h.github.close(notPlanned.number, "not_planned");
    h.github.close(done.number, "completed");

    const { response, body } = await ask(h, [open.id, notPlanned.id, done.id, "br_neverSent"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body).toEqual({
      reports: [
        { id: open.id, status: "received", fixedIn: null },
        { id: notPlanned.id, status: "received", fixedIn: null },
        { id: done.id, status: "fixed", fixedIn: null },
        { id: "br_neverSent", status: "unknown", fixedIn: null },
      ],
      notify: true,
    });
  });

  it("answers unknown for a report of another install", async () => {
    const h = bugHarness();
    const mine = await fileIssue(h, "Bash");
    const { body } = await ask(h, [mine.id], "another-install-id");
    expect(body.reports).toEqual([{ id: mine.id, status: "unknown", fixedIn: null }]);
    expect(body.notify).toBe(true);
  });

  it("answers unknown for a report that is still being filed", async () => {
    const h = bugHarness();
    h.d1.db
      .prepare("INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)")
      .run("br_pending", await sha256(INSTALL), "p", "0".repeat(16), Math.floor(h.clock.ms / 1000));
    const { body } = await ask(h, ["br_pending"]);
    expect(body.reports).toEqual([{ id: "br_pending", status: "unknown", fixedIn: null }]);
    expect(h.github.requests).toHaveLength(0);
  });

  it("answers an empty list for no ids", async () => {
    const h = bugHarness();
    const { body } = await ask(h, []);
    expect(body).toEqual({ reports: [], notify: true });
  });

  it("serves the cache for 900 seconds and refreshes after", async () => {
    const h = bugHarness();
    const filed = await fileIssue(h, "Bash");
    expect((await ask(h, [filed.id])).body.reports[0]?.status).toBe("received");
    h.github.close(filed.number, "completed");
    const before = h.github.requests.length;

    h.clock.advance(600);
    expect((await ask(h, [filed.id])).body.reports[0]?.status).toBe("received");
    expect(h.github.requests).toHaveLength(before);

    h.clock.advance(300);
    expect((await ask(h, [filed.id])).body.reports[0]?.status).toBe("fixed");
    expect(h.github.requests.length).toBeGreaterThan(before);
  });

  it("refreshes at most 10 issues in one request", async () => {
    const h = bugHarness();
    const ids: string[] = [];
    for (let n = 0; n < 12; n += 1) ids.push(await seedReport(h, h.github.seed()));
    const gets = () => h.github.apiCalls().filter((call) => call.method === "GET").length;

    const first = await ask(h, ids);
    expect(gets()).toBe(10);
    expect(first.body.reports.map((report) => report.status)).toEqual(Array(12).fill("received"));

    await ask(h, ids);
    expect(gets()).toBe(12);
  });

  it("answers received when the refresh fails and there is no cache", async () => {
    const h = bugHarness();
    const issue = h.github.seed({ state: "closed", state_reason: "completed" });
    const id = await seedReport(h, issue);
    h.github.fail.getIssue = 500;
    expect((await ask(h, [id])).body.reports[0]?.status).toBe("received");
    h.github.fail.getIssue = undefined;
    expect((await ask(h, [id])).body.reports[0]?.status).toBe("fixed");
  });

  it("refuses bad requests", async () => {
    const h = bugHarness();
    expect((await h.status("{nope")).status).toBe(400);
    expect((await h.status({ installId: INSTALL, ids: ["bad id"] })).status).toBe(400);
    expect((await h.status({ installId: INSTALL, ids: Array.from({ length: 51 }, (_, n) => `br_${n}`) })).status).toBe(400);
    expect((await h.status({ ids: [] })).status).toBe(400);
    expect((await h.status({ installId: INSTALL, ids: [], pad: "x".repeat(17_000) })).status).toBe(413);
    h.limits.status = false;
    const limited = await h.status({ installId: INSTALL, ids: [] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(h.github.requests).toHaveLength(0);
  });
});

describe("AC-12 fixedIn rules", () => {
  const cases: Array<[string, string[], string | null, string | null]> = [
    ["the highest version over both label kinds", ["fixed-in:0.2.3", "released:v0.10.0"], null, "0.10.0"],
    ["a milestone with v", [], "v0.3.1", "0.3.1"],
    ["a milestone without v", [], "1.2.3", "1.2.3"],
    ["a label before the milestone", ["fixed-in:1.0.0"], "v2.0.0", "1.0.0"],
    ["a label that is not a version", ["fixed-in:latest"], null, null],
    ["a milestone that is not a version", ["bug"], "Next release", null],
    ["nothing", [], null, null],
  ];
  it.each(cases)("uses %s", async (_name, labels, milestone, expected) => {
    const h = bugHarness();
    const issue = h.github.seed({
      state: "closed",
      state_reason: "completed",
      labels: labels.map((name) => ({ name })),
      milestone: milestone ? { title: milestone } : null,
    });
    const id = await seedReport(h, issue);
    const { body } = await ask(h, [id]);
    expect(body.reports).toEqual([{ id, status: "fixed", fixedIn: expected }]);
  });

  it("gives no fixedIn for an issue that is not fixed", async () => {
    const h = bugHarness();
    const issue = h.github.seed({ state: "open", labels: [{ name: "fixed-in:1.0.0" }] });
    const id = await seedReport(h, issue);
    expect((await ask(h, [id])).body.reports).toEqual([{ id, status: "received", fixedIn: null }]);
  });
});
