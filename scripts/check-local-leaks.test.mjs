import { describe, expect, it } from "vitest";

import { addedLines, exemptFromGeneric, fileLines, findLeaks, privatePatterns } from "./check-local-leaks.mjs";

const labels = (lines, options) => findLeaks(lines, options).map((f) => `${f.path}:${f.line}: ${f.label}`);
const one = (text, path = "docs/setup.md") => labels([{ path, line: 1, text }]);

describe("generic rules", () => {
  it("finds a real home folder on each platform", () => {
    expect(one("run /home/alex/bin/tool")).toEqual(["docs/setup.md:1: home folder path (Linux)"]);
    expect(one('cwd: "/Users/milind/dev/app"')).toEqual(["docs/setup.md:1: home folder path (macOS)"]);
    expect(one("C:\\Users\\dana\\AppData")).toEqual(["docs/setup.md:1: home folder path (Windows)"]);
  });

  it("allows placeholders, container users and web routes", () => {
    for (const text of ["/home/node/app", "/home/you/.config", "/Users/Shared/x", "https://x.com/home/feed/", "GET /users/42/"]) {
      expect(one(text)).toEqual([]);
    }
  });

  it("finds ls -l owner columns, private keys, provider keys and secret assignments", () => {
    expect(one("-rw-rw-r-- 1 alex alex 1198867 Nov 18 10:47 a.png")).toEqual(["docs/setup.md:1: ls -l output with owner names"]);
    expect(one("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["docs/setup.md:1: private key"]);
    expect(one(`token: ghp_${"a".repeat(36)}`)).toEqual(["docs/setup.md:1: provider API key"]);
    expect(one("DEPLOY_TOKEN=4f9c2a7e1b3d5f6a8c9e")).toEqual(["docs/setup.md:1: secret value in an assignment"]);
  });

  it("allows references to a secret", () => {
    for (const text of ["API_KEY=", "TOKEN=${TOKEN}", "API_KEY=<your key>", "SECRET='$SECRET_FROM_VAULT'"]) {
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
