import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubStore, GITHUB_STORE_FILE } from "./store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "seira-gh-store-")); dirs.push(dir); return join(dir, "data"); };

describe("github store", () => {
  it("reads an empty store when there is no file", () => {
    expect(createGithubStore(folder()).read()).toEqual({ version: 1, accounts: [], pending: [], bots: {} });
  });

  it("writes the file with mode 0600 in a 0700 folder and reads it back", () => {
    const dir = folder();
    const store = createGithubStore(dir);
    store.update((data) => { data.ownerKey = "local"; data.pending.push({ login: null }); });
    expect(statSync(join(dir, GITHUB_STORE_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(store.read().ownerKey).toBe("local");
  });

  it("reads a bad file as empty and logs one line without its content", () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, GITHUB_STORE_FILE), '{"version":1,"ownerKey":"secret-owner","accounts":"nope"}');
    const lines: string[] = [];
    const store = createGithubStore(dir, (line) => lines.push(line));
    expect(store.read()).toEqual({ version: 1, accounts: [], pending: [], bots: {} });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret-owner");
  });
});
