import { describe, expect, it } from "vitest";
import { holdsCredential, redactSecretsInText } from "./redact.ts";

const TIME_BOUND_MS = 1000;

function elapsedMs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

describe("redaction runs in time linear in the text", () => {
  it.each([
    ["JWT: a hyphen before eyJ, repeated, with no closing dot", "-eyJ".repeat(16_000)],
    ["JWT: a long first part before a short second part", `${"-eyJ".repeat(16_000)}.a.bbbbbbbbbb`],
    ["PEM: BEGIN lines with no END line", "-----BEGIN PRIVATE KEY-----\n".repeat(32_000)],
    ["KEY_SUFFIX_ASSIGNMENT: a-, repeated, with no -key=", "a-".repeat(20_000)],
    ["KEY_VALUE: a-, repeated, before a word that is not a key", `${"a-".repeat(20_000)}x=12345678`],
    ["URL_USERINFO: a., repeated, with no ://", "a.".repeat(20_000)],
    ["URL_USERINFO: a., repeated, before :// with no userinfo", `${"a.".repeat(20_000)}://host/path`],
  ])("%s", (_name, text) => {
    expect(elapsedMs(() => redactSecretsInText(text))).toBeLessThan(TIME_BOUND_MS);
    expect(elapsedMs(() => holdsCredential(text))).toBeLessThan(TIME_BOUND_MS);
  });
});

describe("redaction still masks what it masked before", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it.each([
    [`token ${jwt} end`, `token «redacted ${jwt.length} chars» end`],
    [`x-${jwt}`, `x-«redacted ${jwt.length} chars»`],
    [`${jwt}--`, `«redacted ${jwt.length} chars»--`],
    ["-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----\n«redacted 7 chars»\n-----END RSA PRIVATE KEY-----"],
    ["OPENAI_API_KEY=abc", "OPENAI_API_KEY=«redacted 3 chars»"],
    ["9-xai-key=abc", "9-xai-key=«redacted 3 chars»"],
    ["hotkey=abc keyboard=abc", "hotkey=abc keyboard=abc"],
    ["db_password: hunter2hunter2", "db_password: «redacted 14 chars»"],
    ["my-token=abcdefgh", "my-token=«redacted 8 chars»"],
    ["mytoken=abcdefgh", "mytoken=abcdefgh"],
    ["postgres://admin:s3cret@db.example.test/app", "postgres://admin:«redacted 6 chars»@db.example.test/app"],
    ["git+https://user:pa55@example.test", "git+https://user:«redacted 4 chars»@example.test"],
  ])("%s", (text, expected) => {
    expect(redactSecretsInText(text)).toBe(expected);
  });

  it("sees a JWT as a credential", () => {
    expect(holdsCredential(`Bearer-less ${jwt}`)).toBe(true);
    expect(holdsCredential("eyJshort.eyJshort.eyJshort")).toBe(false);
  });
});
