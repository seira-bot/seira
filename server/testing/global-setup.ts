// Runs once per vitest run, before any test file.
import { sweepStaleTestDirs } from "./stale-test-dirs.ts";

export default function sweepOldTestFolders(): void {
  for (const { path, reason } of sweepStaleTestDirs().failed) {
    console.warn(`test cleanup could not remove ${path}: ${reason}`);
  }
}
