import { describe, expect, it } from "vitest";

import { addedLines, applyAuditAllow, exemptFromGeneric, fileLines, findLeaks, lineHash, parseAuditAllow, privatePatterns } from "./check-local-leaks.mjs";

const labels = (lines, options) => findLeaks(lines, options).map((f) => `${f.path}:${f.line}: ${f.label}`);
const one = (text, path = "docs/setup.md") => labels([{ path, line: 1, text }]);

describe("generic rules", () => {
  it("finds a real home folder on each platform", () => {
    expect(one("run /home/alex/bin/tool")).toEqual(["docs/setup.md:1: home folder path (Linux)"]);
    expect(one('cwd: "/Users/milind/dev/app"')).toEqual(["docs/setup.md:1: home folder path (macOS)"]);
    expect(one("C:\\Users\\dana\\AppData")).toEqual(["docs/setup.md:1: home folder path (Windows)"]);
  });

  it("allows placeholders, container users and web routes", () => {
    for (const text of ["/home/node/app", "/home/you/.config", "/home/seira/.local/bin", "/Users/Shared/x", "https://x.com/home/feed/", "GET /users/42/"]) {
      expect(one(text)).toEqual([]);
    }
  });

  it("finds ls -l owner columns, private keys, provider keys and secret assignments", () => {
    expect(one("-rw-rw-r-- 1 alex alex 1198867 Nov 18 10:47 a.png")).toEqual(["docs/setup.md:1: ls -l output with owner names"]);
    expect(one("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["docs/setup.md:1: private key"]);
    expect(one(`token: ghp_${"a".repeat(36)}`)).toEqual(["docs/setup.md:1: provider API key"]);
    expect(one("DEPLOY_TOKEN=4f9c2a7e1b3d5f6a8c9e")).toEqual(["docs/setup.md:1: secret value in an assignment"]);
    expect(one("DEPLOY_TOKEN = config.f4c2a7e1b3d5f6a8c9e")).toEqual(["docs/setup.md:1: secret value in an assignment"]);
  });

  it("still reports real secret shapes", () => {
    for (const text of [
      'API_KEY = "a8f3k29dk3l2p0qz7x1m"',
      'GITHUB_TOKEN="Zq8xL2mN4pR7tV9wY3bC"',
      "DB_PASSWORD = s3cr3tP4ssw0rdValue",
      "SECRET='/ab+cd3/Ef9GhIjKlMnOp'",
      "DB_PASSWORD=correcthorsebatterystaple",
      'API_KEY = "ABCD1234EFGH5678IJKL"',
      "SECRET=/abcDEF123ghiJKL456mno",
      'SECRET="/AbCdEf123/GhIjKl456"',
    ]) {
      expect(one(text), text).toEqual(["docs/setup.md:1: secret value in an assignment"]);
    }
  });

  it("finds the internal-only marker in text and in a path", () => {
    const marker = ["INTERNAL", "ONLY"].join("-");
    expect(one(`<!-- ${marker} -->`)).toEqual(["docs/setup.md:1: internal-only marker"]);
    expect(one("ok", `docs/${marker}.md`)).toEqual([`docs/${marker}.md:1: internal-only marker`]);
    expect(one("internal-only notes")).toEqual([]);
  });

  it("allows an environment variable name", () => {
    expect(one('const CLOUD_SECRETS_FD_ENV = "SEIRA_CLOUD_SECRETS_FD";')).toEqual([]);
    expect(one("const CLOUD_SECRETS_FD_ENV = SEIRA_CLOUD_SECRETS_FD")).toEqual([]);
  });

  it("allows an HTTP header name", () => {
    expect(one('const CONTROL_TOKEN_HEADER = "x-seira-control-token";')).toEqual([]);
  });

  it("allows a regex literal and an array", () => {
    expect(one("const TOKEN = /^seira_t0_[a-f0-9]{48}$/;")).toEqual([]);
    expect(one("const CLOUD_SECRETS_FILE_KEYS = [...CLOUD_HOME_SECRET_KEYS, 'a'];")).toEqual([]);
  });

  it("allows an absolute path", () => {
    expect(one('const CLOUD_SECRETS_FILE = "/run/seira/secrets.json";')).toEqual([]);
  });

  it("allows a bare identifier", () => {
    expect(one("env.SEIRA_PHONE_SECRET_PUBLIC_KEY = secretPublicKey;")).toEqual([]);
    expect(one("const API_KEY = apiKeyFromConfig,")).toEqual([]);
  });

  it("allows a fixture or example value", () => {
    expect(one('const PLAN_TOKEN = "seira_x_verify_fixture";')).toEqual([]);
    expect(one("API_KEY=example-key-for-the-docs")).toEqual([]);
  });

  it("allows references to a secret", () => {
    for (const text of [
      "API_KEY=",
      "TOKEN=${TOKEN}",
      "API_KEY=<your key>",
      "SECRET='$SECRET_FROM_VAULT'",
      "childEnv.SEIRA_CLOUD_X_TOKEN = parentEnv.SEIRA_CLOUD_X_TOKEN;",
      "const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN_VALUE",
    ]) {
      expect(one(text)).toEqual([]);
    }
  });

  it("skips tests, fixtures and generated files", () => {
    for (const path of ["server/config.test.ts", "electron/x.node-test.mjs", "scripts/testing/fixtures/a.json", "src/locales/source-hashes.json", "evals/a.md"]) {
      expect(exemptFromGeneric(path)).toBe(true);
      expect(one("/home/alex/x/", path)).toEqual([]);
    }
    expect(exemptFromGeneric("server/config.ts")).toBe(false);
  });

  it("turns off the generic rules on request, for a merge", () => {
    expect(labels([{ path: "a.md", line: 1, text: "/home/alex/x/" }], { generic: false })).toEqual([]);
  });
});

describe("private patterns", () => {
  const privateRules = privatePatterns("# my machine\n\nmy-laptop\nalex\\.example\\.org\n");

  it("skips comments and blank lines", () => {
    expect(privateRules).toHaveLength(2);
  });

  it("apply to every file, without case, and to the path", () => {
    const lines = [
      { path: "server/a.test.ts", line: 3, text: "ssh MY-LAPTOP" },
      { path: "notes/my-laptop.md", line: 1, text: "clean" },
      { path: "README.md", line: 9, text: "mail alex.example.org" },
    ];
    expect(labels(lines, { privateRules, generic: false })).toEqual([
      "server/a.test.ts:3: private pattern from .leakcheck.local",
      "notes/my-laptop.md:1: private pattern from .leakcheck.local",
      "README.md:9: private pattern from .leakcheck.local",
    ]);
  });
});

describe("addedLines", () => {
  it("keeps only added lines, with their new line numbers", () => {
    const diff = [
      "diff --git a/x.md b/x.md",
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -3,0 +4,2 @@ heading",
      "+first",
      "+second",
      "@@ -9 +11 @@",
      "-old",
      "+new",
      "diff --git a/gone.md b/gone.md",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { path: "x.md", line: 4, text: "first" },
      { path: "x.md", line: 5, text: "second" },
      { path: "x.md", line: 11, text: "new" },
    ]);
  });
});

describe("fileLines", () => {
  it("numbers the lines of a text file", () => {
    expect(fileLines("a.txt", Buffer.from("x\ny"))).toEqual([
      { path: "a.txt", line: 1, text: "x" },
      { path: "a.txt", line: 2, text: "y" },
    ]);
  });

  it("checks a binary file only for home paths and private patterns", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from("tEXt /home/alex/x/ -----BEGIN RSA PRIVATE KEY-----")]);
    expect(labels(fileLines("a.png", png))).toEqual(["a.png:0: home folder path (Linux)"]);
  });
});

describe("applyAuditAllow", () => {
  const found = [
    { path: "a.ts", line: 1, label: "private key", text: "  const a = 1; // first  " },
    { path: "b.ts", line: 2, label: "private key", text: "const b = 2;" },
    { path: "a.ts", line: 9, label: "private key", text: "const second = 3;" },
  ];
  const entry = (f, extra = {}) => ({ path: f.path, rule: f.label, match: lineHash(f.text), reason: "x", ...extra });
  it("drops a finding whose path, rule and line hash match, and keeps the rest", () => {
    const { kept, stale } = applyAuditAllow(found, [entry(found[1])]);
    expect(kept).toEqual([found[0], found[2]]);
    expect(stale).toEqual([]);
  });
  it("hashes the trimmed line text", () => {
    expect(applyAuditAllow([found[0]], [entry({ ...found[0], text: "const a = 1; // first" })]).kept).toEqual([]);
  });
  it("keeps a second finding of the same rule in the same file", () => {
    const { kept } = applyAuditAllow(found, [entry(found[0])]);
    expect(kept).toEqual([found[1], found[2]]);
  });
  it("lets one entry hide one finding only", () => {
    const twin = { ...found[0], line: 20 };
    expect(applyAuditAllow([found[0], twin], [entry(found[0])]).kept).toEqual([twin]);
  });
  it("does not allow another rule in the same file", () => {
    expect(applyAuditAllow(found, [entry(found[0], { rule: "provider API key" })]).kept).toEqual(found);
  });
  it("reports an entry that matches nothing as stale", () => {
    const gone = entry({ path: "gone.ts", label: "private key", text: "x" });
    expect(applyAuditAllow(found, [gone]).stale).toEqual([gone]);
  });
  it("reports an entry as stale when the line text changed", () => {
    const edited = entry({ ...found[1], text: "const b = 3;" });
    const { kept, stale } = applyAuditAllow(found, [edited]);
    expect(kept).toEqual(found);
    expect(stale).toEqual([edited]);
  });
});

describe("parseAuditAllow", () => {
  const good = { path: "a.ts", rule: "private key", match: "a".repeat(64), reason: "x" };
  it("reads a valid list", () => {
    expect(parseAuditAllow(JSON.stringify([good]))).toEqual([good]);
  });
  it("throws one clear line for text that is not JSON", () => {
    expect(() => parseAuditAllow("[{ nope")).toThrow(/audit-allow\.json is not valid JSON/);
  });
  it("rejects a list that is not an array, or an entry without a hash", () => {
    expect(() => parseAuditAllow("{}")).toThrow(/must be a JSON array/);
    expect(() => parseAuditAllow(JSON.stringify([{ ...good, match: undefined }]))).toThrow(/entry 1 needs/);
    expect(() => parseAuditAllow(JSON.stringify([{ ...good, match: "xyz" }]))).toThrow(/entry 1 needs/);
  });
});
