import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

let home: string | undefined;

/** The home the data folder lives under. Under vitest, with HOME still the real one, a temp folder instead, so a test
 * never reads, migrates or deletes the person's own data. */
export function dataHome(): string {
  if (home !== undefined) return home;
  const real = homedir();
  home = process.env.VITEST !== undefined && real === userInfo().homedir ? mkdtempSync(join(tmpdir(), "omb-test-home-")) : real;
  return home;
}

/** What a plain mkdir gives under umask 022 and 002. Any other mode on a folder that already exists is its owner's
 * choice and stays. */
const PLAIN_MKDIR_MODES = new Set([0o755, 0o775]);

/** The data folder holds credentials and conversations, so no other local user may list or enter it: a missing folder
 * (and each missing parent) is made 0700, and one of ours left at a plain mkdir mode is tightened to 0700. */
export function ensurePrivateDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined || process.platform === "win32") return;
  const { mode, uid } = statSync(dir);
  if (uid !== process.getuid?.() || !PLAIN_MKDIR_MODES.has(mode & 0o7777)) return;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A read-only mount keeps its mode; the server still starts.
  }
}
