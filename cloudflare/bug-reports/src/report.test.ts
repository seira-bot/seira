import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "./common";
import { recentDuplicate } from "./limits";
import { bodiesOf, bugHarness, validReport, type FakeIssue } from "./test-harness";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MARKER = /^<!-- seira-fp:([0-9a-f]{16}) -->/;

async function sendOk(h: ReturnType<typeof bugHarness>, n = 1) {
  const { response, body } = await h.sendNumbered(n);
  expect(response.status).toBe(201);
  return body.id!;
}

afterEach(() => vi.restoreAllMocks());

describe("AC-01 creates an issue", () => {
  it("creates one issue with labels, the marker at the start and rows in D1", async () => {
    const h = bugHarness();
    const response = await h.send(validReport());
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(ID);

    expect(h.github.issues.size).toBe(1);
    const issue = [...h.github.issues.values()][0] as FakeIssue;
    expect(issue.labels.map((label) => label.name)).toEqual(["bug", "from-app"]);
    expect(issue.body).toMatch(MARKER);
    expect(issue.title).toBe("The Bash tool failed twice in a row.");
    const hash = MARKER.exec(issue.body)![1]!;

    const create = h.github.apiCalls().find((call) => call.method === "POST");
    expect(create?.path).toBe("/repos/seira-bot/seira/issues");
    expect(create?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "seira-bug-reports",
    });

    const rows = h.reportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, issue_number: issue.number, fingerprint: hash, comment_id: null });
    expect(h.d1.rows("SELECT * FROM fingerprints")).toMatchObject([{ fingerprint: hash, issue_number: issue.number }]);
  });

  it("uses the title field for the issue title", async () => {
    const h = bugHarness();
    await h.send(validReport({ title: "Custom title" }));
    expect([...h.github.issues.values()][0]?.title).toBe("Custom title");
  });
});

describe("AC-02 comments on the open issue", () => {
  it("comments through the D1 fingerprint row", async () => {
    const h = bugHarness();
    await sendOk(h, 1);
    const callsBefore = h.github.apiCalls().length;
    const id = await sendOk(h, 2);
    expect(h.github.issues.size).toBe(1);
    expect(h.github.comments).toHaveLength(1);
    expect(h.github.comments[0]?.body).toContain(`<!-- seira-report:${id} -->`);
    expect(h.github.comments[0]?.body).toContain("Another report of this error.");
    const rows = h.reportRows();
    expect(rows[1]).toMatchObject({ id, issue_number: rows[0]!.issue_number, comment_id: h.github.comments[0]!.id });
    expect(h.github.apiCalls().slice(callsBefore).some((call) => call.path.startsWith("/search"))).toBe(false);
  });

  it("comments through the search path when D1 does not know the fingerprint", async () => {
    const h = bugHarness();
    await sendOk(h, 1);
    const [issue] = [...h.github.issues.values()];
    h.d1.db.exec("DELETE FROM fingerprints");
    await sendOk(h, 2);
    expect(h.github.issues.size).toBe(1);
    expect(h.github.comments).toMatchObject([{ issue: issue!.number }]);
    expect(h.github.apiCalls().some((call) => call.path === "/search/issues")).toBe(true);
    const search = h.github.apiCalls().find((call) => call.path === "/search/issues")!;
    const query = new URL(search.url).searchParams.get("q")!;
    expect(query).toMatch(/^"seira-fp:[0-9a-f]{16}" repo:seira-bot\/seira is:issue is:open in:body$/);
    expect(new URL(search.url).searchParams.get("per_page")).toBe("10");
  });

  it("ignores a search hit whose body does not start with the marker", async () => {
    const h = bugHarness();
    await sendOk(h, 1);
    const [issue] = [...h.github.issues.values()];
    const hash = MARKER.exec(issue!.body)![1]!;
    h.github.issues.clear();
    h.github.seed({ body: `Look at this: <!-- seira-fp:${hash} -->` });
    h.d1.db.exec("DELETE FROM fingerprints");
    await sendOk(h, 2);
    expect(h.github.comments).toHaveLength(0);
    expect(h.github.issues.size).toBe(2);
  });
});

describe("AC-02 search hits from other authors are ignored", () => {
  const spoofs: Array<[string, Partial<FakeIssue>]> = [
    ["a person", { user: { type: "User", login: "mallory" }, performed_via_github_app: null }],
    ["a bot of another App", { user: { type: "Bot", login: "other[bot]" }, performed_via_github_app: { id: 1 } }],
  ];
  it.each(spoofs)("creates a new issue when the marker issue comes from %s", async (_name, author) => {
    const h = bugHarness();
    await sendOk(h, 1);
    const [issue] = [...h.github.issues.values()];
    const hash = MARKER.exec(issue!.body)![1]!;
    h.github.issues.clear();
    h.github.seed({ body: `<!-- seira-fp:${hash} -->\nfake`, ...author });
    h.d1.db.exec("DELETE FROM fingerprints");
    await sendOk(h, 2);
    expect(h.github.comments).toHaveLength(0);
    expect(h.github.issues.size).toBe(2);
  });
});

describe("AC-09 slots are reserved before GitHub is called", () => {
  const pending = async (h: ReturnType<typeof bugHarness>, count: number, installId = "install-id-for-tests-0001") => {
    for (let n = 0; n < count; n += 1) {
      h.d1.db
        .prepare("INSERT INTO reports (id, install_hash, payload_hash, fingerprint, issue_number, comment_id, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)")
        .run(`br_pending${n}`, await sha256(installId), `p${n}`, "0".repeat(16), Math.floor(h.clock.ms / 1000));
    }
  };

  it("counts a pending row toward the per-install limit", async () => {
    const h = bugHarness();
    await pending(h, 5);
    const response = (await h.sendNumbered(1)).response;
    expect(response.status).toBe(429);
    expect(h.github.requests).toHaveLength(0);
  });

  it("does not return a pending row as a duplicate", async () => {
    const h = bugHarness();
    await pending(h, 1);
    const now = Math.floor(h.clock.ms / 1000);
    const install = await sha256("install-id-for-tests-0001");
    expect(await recentDuplicate(h.env, install, "p0", now)).toBeNull();
    h.d1.db.exec("UPDATE reports SET issue_number = 7");
    expect(await recentDuplicate(h.env, install, "p0", now)).toBe("br_pending0");
  });

  it("leaves 5 reports with 201 and 1 with 429 when 6 arrive in parallel", async () => {
    const h = bugHarness();
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => h.sendNumbered(n)));
    const statuses = results.map((result) => result.response.status).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(h.reportRows()).toHaveLength(5);
    expect(h.reportRows().every((row) => row.issue_number !== null)).toBe(true);
  });

  it("keeps no row after a GitHub failure", async () => {
    const h = bugHarness();
    h.github.fail.create = 500;
    expect((await h.send(validReport())).status).toBe(502);
    expect(h.d1.rows("SELECT * FROM reports")).toEqual([]);
  });
});

describe("AC-03 closed issue gets a new issue", () => {
  it("creates a new issue and maps the fingerprint to it", async () => {
    const h = bugHarness();
    await sendOk(h, 1);
    const [first] = [...h.github.issues.values()];
    h.github.close(first!.number, "completed");
    await sendOk(h, 2);
    expect(h.github.issues.size).toBe(2);
    expect(h.github.comments).toHaveLength(0);
    const second = [...h.github.issues.values()][1]!;
    expect(second.number).not.toBe(first!.number);
    expect(h.d1.rows("SELECT issue_number FROM fingerprints")).toEqual([{ issue_number: second.number }]);
  });
});

describe("AC-04 redacts", () => {
  it("keeps every kind of private text out of every GitHub request", async () => {
    const h = bugHarness();
    const installId = "inst-7f3a9c1e-secret-id";
    const description = [
      "Email me at alice@example.com please.",
      "File /home/alice/app/main.ts and C:\\Users\\alice\\app\\main.ts failed. Ask alice.",
      "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Key sk-ant-api03-abcdefghijklmnopqrstuv and AKIAABCDEFGHIJKLMNOP",
      "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "password=hunter2hunter2",
      "Authorization: Bearer abcdefghijklmnop12345",
      "Phones +62 812-3456-7890, 0812 3456 7890, 081234567890, (555) 123-4567, +1 415 555 0100",
      "URL https://bob:pw123456@example.com/path?token=abc&x=1#frag",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
      `install ${installId}`,
    ].join("\n");
    const diagnostics = [
      "## Recent problems in this conversation, newest last",
      `2026-11-19T10:00:00.000Z tool Bash failed: TypeError: bad input from alice@example.com (${installId})`,
      "",
      "## Server warnings and errors, newest last",
      "2026-11-19T10:00:01.000Z error cannot open /Users/alice/.config/x with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "    at run (/home/alice/app/server.js:1:2)",
      description,
    ].join("\n");
    const response = await h.send(validReport({ installId, description, diagnostics, title: "Crash for alice@example.com" }));
    expect(response.status).toBe(201);

    const sent = bodiesOf(h.github.apiCalls());
    const hidden = [
      "alice", "ghp_abcdef", "sk-ant-api03", "AKIAABCD", "eyJhbGci", "hunter2", "abcdefghijklmnop12345",
      "812-3456-7890", "3456 7890", "081234567890", "123-4567", "415 555 0100", "bob", "pw123456", "token=abc", "#frag",
      "BEGIN PRIVATE KEY", "MIIEvQ", installId, "inst-7f3a",
    ];
    for (const text of hidden) expect(sent, text).not.toContain(text);
    expect(sent).toContain("«email»");
    expect(sent).toContain("«phone»");
    expect(sent).toContain("«install»");
  });

  it("hides a user name in every field once any field shows it in a home path", async () => {
    const h = bugHarness();
    const response = await h.send(validReport({
      title: "Crash for Alice",
      description: "It broke for alice today.",
      diagnostics: "## Server warnings and errors, newest last\nerror cannot open /home/alice/notes.txt",
    }));
    expect(response.status).toBe(201);
    const sent = bodiesOf(h.github.apiCalls());
    expect(sent.toLowerCase()).not.toContain("alice");
    expect(sent).toContain("«user»");
  });
});

describe("AC-05 contact is dropped", () => {
  it("never reaches GitHub, D1 or the console", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      });
    }
    const h = bugHarness();
    const email = "zz-contact-7731@mail.test";
    const handle = "zz-handle-7731";
    const response = await h.send(validReport({ contactEmail: email, contact: handle }));
    expect(response.status).toBe(201);
    h.github.fail.comment = 500;
    await h.send(validReport({ description: "second", contactEmail: email, contact: handle }));

    const everything = [bodiesOf(h.github.requests), JSON.stringify(h.github.requests), h.everyTable(), logs.join("\n")].join("\n");
    expect(everything).not.toContain(email);
    expect(everything).not.toContain(handle);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("AC-06 413", () => {
  it("refuses a large content-length without reading the body or calling GitHub", async () => {
    const h = bugHarness();
    const response = await h.send("{}", { "content-length": "614401" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "The report is larger than 600 KB." });
    expect(h.github.requests).toHaveLength(0);
  });

  it("refuses a streamed body over the cap that has no content-length", async () => {
    const h = bugHarness();
    const chunk = new Uint8Array(100_000).fill(0x61);
    const total = 30;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await h.call("/api/bug-reports", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "content-type": "application/json" },
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(total);
    expect(h.github.requests).toHaveLength(0);
  });
});

describe("AC-07 400", () => {
  const cases: Array<[string, unknown]> = [
    ["bad JSON", "{not json"],
    ["missing description", (() => { const { description: _d, ...rest } = validReport(); return rest; })()],
    ["wrong source", validReport({ source: "user" })],
    ["appVersion of 41 characters", validReport({ appVersion: "9".repeat(41) })],
    ["description over the limit", validReport({ description: "x".repeat(10_001) })],
    ["control character in installId", validReport({ installId: "a\nb" })],
  ];
  it.each(cases)("answers 400 for %s", async (_name, body) => {
    const h = bugHarness();
    const response = await h.send(body);
    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: string };
    expect(answer.error).toBeTruthy();
    expect(answer.error).not.toMatch(/contact/i);
    expect(h.github.requests).toHaveLength(0);
  });

  it("accepts a contactEmail that is not a string", async () => {
    const h = bugHarness();
    const response = await h.send(validReport({ contactEmail: 12345, contact: { a: 1 } }));
    expect(response.status).toBe(201);
  });
});

describe("AC-08 429 per install", () => {
  it("allows 5 reports, refuses the 6th with a whole-second retryAfter, and allows again later", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 5; n += 1) {
      await sendOk(h, n);
      h.clock.advance(10);
    }
    const response = await h.sendNumbered(6).then((result) => result.response);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; retryAfter: number };
    const header = Number(response.headers.get("retry-after"));
    expect(Number.isInteger(body.retryAfter)).toBe(true);
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBe(header);
    expect(body.retryAfter).toBe(3600 - 50);
    expect(body.error).not.toMatch(/contact/i);

    h.clock.advance(3601);
    expect((await h.sendNumbered(7)).response.status).toBe(201);
  });
});

describe("AC-09 429 global and per IP", () => {
  it("refuses when all installs reached the hourly limit", async () => {
    const h = bugHarness({ GLOBAL_HOURLY_LIMIT: "3" });
    for (const install of ["a", "b", "c"]) {
      expect((await h.sendNumbered(1, `install-${install}`)).response.status).toBe(201);
    }
    const response = (await h.sendNumbered(1, "install-d")).response;
    expect(response.status).toBe(429);
    const body = (await response.json()) as { retryAfter: number };
    expect(body.retryAfter).toBe(Number(response.headers.get("retry-after")));
    expect(body.retryAfter).toBe(3600);
  });

  it("refuses when the per-IP limiter refuses", async () => {
    const h = bugHarness();
    h.limits.report = false;
    const response = await h.send(validReport(), { "cf-connecting-ip": "198.51.100.9" });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ retryAfter: 60 });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.limits.keys).toEqual(["198.51.100.9"]);
    expect(h.github.requests).toHaveLength(0);
  });
});

describe("AC-10 same payload again", () => {
  it("answers the first id and calls GitHub zero more times", async () => {
    const h = bugHarness();
    const first = await (await h.send(validReport())).json() as { id: string };
    const calls = h.github.requests.length;
    const again = await h.send(validReport({ contactEmail: "other@mail.test" }));
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ id: first.id });
    expect(h.github.requests).toHaveLength(calls);
    expect(h.reportRows()).toHaveLength(1);
  });

  it("files the report again after 24 hours", async () => {
    const h = bugHarness();
    await h.send(validReport());
    h.clock.advance(24 * 3600 + 1);
    const again = (await (await h.send(validReport())).json()) as { id: string };
    expect(h.reportRows()).toHaveLength(2);
    expect(again.id).toMatch(ID);
  });
});

describe("AC-13 GitHub down", () => {
  it("answers 502 and saves no row when GitHub cannot be reached", async () => {
    const h = bugHarness();
    h.github.fail.create = "throw";
    const response = await h.send(validReport());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "The report could not be filed. Try again later." });
    expect(h.reportRows()).toHaveLength(0);
    expect(h.d1.rows("SELECT * FROM fingerprints")).toHaveLength(0);
  });

  it("answers 502 for a GitHub 500, and the failed attempts do not count against the limit", async () => {
    const h = bugHarness();
    h.github.fail.create = 500;
    for (let n = 0; n < 6; n += 1) expect((await h.send(validReport())).status).toBe(502);
    expect(h.reportRows()).toHaveLength(0);
    h.github.fail.create = undefined;
    for (let n = 1; n <= 5; n += 1) expect((await h.sendNumbered(n)).response.status).toBe(201);
  });

  it("answers 502 when the token cannot be fetched or the comment fails", async () => {
    const h = bugHarness();
    h.github.fail.token = 500;
    expect((await h.send(validReport())).status).toBe(502);
    h.github.fail.token = undefined;
    await sendOk(h, 1);
    h.github.fail.comment = 500;
    expect((await h.sendNumbered(2)).response.status).toBe(502);
    expect(h.reportRows()).toHaveLength(1);
  });

  it("creates an issue when the lookups fail", async () => {
    const h = bugHarness();
    await sendOk(h, 1);
    h.github.fail.getIssue = "throw";
    h.github.fail.search = 500;
    expect((await h.sendNumbered(2)).response.status).toBe(201);
    expect(h.github.issues.size).toBe(2);
  });
});

describe("AC-17 429 per IP address", () => {
  const ipOf = (n: number) => ({ "cf-connecting-ip": n === 0 ? "198.51.100.20" : "198.51.100.21" });
  const from = (h: ReturnType<typeof bugHarness>, n: number, ip: number) =>
    h.send(validReport({ installId: `install-id-for-ip-test-${n}`, description: `The Bash tool failed, ip case ${n}.` }), ipOf(ip));

  it("refuses the 11th report from one IP address whatever the install ID, and does not call GitHub", async () => {
    const h = bugHarness();
    for (let n = 1; n <= 10; n += 1) expect((await from(h, n, 0)).status).toBe(201);
    const calls = h.github.requests.length;
    const response = await from(h, 11, 0);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; retryAfter: number };
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBe(Number(response.headers.get("retry-after")));
    expect(h.github.requests).toHaveLength(calls);
    expect((await from(h, 12, 1)).status).toBe(201);
  });

  it("keeps no raw IP address in any D1 table", async () => {
    const h = bugHarness();
    expect((await from(h, 1, 0)).status).toBe(201);
    expect((await from(h, 2, 1)).status).toBe(201);
    const dump = h.everyTable();
    expect(dump).not.toContain("198.51.100.20");
    expect(dump).not.toContain("198.51.100.21");
    expect(h.d1.rows<{ ip_hash: string }>("SELECT ip_hash FROM reports").every((row) => /^[0-9a-f]{64}$/.test(row.ip_hash))).toBe(true);
  });

  it("clears the IP hash of a row older than 3,600 seconds and keeps it inside the window", async () => {
    const h = bugHarness();
    expect((await from(h, 1, 0)).status).toBe(201);
    h.clock.advance(3000);
    expect((await from(h, 2, 0)).status).toBe(201);
    h.clock.advance(700);
    expect((await from(h, 3, 0)).status).toBe(201);
    const rows = h.d1.rows<{ ip_hash: string | null }>("SELECT ip_hash FROM reports ORDER BY rowid");
    expect(rows.map((row) => row.ip_hash !== null)).toEqual([false, true, true]);
  });
});

describe("AC-18 reports paused", () => {
  it("answers 503 to a report, does nothing else, and still answers status", async () => {
    const h = bugHarness({ REPORTS_PAUSED: "true" });
    const response = await h.send(validReport());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(h.github.requests).toHaveLength(0);
    expect(h.reportRows()).toHaveLength(0);
    expect((await h.status({ installId: "install-id-for-tests-0001", ids: [] })).status).toBe(200);
  });
});
