// The sign-in lists in config.json, as `seira access` reads and writes them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAllowList, type SignInAllowList } from "./account-signin.ts";
import { writeFileAtomic } from "./atomic.ts";
import { ensurePrivateDir } from "./data-dir.ts";

type Config = Record<string, unknown>;

const configFile = (dataDir: string) => join(dataDir, "config.json");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const unreadableAccessConfig = (dataDir: string, error: unknown) => `${configFile(dataDir)} could not be read (${message(error)}); fix it before changing who can sign in`;

/** Throws when config.json exists but is not a JSON object. */
export function readAccessConfig(dataDir: string): Config {
  const file = configFile(dataDir);
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(parsed));
}

export function accessListsOf(config: Config): SignInAllowList {
  const current = typeof config.signIn === "object" && config.signIn !== null ? Object(config.signIn) : {};
  const list = (value: unknown) => parseAllowList(Array.isArray(value) ? value.map(String).join(",") : "");
  return { admins: list(Reflect.get(current, "admins")), members: list(Reflect.get(current, "members")) };
}

export function writeAccessConfig(dataDir: string, config: Config, lists: SignInAllowList): void {
  ensurePrivateDir(dataDir);
  writeFileAtomic(configFile(dataDir), `${JSON.stringify({ ...config, signIn: lists }, null, 2)}\n`, { mode: 0o600 });
}

/** Saves `after` only when config.json still holds `before`. Returns the config that it read, or why it saved nothing. Run it under the lock of `accessChange`. */
export function saveAccessLists(dataDir: string, before: SignInAllowList, after: SignInAllowList, rerun: string): { config: Config } | string {
  let config: Config;
  try {
    config = readAccessConfig(dataDir);
  } catch (error) {
    return unreadableAccessConfig(dataDir, error);
  }
  const now = accessListsOf(config);
  if (now.admins.join(",") !== before.admins.join(",") || now.members.join(",") !== before.members.join(",")) return `the sign-in list changed while this command ran; run ${rerun} again`;
  writeAccessConfig(dataDir, config, after);
  return { config };
}
