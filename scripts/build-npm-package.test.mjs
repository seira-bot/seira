import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "build-npm-package.mjs");
let root;
let pkg;
let readme;
let run;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "npm-package-"));
  mkdirSync(join(root, "scripts"));
  cpSync(script, join(root, "scripts", "build-npm-package.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3", dependencies: { "@1password/sdk": "^1", "@duckdb/node-api": "^1", "@resvg/resvg-js": "^2" } }));
  writeFileSync(join(root, "LICENSE"), "license");
  mkdirSync(join(root, "dist-server"));
  writeFileSync(join(root, "dist-server", "index.js"), "");
  writeFileSync(join(root, "dist-server", "seira.js"), "");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.html"), "");
  run = spawnSync(process.execPath, [join(root, "scripts", "build-npm-package.mjs")], { encoding: "utf8" });
  pkg = JSON.parse(readFileSync(join(root, "release", "npm", "package.json"), "utf8"));
  readme = readFileSync(join(root, "release", "npm", "README.md"), "utf8");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the npm package", () => {
  it("is @seira-bot/seira, public, with the seira command", () => {
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("@seira-bot/seira@1.2.3");
    expect(pkg.name).toBe("@seira-bot/seira");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.bin).toEqual({ seira: "cli.js" });
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });

  it("points at the Seira repository", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "https://github.com/seira-bot/seira.git" });
    expect(pkg.homepage).toBe("https://github.com/seira-bot/seira#readme");
    expect(pkg.keywords).toContain("seira");
  });

  it("tells people to install and run the new package", () => {
    expect(readme).toContain("# @seira-bot/seira");
    expect(readme).toContain("npm install -g @seira-bot/seira");
    expect(readme).toContain("npx @seira-bot/seira");
    expect(readme).not.toContain("npm uninstall -g seira");
    expect(readme).not.toMatch(/npx seira|(?<!un)install -g seira|milind-soni/);
  });
});
