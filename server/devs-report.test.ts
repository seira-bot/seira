import { describe, expect, it } from "vitest";

import { publicDevsReport } from "./bug-offer-report.ts";
import { buildDevsReport, cleanTitle, contactAddress, DEVS_REPORT_LIMITS, environmentSecrets, GENERIC_REPORT_TITLE, ownHostNames, redactReportText, withoutContact, type DevsReportInput } from "./devs-report.ts";

const ANTHROPIC = `sk-ant-${"a".repeat(40)}`;
const GITHUB = `ghp_${"b".repeat(36)}`;
const SLACK = `xoxb-${"1".repeat(12)}-${"c".repeat(24)}`;
const HELD = "plain-looking-value-without-a-shape";

function input(overrides: Partial<DevsReportInput> = {}): DevsReportInput {
  return {
    installId: "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e", appVersion: "0.1.128", platform: "darwin arm64, desktop app", os: "darwin 25.3.0 arm64",
    runsOn: "desktop app", node: "v24.1.0", uptimeSeconds: 7_380, language: "en", now: Date.UTC(2026, 9, 27, 9, 30),
    threadId: "thread-1", messageId: "message-1", where: "a chat with Scout",
    message: "@devs the send button froze", words: "the send button froze",
    bots: [{ id: "bot-1", name: "Scout", engine: "Claude Code", instanceId: "claude", model: "claude-opus-5-5", effort: "high", health: "available, signed in", apps: "not set up" }],
    problems: [], log: [], ...overrides,
  };
}

describe("a @devs report's redaction", () => {
  it("drops a quote's encoded copy, which it cannot read, from every field, and keeps the readable quote", () => {
    const marker = `<!--seira-citation-v1:${Buffer.from(JSON.stringify({ comment: GITHUB })).toString("base64url")}-->`;
    expect(redactReportText(`${marker}\n> Quoted message:\n> hi\n\nthe bot said ${marker} here`)).toBe("> Quoted message:\n> hi\n\nthe bot said  here");
    const sent = JSON.stringify(buildDevsReport(input({ message: `${marker}\n@devs it broke`, summary: { by: "Scout", text: { wentWrong: `see ${marker}` } } })));
    expect(sent).not.toContain("seira-citation");
  });

  it("masks key shapes, bearer and basic authorization, cookies, URL credentials and parameters, and private keys", () => {
    const text = [
      `key ${ANTHROPIC} and ${GITHUB} and ${SLACK}`,
      "Authorization: Bearer abcdefghijklmnop123456",
      "authorization: Basic dXNlcjpwYXNzd29yZA==",
      "Cookie: session=abc123; theme=dark",
      "set-cookie: sid=zzz999; HttpOnly",
      "fetch https://ada:hunter22@api.example.com/v1/items?token=t0p&sig=abc#frag failed",
      "fetch https://token123@git.example.com/repo.git failed",
      "api_key=supersecretvalue123 password: hunter2hunter2",
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactReportText(text, []);
    for (const secret of [ANTHROPIC, GITHUB, SLACK, "abcdefghijklmnop123456", "dXNlcjpwYXNzd29yZA==", "abc123", "zzz999", "hunter22", "t0p", "frag",
      "token123", "supersecretvalue123", "hunter2hunter2", "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("https://«redacted credentials»@api.example.com/v1/items?«redacted URL parameters»");
    expect(out).toContain("git.example.com/repo.git");
  });

  it("masks the server's own secret values wherever they appear, whatever their shape", () => {
    const secrets = environmentSecrets({ SEIRA_OPENAI_API_KEY: HELD, COMPOSIO_API_KEY: "short", SEIRA_DATA_DIR: "/Users/ada/Seira" });
    expect(secrets).toEqual([HELD]);
    expect(redactReportText(`upstream said ${HELD}!`, secrets)).toBe(`upstream said «redacted ${HELD.length} chars»!`);
  });

  it("is stable: redacting a redacted text changes nothing", () => {
    const once = redactReportText(`see https://u:p@h.example/x?y=1 and Cookie: a=b and Authorization: Basic Zm9vOmJhcg== and ${ANTHROPIC}`, []);
    expect(redactReportText(once, [])).toBe(once);
  });

  it("keeps version numbers, ids and plain prose", () => {
    const text = "0.1.128 on darwin arm64; thread 9f1e-6d5a; the picture never loaded";
    expect(redactReportText(text, [])).toBe(text);
  });
});

describe("a @devs report's payload", () => {
  it("carries the person's message, the bot's summary and the facts, redacted, in the endpoint's fields", () => {
    const payload = buildDevsReport(input({
      message: `@devs it broke, my key is ${ANTHROPIC}`, words: `it broke, my key is ${ANTHROPIC}`,
      summary: { by: "Scout", text: { wentWrong: "Sending froze", seen: `The Bash tool failed with ${GITHUB}`, steps: "1. Send a picture" } },
      problems: ["2026-10-27T09:29:00.000Z tool Bash failed: exit code 1"], log: [`2026-10-27T09:29:01.000Z error upstream 401 Bearer ${"z".repeat(30)}`],
      contactEmail: " Ada@Example.com ",
    }), []);
    expect(Object.keys(payload).sort()).toEqual(["appVersion", "contact", "contactEmail", "description", "diagnostics", "installId", "platform", "source", "title"]);
    expect(payload).toMatchObject({ source: "bot", appVersion: "0.1.128", platform: "darwin arm64, desktop app", contactEmail: "ada@example.com", contact: "ada@example.com" });
    expect(payload.description.split("\n")[0]).toBe(`it broke, my key is «redacted ${ANTHROPIC.length} chars»`);
    expect(payload.description).toContain("Scout's summary: Sending froze");
    expect(payload.description).toContain("Steps to reproduce: 1. Send a picture");
    expect(payload.diagnostics).toContain("Engine: Claude Code (claude), model claude-opus-5-5, effort high");
    expect(payload.diagnostics).toContain("tool Bash failed: exit code 1");
    expect(payload.diagnostics).toContain("Runs on: desktop app");
    expect(payload.diagnostics).toContain("Server uptime: 2h 3m");
    const whole = JSON.stringify(payload);
    for (const secret of [ANTHROPIC, GITHUB, "z".repeat(30)]) expect(whole).not.toContain(secret);
  });

  it("says why there is no summary when no bot wrote one, and leaves the address out when there is none", () => {
    const payload = buildDevsReport(input({ noSummary: "the bot did not call report_bug", contactEmail: "not an address" }), []);
    expect(payload.description).toContain("No summary from a bot: the bot did not call report_bug.");
    expect(payload.diagnostics).toContain("Summary from a bot: no, the bot did not call report_bug");
    expect(payload).not.toHaveProperty("contactEmail");
    expect(payload).not.toHaveProperty("contact");
    expect(buildDevsReport(input({ words: "" }), []).description.split("\n")[0]).toBe("(no words besides @devs)");
  });

  it("stays inside the endpoint's limits however much there is", () => {
    const huge = "x".repeat(50_000);
    const payload = buildDevsReport(input({
      message: huge, words: huge, appVersion: `0.1.128-${"b".repeat(80)}`, platform: `linux x64\n${"p".repeat(80)}`,
      summary: { by: "Scout", text: { wentWrong: huge, seen: huge, steps: huge } },
      problems: Array.from({ length: 500 }, (_, i) => `problem ${i} ${huge}`), log: Array.from({ length: 5_000 }, (_, i) => `line ${i} ${huge}`),
    }), []);
    expect(payload.description.length).toBeLessThanOrEqual(DEVS_REPORT_LIMITS.description);
    expect(payload.diagnostics.length).toBeLessThanOrEqual(DEVS_REPORT_LIMITS.diagnostics);
    expect(payload.appVersion.length).toBeLessThanOrEqual(40);
    expect(payload.platform.length).toBeLessThanOrEqual(40);
    expect(payload.platform).not.toMatch(/\p{Cc}/u);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(DEVS_REPORT_LIMITS.body);
    expect(payload.diagnostics).toContain("line 4999");
    expect(payload.diagnostics).not.toContain("line 4919 ");
  });

  it("drops both address fields together", () => {
    const payload = buildDevsReport(input({ contactEmail: "ada@example.com" }), []);
    expect(withoutContact(payload)).not.toHaveProperty("contactEmail");
    expect(withoutContact(payload)).not.toHaveProperty("contact");
  });
});

describe("the person's address", () => {
  it("is one the endpoint accepts, lower-cased, or nothing", () => {
    expect(contactAddress(" Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com", `${"a".repeat(250)}@example.com`, undefined, null]) {
      expect(contactAddress(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("a @devs report's title", () => {
  const titleOf = (overrides: Partial<DevsReportInput>) => buildDevsReport(input(overrides), []).title;
  const wentWrong = (text: string) => ({ by: "Scout", text: { wentWrong: text } });

  it("takes the first sentence of the bot's summary, without hosts, URLs, addresses, account names or paths, and falls back to the person's words", () => {
    expect(titleOf({ words: "send ke", summary: wentWrong("Sending a picture froze the composer. Steps follow.\nMore lines.") })).toBe("Sending a picture froze the composer");
    const unsafe = titleOf({ summary: wentWrong("Login on https://app.example.com/a?token=1 and api.example.org:8443 failed for @ada, ada@example.com, 10.0.0.7 in /home/ada/x") });
    expect(unsafe).toBe("Login on and failed for, in");
    expect(unsafe).not.toMatch(/example|ada|10\.0|home|token/);
    const long = titleOf({ summary: wentWrong("The composer froze after sending a very large picture from the clipboard while the bot was still answering a long question") })!;
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
    expect(titleOf({ words: "the button froze", summary: wentWrong("https://example.com/only-a-url") })).toBe("the button froze");
    expect(titleOf({ words: "the button froze", summary: undefined })).toBe("the button froze");
    expect(titleOf({ words: "see https://example.com", summary: undefined })).toBe("Bug report from Seira");
  });

  it("drops Windows and UNC paths, IPv6 addresses, local and one-label hosts and ports", () => {
    const cases: Array<[string, string]> = [
      ["The export failed in C:\\Users\\Ada Lovelace\\Documents\\plan.xlsx today", "The export failed in today"],
      ["The export failed in C:/Users/ada/plan.xlsx today", "The export failed in today"],
      ["The sync failed for \\\\fileserver\\team share\\plan.xlsx today", "The sync failed for today"],
      ["Connecting to [2001:db8::7334]:8443 timed out every time", "Connecting to timed out every time"],
      ["Connecting to fe80::1ff:fe23:4567:890a timed out every time", "Connecting to timed out every time"],
      ["Opening localhost:3000 shows a blank page", "Opening shows a blank page"],
      ["Opening http://localhost:3000/a shows a blank page", "Opening shows a blank page"],
      ["Reaching nas-office:5000 shows a blank page", "Reaching shows a blank page"],
      ["Reaching nas.local shows a blank page", "Reaching shows a blank page"],
    ];
    for (const [text, expected] of cases) expect(titleOf({ summary: wentWrong(text) }), text).toBe(expected);
  });

  it("drops the names of the people it is told about and this machine's host name", () => {
    const redact = (text: string) => redactReportText(text, []);
    expect(cleanTitle("Ada Lovelace says the composer froze", { redact, names: ["Ada Lovelace"] })).toBe("says the composer froze");
    expect(cleanTitle("Budi cannot send pictures from the composer", { redact, names: ["Budi"] })).toBe("cannot send pictures from the composer");
    expect(cleanTitle("Sync stopped on atlas-box overnight", { redact, names: ["atlas-box"] })).toBe("Sync stopped on overnight");
    expect(ownHostNames("my-laptop-4.home.arpa")).toEqual(["my-laptop-4.home.arpa", "my-laptop-4"]);
  });

  it("drops a known name before the length cut, so the public report never keeps half of it", () => {
    const lead = "The composer froze after sending a very large picture from the clipboard";
    const names = ["Ada Lovelace"];
    const text = `${lead} Ada Lovelace was waiting for the answer`;
    // Without the names the cut falls inside the name: this is the leak the first pass closes.
    expect(cleanTitle(text, { redact: (value) => value })).toMatch(/Ada/);
    const built = buildDevsReport(input({ names, summary: wentWrong(text) }), []);
    expect(built.title).not.toMatch(/Ada|Lovel/);
    const published = publicDevsReport(built, [], { names });
    expect(published.title).not.toMatch(/Ada|Lovel/);
    expect(published.title).toBe(built.title);
    expect((published.title ?? "").length).toBeLessThanOrEqual(80);
    expect(publicDevsReport(buildDevsReport(input({ names, words: text, summary: undefined }), []), [], { names }).title).not.toMatch(/Ada|Lovel/);
  });

  it("also drops the bot's name, the one who wrote the summary and this install's id from the first pass", () => {
    const installId = "4b7c1f2e-0a9d-4c2b-9f1e-6d5a4b3c2d1e";
    expect(titleOf({ summary: wentWrong("Scout cannot read the sheet after the update") })).toBe("cannot read the sheet after the update");
    expect(titleOf({ installId: "inst-77a1b2", summary: wentWrong("Install inst-77a1b2 cannot send pictures") })).toBe("Install cannot send pictures");
    expect(titleOf({ installId, summary: wentWrong(`Install ${installId} cannot send pictures`) })).not.toContain("4b7c1f2e");
  });

  it("keeps secrets first when the names are known too", () => {
    const held = "Zq9xK2mP.rTzwab9";
    const built = buildDevsReport(input({ names: ["Ada Lovelace"], words: "", summary: wentWrong(`Ada Lovelace says the key ${held} was refused`) }), [held]);
    expect(built.title).toBe("says the key was refused");
    expect(JSON.stringify(built)).not.toMatch(/Zq9|rTzwab|wab9/);
  });

  it("uses the fixed generic title when nothing safe is left, never an empty one", () => {
    for (const text of ["C:\\Users\\ada", "\\\\fileserver\\share", "[::1]:8080", "localhost:3000", "@ada", "ada@example.com", "ok", ""]) {
      expect(titleOf({ words: text, summary: undefined }), text).toBe(GENERIC_REPORT_TITLE);
    }
    expect(buildDevsReport(input({ words: "", summary: undefined }), []).title).toBe("Bug report from Seira");
  });

  it("redacts secrets on the original text before any other title rule", () => {
    // A rule that cuts a host-like piece out of a secret would leave a rest that redaction cannot know.
    const held = "Zq9xK2mP.rTzwab9";
    const payload = buildDevsReport(input({ words: "", summary: wentWrong(`The key ${held} was refused by the relay`) }), [held]);
    expect(payload.title).toBe("The key was refused by the relay");
    expect(payload.description).not.toContain(held);
    expect(payload.description).toContain(`«redacted ${held.length} chars»`);
    expect(JSON.stringify(payload)).not.toMatch(/Zq9|rTzwab|wab9/);
    const withKey = buildDevsReport(input({ words: "", summary: wentWrong(`Auth failed with ${ANTHROPIC} again`) }), []);
    expect(withKey.title).toBe("Auth failed with again");
  });
});
