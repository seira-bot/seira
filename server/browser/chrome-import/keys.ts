import { execFile } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";

import type { ChromeBrowser } from "./profiles.ts";

/** Runs a program with no shell and resolves with its standard output; rejects when it fails or times out. */
export type CommandRunner = (file: string, args: string[], options: { timeoutMs: number; env: Record<string, string | undefined> }) => Promise<string>;

export interface KeyDeps {
  runCommand?: CommandRunner;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** Derived AES-128 keys, tried in order for each cookie prefix. */
export interface DerivedKeys {
  v10: Buffer[];
  v11: Buffer[];
  /** How many passwords the computer's password store gave. */
  fromKeyring: number;
}

const COMMAND_TIMEOUT_MS = 60_000;
const SALT = "saltysalt";

const defaultRunner: CommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: options.timeoutMs, env: options.env, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

const LINUX_APPLICATION: Record<ChromeBrowser, string> = { chrome: "chrome", chromium: "chromium", edge: "chromium", brave: "brave" };
const KDE_NAME: Record<ChromeBrowser, string> = { chrome: "Chrome", chromium: "Chromium", edge: "Chromium", brave: "Brave" };
const MAC_SERVICE: Record<ChromeBrowser, string> = { chrome: "Chrome", edge: "Microsoft Edge", brave: "Brave", chromium: "Chromium" };

const derive = (password: string, iterations: number) => pbkdf2Sync(password, SALT, iterations, 16, "sha1");
const trimNewline = (text: string) => text.replace(/\r?\n$/u, "");

function isKde(env: Record<string, string | undefined>): boolean {
  return /kde/iu.test(env.XDG_CURRENT_DESKTOP ?? "") || !!env.KDE_SESSION_VERSION;
}

async function linuxSecrets(browser: ChromeBrowser, run: CommandRunner, env: Record<string, string | undefined>): Promise<string[]> {
  const options = { timeoutMs: COMMAND_TIMEOUT_MS, env: { ...env, LC_ALL: "C" } };
  try {
    if (isKde(env)) {
      const name = KDE_NAME[browser];
      const output = await run("/usr/bin/kwallet-query", ["--read-password", `${name} Safe Storage`, "--folder", `${name} Keys`, "--", "kdewallet"], options);
      const secret = trimNewline(output);
      return secret ? [secret] : [];
    }
    const output = await run("/usr/bin/secret-tool", ["search", "--all", "--unlock", "application", LINUX_APPLICATION[browser]], options);
    return output.split(/\r?\n/u).flatMap((line) => {
      const match = /^secret = (.+)$/u.exec(line);
      return match ? [match[1]!] : [];
    });
  } catch { return []; }
}

async function macSecrets(browser: ChromeBrowser, run: CommandRunner, env: Record<string, string | undefined>): Promise<string[]> {
  try {
    const output = await run("/usr/bin/security", ["find-generic-password", "-w", "-s", `${MAC_SERVICE[browser]} Safe Storage`], { timeoutMs: COMMAND_TIMEOUT_MS, env: { ...env, LC_ALL: "C" } });
    const secret = trimNewline(output);
    return secret ? [secret] : [];
  } catch { return []; }
}

export async function loadKeys(browser: ChromeBrowser, deps: KeyDeps = {}): Promise<DerivedKeys> {
  const platform = deps.platform ?? process.platform;
  const run = deps.runCommand ?? defaultRunner;
  const env = deps.env ?? process.env;
  if (platform === "darwin") {
    const secrets = await macSecrets(browser, run, env);
    return { v10: secrets.map((secret) => derive(secret, 1003)), v11: [], fromKeyring: secrets.length };
  }
  const secrets = platform === "linux" ? await linuxSecrets(browser, run, env) : [];
  return {
    v10: ["peanuts", ""].map((password) => derive(password, 1)),
    v11: [...secrets, ""].map((password) => derive(password, 1)),
    fromKeyring: secrets.length,
  };
}

export function wipeKeys(keys: DerivedKeys): void {
  for (const key of [...keys.v10, ...keys.v11]) key.fill(0);
}
