import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadKeys, wipeKeys, type CommandRunner } from "./keys.ts";

const key = (password: string, iterations = 1) => pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");

function runner(answers: Record<string, string | Error>) {
  const calls: Array<{ file: string; args: string[]; env: Record<string, string | undefined>; timeoutMs: number }> = [];
  const run: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env, timeoutMs: options.timeoutMs });
    const answer = answers[file];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("missing");
    return answer;
  };
  return { run, calls };
}

describe("cookie keys", () => {
  it("reads every secret the Secret Service holds, and derives v10 and v11 keys on Linux", async () => {
    const { run, calls } = runner({ "/usr/bin/secret-tool": "[/a/1]\nlabel = Chrome Safe Storage\nsecret = pw-one\ncreated = x\n\n[/a/2]\nsecret = pw two\n" });
    const keys = await loadKeys("edge", { runCommand: run, env: { XDG_CURRENT_DESKTOP: "GNOME" }, platform: "linux" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ file: "/usr/bin/secret-tool", args: ["search", "--all", "--unlock", "application", "chromium"], timeoutMs: 60_000 });
    expect(calls[0]!.env.LC_ALL).toBe("C");
    expect(keys.fromKeyring).toBe(2);
    expect(keys.v10).toEqual([key("peanuts"), key("")]);
    expect(keys.v11).toEqual([key("pw-one"), key("pw two"), key("")]);
  });

  it("maps each browser to its keyring application", async () => {
    for (const [browser, application] of [["chrome", "chrome"], ["chromium", "chromium"], ["brave", "brave"]] as const) {
      const { run, calls } = runner({});
      await loadKeys(browser, { runCommand: run, env: {}, platform: "linux" });
      expect(calls[0]!.args.at(-1)).toBe(application);
    }
  });

  it("asks KWallet on KDE", async () => {
    const { run, calls } = runner({ "/usr/bin/kwallet-query": "kde-secret\n" });
    for (const env of [{ XDG_CURRENT_DESKTOP: "KDE" }, { KDE_SESSION_VERSION: "6" }]) {
      const keys = await loadKeys("brave", { runCommand: run, env, platform: "linux" });
      expect(keys.v11[0]).toEqual(key("kde-secret"));
    }
    expect(calls[0]).toMatchObject({ file: "/usr/bin/kwallet-query", args: ["--read-password", "Brave Safe Storage", "--folder", "Brave Keys", "--", "kdewallet"] });
  });

  it("uses 1003 iterations and the Keychain on macOS", async () => {
    const { run, calls } = runner({ "/usr/bin/security": "mac-secret\n" });
    const keys = await loadKeys("edge", { runCommand: run, env: {}, platform: "darwin" });
    expect(calls[0]!.args).toEqual(["find-generic-password", "-w", "-s", "Microsoft Edge Safe Storage"]);
    expect(keys).toMatchObject({ fromKeyring: 1, v11: [] });
    expect(keys.v10).toEqual([key("mac-secret", 1003)]);
  });

  it("still offers the fixed-password keys when the password store fails", async () => {
    const { run } = runner({ "/usr/bin/secret-tool": new Error("locked") });
    const keys = await loadKeys("chrome", { runCommand: run, env: {}, platform: "linux" });
    expect(keys.fromKeyring).toBe(0);
    expect(keys.v11).toEqual([key("")]);
  });

  it("overwrites every key buffer with zeros", async () => {
    const { run } = runner({ "/usr/bin/secret-tool": "secret = pw\n" });
    const keys = await loadKeys("chrome", { runCommand: run, env: {}, platform: "linux" });
    const all = [...keys.v10, ...keys.v11];
    expect(all.some((buffer) => buffer.some((byte) => byte !== 0))).toBe(true);
    wipeKeys(keys);
    expect(all.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });
});
