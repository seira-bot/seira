import { describe, expect, it } from "vitest";

import type { DevsReportPayload } from "./devs-report.ts";
import { askReportStatus, bugReportEndpoint, bugReportsHomeSignature, bugReportStatusEndpoint, devsReportSender, devsStatusAsker, BUG_REPORT_SERVICE, sendDevsReport } from "./devs-report-send.ts";

const PAYLOAD: DevsReportPayload = {
  installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", source: "bot", description: "it broke", appVersion: "0.1.128", platform: "darwin arm64, desktop app",
  diagnostics: "Seira @devs report", contactEmail: "ada@example.com", contact: "ada@example.com",
};

function endpoint(...answers: Array<Response | Error>) {
  const sent: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no answer");
    return next;
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("sending a @devs report", () => {
  it("posts the payload as JSON and reads the report id", async () => {
    const { sent, fetcher } = endpoint(answer(201, { id: "6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c" }));
    expect(await sendDevsReport("https://cloud.example/api/bug-reports", PAYLOAD, fetcher)).toEqual({ ok: true, id: "6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(sent[0]!.body).toEqual(PAYLOAD);
  });

  it("reads the public issue's number, and whether the report joined an open issue, only when the relay says them well", async () => {
    const { fetcher } = endpoint(answer(201, { id: "r1", issue: 41 }), answer(201, { id: "r2", issue: 41, joined: true }),
      answer(201, { id: "r3", issue: "41", joined: "yes" }), answer(201, { id: "r4", issue: -2 }));
    const send = () => sendDevsReport("https://cloud.example/api/bug-reports", PAYLOAD, fetcher);
    expect(await send()).toEqual({ ok: true, id: "r1", issue: 41 });
    expect(await send()).toEqual({ ok: true, id: "r2", issue: 41, joined: true });
    expect(await send()).toEqual({ ok: true, id: "r3" });
    expect(await send()).toEqual({ ok: true, id: "r4" });
  });

  it("sends again without the address when the endpoint refuses only that", async () => {
    const { sent, fetcher } = endpoint(answer(400, { error: "contactEmail must be an email address of at most 254 characters, or left out." }), answer(201, { id: "r2" }));
    expect(await sendDevsReport("https://cloud.example/api/bug-reports", PAYLOAD, fetcher)).toEqual({ ok: true, id: "r2" });
    expect(sent.map(({ body }) => "contactEmail" in body || "contact" in body)).toEqual([true, false]);
  });

  it("tells a report worth sending later from one the endpoint refused", async () => {
    const send = async (...answers: Array<Response | Error>) => sendDevsReport("https://cloud.example/api/bug-reports", PAYLOAD, endpoint(...answers).fetcher);
    expect(await send(answer(429, { error: "Too many bug reports from this app.", retryAfter: 1_200 }))).toEqual({ ok: false, retry: true, why: "limited", retryAfterMs: 1_200_000 });
    expect(await send(answer(429, {}, { "retry-after": "90" }))).toEqual({ ok: false, retry: true, why: "limited", retryAfterMs: 90_000 });
    expect(await send(new TypeError("fetch failed"))).toEqual({ ok: false, retry: true, why: "offline" });
    expect(await send(answer(503, { error: "down" }))).toEqual({ ok: false, retry: true, why: "server" });
    expect(await send(answer(404, { error: "Not found." }))).toEqual({ ok: false, retry: true, why: "server" });
    expect(await send(answer(201, { id: "not an id!" }))).toEqual({ ok: false, retry: true, why: "server" });
    expect(await send(answer(400, { error: "description must be 1 to 10,000 characters of text." })))
      .toEqual({ ok: false, retry: false, why: "refused", detail: "description must be 1 to 10,000 characters of text." });
    expect(await send(answer(413, { error: "The bug report is larger than 600 KB." }))).toMatchObject({ ok: false, retry: false, why: "refused" });
  });

  it("never posts a body over the endpoint's 600 KB", async () => {
    const { sent, fetcher } = endpoint(answer(201, { id: "r3" }));
    const outcome = await sendDevsReport("https://cloud.example/api/bug-reports", { ...PAYLOAD, diagnostics: "x".repeat(700 * 1024) }, fetcher);
    expect(outcome).toMatchObject({ ok: false, retry: false, why: "refused" });
    expect(sent).toHaveLength(0);
  });
});

describe("where reports go", () => {
  it("is Seira's service when unset, a fixture's loopback or https address when set, else nowhere", () => {
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "http://127.0.0.1:4400/api/bug-reports" })).toBe("http://127.0.0.1:4400/api/bug-reports");
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: " https://reports.example/api/bug-reports " })).toBe("https://reports.example/api/bug-reports");
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "http://192.0.2.1/api/bug-reports" })).toBeNull();
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "https://user:pw@evil.example/x" })).toBeNull();
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "not an address" })).toBeNull();
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "off" })).toBeNull();
    expect(bugReportEndpoint({ SEIRA_CLOUD_STAGING: "1" })).toBe(BUG_REPORT_SERVICE);
    expect(bugReportEndpoint({})).toBe(BUG_REPORT_SERVICE);
    expect(bugReportEndpoint({ SEIRA_BUG_REPORT_URL: "  " })).toBe(BUG_REPORT_SERVICE);
  });

  it("sends nothing without an address and gives the person a prefilled issue form", async () => {
    const { sent, fetcher } = endpoint();
    const outcome = await devsReportSender(null, fetcher)(PAYLOAD);
    expect(outcome).toMatchObject({ ok: true });
    expect("issueUrl" in outcome && outcome.issueUrl.startsWith("https://github.com/seira-bot/seira/issues/new?template=bug_report.yml")).toBe(true);
    expect("issueUrl" in outcome && outcome.issueUrl).not.toContain("ada%40example.com");
    expect(await devsStatusAsker(null, null, fetcher)({ installId: PAYLOAD.installId, ids: ["r1"] })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("posts to an address that is set", async () => {
    const { sent, fetcher } = endpoint(answer(201, { id: "r9" }));
    expect(await devsReportSender("https://reports.example/api/bug-reports", fetcher)(PAYLOAD)).toEqual({ ok: true, id: "r9" });
    expect(sent.map(({ url }) => url)).toEqual(["https://reports.example/api/bug-reports"]);
  });
});

describe("the default Seira bug report service", () => {
  const DRAFT: DevsReportPayload = {
    ...PAYLOAD, title: "The sheet step failed", fingerprint: { kind: "tool-failed", step: "read_sheet" },
    diagnostics: "Seira @devs report\n\n## Recent problems in this conversation, newest last\ntool <file>.ts failed",
  };

  it("posts the report as the person read it, with no contact address, and says nobody replies by email", async () => {
    const { sent, fetcher } = endpoint(answer(201, { id: "br_abcdefghijklmnopqrstuv", issue: 42 }));
    expect(await devsReportSender(BUG_REPORT_SERVICE, fetcher)(DRAFT)).toEqual({ ok: true, id: "br_abcdefghijklmnopqrstuv", issue: 42, noReply: true });
    expect(sent.map(({ url }) => url)).toEqual([BUG_REPORT_SERVICE]);
    const { contactEmail: _email, contact: _contact, ...read } = DRAFT;
    expect(sent[0]!.body).toEqual(read);
    expect(JSON.stringify(sent[0]!.body)).not.toContain("ada@example.com");
  });

  it("keeps a report the service could not take, to go again later or be refused, never a form", async () => {
    const outcomes = [];
    for (const reply of [new TypeError("fetch failed"), answer(502, { error: "GitHub failed" }), answer(400, { error: "description must be text." })]) {
      outcomes.push(await devsReportSender(BUG_REPORT_SERVICE, endpoint(reply).fetcher)(DRAFT));
    }
    expect(outcomes).toEqual([{ ok: false, retry: true, why: "offline" }, { ok: false, retry: true, why: "server" },
      { ok: false, retry: false, why: "refused", detail: "description must be text." }]);
  });

  it("keeps a report the hourly limit held back, to go later", async () => {
    const { fetcher } = endpoint(answer(429, { error: "Too many reports.", retryAfter: 120 }));
    expect(await devsReportSender(BUG_REPORT_SERVICE, fetcher)(DRAFT)).toEqual({ ok: false, retry: true, why: "limited", retryAfterMs: 120_000 });
  });

  it("keeps the contact address for another address", async () => {
    const { sent, fetcher } = endpoint(answer(201, { id: "r9" }));
    expect(await devsReportSender("https://reports.example/api/bug-reports", fetcher)(DRAFT)).toEqual({ ok: true, id: "r9" });
    expect(sent[0]!.body).toEqual(DRAFT);
    expect(sent[0]!.body.contactEmail).toBe("ada@example.com");
  });

  it("asks its status unsigned, with no Cloud machine headers", async () => {
    const { sent, fetcher } = endpoint(answer(200, { reports: [], notify: true }));
    await devsStatusAsker(BUG_REPORT_SERVICE, { machineId: "m", bootstrapSecret: "s" }, fetcher)({ installId: PAYLOAD.installId, ids: ["br_x"] });
    expect(sent[0]!.url).toBe("https://bugs.seira.bot/api/bug-reports/status");
    expect(Object.keys(sent[0]!.init.headers as Record<string, string>).filter((name) => name.startsWith("x-omb-cloud"))).toEqual([]);
  });
});

describe("asking what became of the reports this app sent", () => {
  const QUESTION = { installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", ids: ["6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c"] };
  const ANSWER = { reports: [{ id: QUESTION.ids[0], status: "fixed", fixedIn: "0.1.135" }], notify: true };

  it("asks the report endpoint's origin, unsigned from the desktop and signed by a Cloud home with the secret it shares with the Admin", async () => {
    expect(bugReportStatusEndpoint("https://reports.example/api/bug-reports")).toBe("https://reports.example/api/bug-reports/status");
    expect(bugReportStatusEndpoint("http://127.0.0.1:4400/api/bug-reports")).toBe("http://127.0.0.1:4400/api/bug-reports/status");
    const desktop = endpoint(answer(200, ANSWER));
    expect(await devsStatusAsker("https://cloud.example/api/bug-reports", null, desktop.fetcher)(QUESTION)).toEqual(ANSWER);
    expect(desktop.sent[0]!.url).toBe("https://cloud.example/api/bug-reports/status");
    expect(desktop.sent[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(desktop.sent[0]!.body).toEqual(QUESTION);
    expect(Object.keys(desktop.sent[0]!.init.headers as Record<string, string>).filter((name) => name.startsWith("x-omb-cloud"))).toEqual([]);

    const home = { machineId: "cm-test-home", bootstrapSecret: "s".repeat(43) }, cloud = endpoint(answer(200, ANSWER));
    expect(await askReportStatus("https://cloud.example/api/bug-reports/status", QUESTION, home, cloud.fetcher, () => 1_792_670_400_000)).toEqual(ANSWER);
    const headers = cloud.sent[0]!.init.headers as Record<string, string>, raw = String(cloud.sent[0]!.init.body);
    expect(headers).toMatchObject({ "x-omb-cloud-machine": "cm-test-home", "x-omb-cloud-timestamp": "1792670400" });
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${bugReportsHomeSignature(home.bootstrapSecret, home.machineId, "1792670400", headers["x-omb-cloud-nonce"]!, raw)}`);
    expect(JSON.stringify(cloud.sent)).not.toContain(home.bootstrapSecret);
  });

  it("signs exactly as the Admin checks it", () => {
    // The same vector is pinned in the Cloud service's own tests.
    expect(bugReportsHomeSignature("s".repeat(43), "cm-test-home", "1792670400", "nonce-nonce-nonce-1", '{"installId":"install_0001","ids":[]}')).toBe("yk4dl82CpryMBfCaT18e_sJ6uihfo3dPHVP4prToXL8");
  });

  it("has no answer from an Admin before this route, a refusal, an answer it can't read, or no network: asked again later", async () => {
    const ask = async (reply: Response | Error) => askReportStatus("https://cloud.example/api/bug-reports/status", QUESTION, null, endpoint(reply).fetcher);
    expect(await ask(answer(404, { error: "Not found." }))).toBeNull();
    expect(await ask(answer(429, { error: "Too many questions.", retryAfter: 60 }))).toBeNull();
    expect(await ask(answer(200, { reports: [{ id: "x", status: "done", fixedIn: null }], notify: true }))).toBeNull();
    expect(await ask(answer(200, { reports: [{ id: "x", status: "fixed", fixedIn: "soon" }], notify: true }))).toBeNull();
    expect(await ask(answer(200, { reports: [] }))).toBeNull();
    expect(await ask(new TypeError("fetch failed"))).toBeNull();
    // Only what it was asked: at most 50 reports at once.
    const many = endpoint(answer(200, { reports: [], notify: true }));
    await askReportStatus("https://cloud.example/api/bug-reports/status", { ...QUESTION, ids: Array.from({ length: 60 }, (_, index) => `r${index}`) }, null, many.fetcher);
    expect((many.sent[0]!.body.ids as string[]).length).toBe(50);
  });
});
