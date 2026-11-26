// Cost of `redactSecretsInText`: long input must cost linear time and must still be masked.
import { describe, expect, it } from "vitest";

import { REDACT_SCAN_LIMIT, addHeldSecretScrubber, holdsCredential, redactSecretsInText } from "./redact.ts";

const LONG = 400_000;
// Before the fix these shapes cost minutes at this size. The limit is far above a healthy run (a few ms) and far below that.
const TIME_LIMIT_MS = 3000;
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl`;
const PEM = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`;

function timed(text: string): { out: string; ms: number } {
  const start = performance.now();
  const out = redactSecretsInText(text);
  return { out, ms: performance.now() - start };
}

describe("redactSecretsInText cost", () => {
  const shapes: Record<string, string> = {
    "a name run split by dashes": "a-".repeat(LONG / 2),
    "a scheme-like run split by dots": "a.".repeat(LONG / 2),
    "repeated jwt starts": "eyJ-".repeat(LONG / 4),
    "many private key starts without an end": "-----BEGIN PRIVATE KEY-----\n".repeat(LONG / 28),
    "a name run that ends in an equals sign": `${"a-".repeat(LONG / 2)}=`,
    "repeated key suffix": "a-a-a-key ".repeat(LONG / 10),
    "repeated key words": "token=".repeat(LONG / 6),
    "long white space after a bearer word": `Bearer${" ".repeat(LONG)}`,
    "long white space after a secret flag": `--token${" ".repeat(LONG)}`,
    "a long user name in a url": `http://${"a".repeat(LONG)}`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    it(`finishes in bounded time for ${name}`, () => {
      expect(timed(text).ms).toBeLessThan(TIME_LIMIT_MS);
    });
  }

  it("still masks a secret that follows a long unbroken run", () => {
    const run = "a-".repeat(LONG / 2);
    expect(timed(`${run} api_key=abcdefgh12345`).out.endsWith("api_key=«redacted 13 chars»")).toBe(true);
    expect(timed(`${run} X_KEY=abc`).out.endsWith("X_KEY=«redacted 3 chars»")).toBe(true);
    expect(timed(`${"a.".repeat(LONG / 2)} https://user:hunter2hunter2@example.test/x`).out).toContain("https://user:«redacted 14 chars»@example.test/x");
    expect(timed(`${"eyJ-".repeat(LONG / 4)} ${JWT}`).out.endsWith(` «redacted ${JWT.length} chars»`)).toBe(true);
  });

  it("masks a private key block that follows many unfinished starts", () => {
    const out = timed(`${"-----BEGIN PRIVATE KEY-----\n".repeat(2000)}${PEM}`).out;
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(out.endsWith("-----END PRIVATE KEY-----")).toBe(true);
  });
});

describe("redactSecretsInText coverage", () => {
  it("masks a jwt, with or without text joined to its start by a dash", () => {
    expect(redactSecretsInText(`token ${JWT} sent`)).toBe(`token «redacted ${JWT.length} chars» sent`);
    expect(redactSecretsInText(`id-${JWT}`)).toBe(`id-«redacted ${JWT.length} chars»`);
    expect(redactSecretsInText(`${JWT}\n${JWT}`)).toBe(`«redacted ${JWT.length} chars»\n«redacted ${JWT.length} chars»`);
    expect(holdsCredential(`id-${JWT}`)).toBe(true);
    expect(holdsCredential("eyJabcdefgh.short")).toBe(false);
  });

  it("masks key assignments, even when the name has a long prefix", () => {
    expect(redactSecretsInText("my-api_key=abcdefgh1234")).toBe("my-api_key=«redacted 12 chars»");
    expect(redactSecretsInText(`${"x".repeat(300)}_token="abcdefgh1234"`)).toBe(`${"x".repeat(300)}_token="«redacted 12 chars»"`);
    expect(redactSecretsInText("XAI_API_KEY=abc")).toBe("XAI_API_KEY=«redacted 3 chars»");
    expect(redactSecretsInText("hotkey=abcdefgh")).toBe("hotkey=abcdefgh");
    expect(redactSecretsInText("mytoken=abcdefgh")).toBe("mytoken=abcdefgh");
  });

  it("masks the password in a url and leaves a url without one", () => {
    expect(redactSecretsInText("postgres://app:s3cr3t-pass@db.example.test:5432/x")).toBe("postgres://app:«redacted 11 chars»@db.example.test:5432/x");
    expect(redactSecretsInText("https://example.test/path?q=1")).toBe("https://example.test/path?q=1");
  });

  it("masks private key blocks and keeps text around them", () => {
    expect(redactSecretsInText(`before\n${PEM}\nafter`)).toBe("before\n-----BEGIN PRIVATE KEY-----\n«redacted 32 chars»\n-----END PRIVATE KEY-----\nafter");
    expect(redactSecretsInText(`${PEM}\n${PEM}`).match(/«redacted 32 chars»/g)).toHaveLength(2);
    // A block with no end is left as it is: nothing says where the key stops.
    expect(redactSecretsInText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq")).toBe("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq");
  });

  it("is idempotent", () => {
    const text = `${JWT} api_key=abcdefgh1234 https://u:pw123456@h.test/ ${PEM} --token abcdef Bearer abcdefghijklmnop`;
    const once = redactSecretsInText(text);
    expect(redactSecretsInText(once)).toBe(once);
  });
});

describe("redactSecretsInText scan limit", () => {
  const filler = (size: number) => "lorem ipsum dolor sit amet\n".repeat(Math.ceil(size / 27)).slice(0, size);

  it("leaves text under the limit to the matchers", () => {
    const text = `${filler(REDACT_SCAN_LIMIT / 2)} api_key=abcdefgh1234`;
    expect(redactSecretsInText(text).endsWith("api_key=«redacted 12 chars»")).toBe(true);
  });

  it("masks an oversize text whole, before any stage runs", () => {
    const secret = "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const text = `head api_key=abcdefgh1234\n${filler(REDACT_SCAN_LIMIT)}\n${secret} tail`;
    const { out, ms } = timed(text);
    expect(ms).toBeLessThan(TIME_LIMIT_MS);
    expect(out.startsWith(`[redacted ${text.length} chars]`)).toBe(true);
    expect(out).not.toContain("sk-ant");
    expect(out).not.toContain("abcdefgh1234");
    expect(redactSecretsInText(out)).toBe(out);
  });

  it("masks an oversize text before the held-secret scrubbers run", () => {
    let calls = 0;
    const remove = addHeldSecretScrubber((t) => { calls++; return t; });
    try {
      redactSecretsInText("A".repeat(REDACT_SCAN_LIMIT + 1));
      expect(calls).toBe(0);
      redactSecretsInText("A".repeat(REDACT_SCAN_LIMIT));
      expect(calls).toBe(1);
    } finally { remove(); }
  });

  it("masks an oversize unbroken run whole", () => {
    const out = redactSecretsInText(`start ${"A".repeat(REDACT_SCAN_LIMIT + 10)}`);
    expect(out.startsWith(`[redacted ${REDACT_SCAN_LIMIT + 16} chars]`)).toBe(true);
    expect(out).not.toContain("AAAA");
  });

  // A caller that counts the redacted text (a size limit, a page of rows, a file cap) must count what it counted before.
  describe("keeps the length and the UTF-8 size of the text it masks", () => {
    const bytes = (text: string) => Buffer.byteLength(text);
    const shapes: Record<string, string> = {
      ascii: "word ",
      "two-byte": "é",
      "three-byte": "€",
      "four-byte": "😀",
      mixed: "a€é😀 ",
    };
    for (const [name, unit] of Object.entries(shapes)) {
      it(name, () => {
        const text = unit.repeat(Math.ceil((REDACT_SCAN_LIMIT + 1) / unit.length)).concat("é");
        const out = redactSecretsInText(text);
        expect(out.length).toBe(text.length);
        expect(bytes(out)).toBe(bytes(text));
        expect(out).not.toBe(text);
        expect(redactSecretsInText(out)).toBe(out);
      });
    }

    it("when the text has only 3-byte characters, so no room is left for the marker", () => {
      const text = "€".repeat(REDACT_SCAN_LIMIT + 1);
      const out = redactSecretsInText(text);
      expect(out.length).toBe(text.length);
      expect(bytes(out)).toBe(bytes(text));
      expect(redactSecretsInText(out)).toBe(out);
    });

    it("a lone surrogate counts as 3 bytes, like Buffer counts it", () => {
      const text = `${"a".repeat(REDACT_SCAN_LIMIT)}\ud800\ud83d`;
      const out = redactSecretsInText(text);
      expect(out.length).toBe(text.length);
      expect(bytes(out)).toBe(bytes(text));
    });
  });
});
