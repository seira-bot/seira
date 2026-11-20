import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

let home: string | undefined;

/** The start of the name of every throwaway home the test suite makes. */
export const TEST_HOME_PREFIX = "seira-test-home-";

/**
 * A test runner other than vitest: bun test, jest or node --test. These skip server/testing/setup.ts, which gives each
 * test file a throwaway home, so a server test under them would read and delete the person's own data.
 */
export function otherTestRunner(env: NodeJS.ProcessEnv = process.env, versions: NodeJS.ProcessVersions = process.versions, argv: string[] = process.argv): boolean {
  if (env.VITEST !== undefined) return false;
  if (env.JEST_WORKER_ID !== undefined || env.NODE_TEST_CONTEXT !== undefined) return true;
  return versions.bun !== undefined && (env.NODE_ENV === "test" || /\.(test|spec)\.[cm]?[jt]sx?$/.test(argv[1] ?? ""));
}

/** The home the data folder lives under. Under vitest, with HOME still the real one, a temp folder instead, so a test
 * never reads, migrates or deletes the person's own data. Under another test runner, a home the suite did not make stops
 * the test before it touches any data. */
export function dataHome(): string {
  if (home !== undefined) return home;
  const real = homedir();
  if (otherTestRunner() && !basename(real).startsWith(TEST_HOME_PREFIX)) {
    throw new Error(`Run the server tests with vitest (pnpm test). This test runner keeps HOME at ${real}, and the tests would change the data folder there.`);
  }
  home = process.env.VITEST !== undefined && real === userInfo().homedir ? mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX)) : real;
  return home;
}

const PRIVATE_BITS = 0o700;
const GROUP_SHARED_BITS = 0o2770;

export interface PrivateDirOptions {
  /** Let the owner's group read, write and enter, and let new files inherit the group (setgid). Other users stay out. */
  groupAccess?: boolean;
  chmod?: (path: string, mode: number) => void;
}

const groupAccessFromEnv = () => /^(?:1|true)$/iu.test(process.env.SEIRA_DATA_DIR_GROUP_ACCESS ?? "");

const openBits = (path: string, allowed: number) => statSync(path).mode & 0o7777 & ~allowed;

function secure(path: string, allowed: number, chmod: (path: string, mode: number) => void): void {
  if (openBits(path, allowed) === 0) return;
  const { mode, uid } = statSync(path);
  if (uid === process.getuid?.()) {
    try {
      chmod(path, mode & 0o7777 & allowed);
    } catch {
      // The check below reports a folder that stays open.
    }
  }
  if (openBits(path, allowed) === 0) return;
  throw new Error(
    `The data folder ${path} is open to other accounts (mode ${(statSync(path).mode & 0o7777).toString(8)}) and could not be made private. ` +
      `Run "chmod ${allowed === PRIVATE_BITS ? "700" : "2770"} ${path}" as its owner, or move the data folder.`,
  );
}

/** The data folder holds credentials and conversations, so no other local account may list, enter or change it: a
 * missing folder (and each missing parent) is made 0700, and an existing one has every group and other bit, and
 * setuid, setgid and sticky, removed. A folder that stays open (not ours, or chmod refused) stops the server. */
export function ensurePrivateDir(dir: string, options: PrivateDirOptions = {}): void {
  const created = mkdirSync(dir, { recursive: true, mode: PRIVATE_BITS });
  if (process.platform === "win32") return;
  const allowed = (options.groupAccess ?? groupAccessFromEnv()) ? GROUP_SHARED_BITS : PRIVATE_BITS;
  const chmod = options.chmod ?? chmodSync;
  const chain: string[] = [];
  for (let path = resolve(dir); ; path = dirname(path)) {
    chain.unshift(path);
    if (created === undefined || path === resolve(created) || path === dirname(path)) break;
  }
  for (const path of chain) secure(path, allowed, chmod);
}
