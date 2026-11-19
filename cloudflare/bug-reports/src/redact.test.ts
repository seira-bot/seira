import { describe, expect, it } from "vitest";

import { redact } from "./redact";

const INSTALL = "install-id-for-tests-0001";
const run = (text: string) => redact(text, { installId: INSTALL });

describe("AC-04 redact", () => {
  it("masks email addresses", () => {
    expect(run("write to alice.smith+tag@example.co.uk now")).toBe("write to «email» now");
  });

  it("masks home paths and the user name elsewhere", () => {
    const out = run("open /home/alice/app/main.ts and C:\\Users\\alice\\app\\main.ts, ask alice");
    expect(out).toBe("open ~/app/main.ts and ~\\app\\main.ts, ask «user»");
    expect(run("/Users/bobby/x /var/home/carol/y C:/Users/dave1/z")).toBe("~/x ~/y ~/z");
    expect(run("\"C:\\\\Users\\\\erin\\\\a\" by erin")).toBe("\"~\\\\a\" by «user»");
  });

  it("keeps shared profile folders as names that are not collected", () => {
    expect(run("C:\\Users\\Public\\x and Public docs")).toBe("~\\x and Public docs");
  });

  it("masks token shapes", () => {
    const out = run(
      [
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_abcdefghijklmnopqrstuvwxyz",
        "sk-ant-api03-abcdefghijklmnopqrstuv",
        "xoxb-1234567890-abcdef",
        "AKIAABCDEFGHIJKLMNOP",
        "AIzaSyA1234567890abcdefghijklmnopqrstuv",
        "ya29.a0AfH6SMBabcdefghij",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
        "Zm9vYmFyQmF6MTIzNDU2Nzg5MEFiQ2RFZkdoSWpLbE1uT3A",
      ].join("\n"),
    );
    expect(out).toBe(Array(9).fill("«redacted token»").join("\n"));
  });

  it("keeps a plain hex run such as a git SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(run(`commit ${sha}`)).toBe(`commit ${sha}`);
  });

  it("masks header values, bearer tokens and key=value secrets", () => {
    expect(run("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: «redacted»");
    expect(run("cookie: sid=abc; theme=dark")).toBe("cookie: «redacted»");
    expect(run("curl -H x Bearer abcdefgh12345678")).toBe("curl -H x Bearer «redacted»");
    expect(run("password=hunter2hunter2 next")).toBe("password=«redacted» next");
    expect(run('{"api_key": "abcdef123456"}')).toBe('{"api_key": "«redacted»"}');
    expect(run("client_secret: abcdefgh")).toBe("client_secret: «redacted»");
    expect(run("password=abc")).toBe("password=abc");
  });

  it("drops credentials and queries from URLs", () => {
    expect(run("see https://bob:pw123456@example.com/path/a?token=abc&x=1#frag now")).toBe(
      "see https://«redacted»@example.com/path/a?«redacted» now",
    );
    expect(run("https://example.com/docs#intro")).toBe("https://example.com/docs?«redacted»");
    expect(run("https://example.com/docs")).toBe("https://example.com/docs");
  });

  it("masks private key blocks", () => {
    const out = run("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADAN\nabc\n-----END RSA PRIVATE KEY-----\nafter");
    expect(out).toBe("before\n«redacted private key»\nafter");
  });

  it("masks the install id", () => {
    expect(run(`id ${INSTALL} and ${INSTALL}`)).toBe("id «install» and «install»");
  });

  it.each(["+62 812-3456-7890", "0812 3456 7890", "081234567890", "(555) 123-4567", "+1 415 555 0100"])(
    "masks the phone number %s",
    (phone) => {
      expect(run(`call ${phone} now`)).toBe("call «phone» now");
      expect(run(`call ${phone}, then`)).toBe("call «phone», then");
    },
  );

  it("keeps dates, times, versions, addresses and plain numbers", () => {
    const text = "2026-11-19T10:00:00.000Z 1763520000000 v0.1.172 10.0.0.1 port 18799 pid 123456 12:5 1.2.3.4567890";
    expect(run(text)).toBe(text);
    expect(run("at 2026-11-19 10:00:00")).toBe("at 2026-11-19 10:00:00");
  });
});

describe("redact speed", () => {
  const texts: Array<[string, string]> = [
    ["dots", "a.".repeat(100_000)],
    ["JWT starts", "eyJ".repeat(66_000)],
    ["token starts", "sk-".repeat(66_000)],
    ["key block starts", "-----BEGIN PRIVATE KEY-----".repeat(7000)],
    ["at signs", "a@".repeat(100_000)],
    ["key words", "token ".repeat(33_000)],
  ];
  it.each(texts)("redacts 200,000 characters of %s in under 500 ms", (_name, text) => {
    const start = performance.now();
    run(text);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
