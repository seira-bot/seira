import type { AppEnv } from "./env";

/** Issue numbers that a dry run hands out start here, so none of them is the number of a real issue. */
export const DRY_RUN_ISSUE_BASE = 9_000_000;

/** Dry-run mode needs the exact value "true". Any other value, or none, files real issues. */
export const isDryRun = (env: AppEnv) => env.DRY_RUN === "true";

/** A stable fake issue number for one fingerprint. */
export function dryRunIssueNumber(fingerprint: string) {
  return DRY_RUN_ISSUE_BASE + (Number.parseInt(fingerprint.slice(0, 5), 16) % 1_000_000);
}
