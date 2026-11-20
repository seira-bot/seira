// Security: the private folder, inside a bot's own workspace or Local VM workspace, where a secret the person gave for the
// bot's commands lives for a day. Nothing that syncs, backs up, moves, links, attaches, publishes, uploads or snapshots
// workspace files may carry anything under it.
import { lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_VAULT_FOLDER } from "../electron/legacy-names.mjs";

export const SECRET_FOLDER = ".seira-secrets";

export const SECRET_FILE_REFUSAL =
  "That file holds a secret the person gave for your own commands only: it cannot be opened from chat, attached, published, uploaded or read by a helper.";

export function inSecretFolder(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.includes(SECRET_FOLDER) || parts.includes(LEGACY_VAULT_FOLDER);
}

/** Renames an earlier version's secret folder in `base` to the current name when the current one is absent, in one rename. */
export function adoptLegacySecretFolder(base: string): void {
  const old = join(base, LEGACY_VAULT_FOLDER);
  const current = join(base, SECRET_FOLDER);
  try {
    if (!lstatSync(old).isDirectory()) return;
  } catch { return; }
  try {
    lstatSync(current);
    console.warn(`[secrets] ${LEGACY_VAULT_FOLDER} and ${SECRET_FOLDER} both exist; both left as they are`);
    return;
  } catch { /* the current folder is absent */ }
  try { renameSync(old, current); } catch (error) {
    console.warn(`[secrets] could not rename ${LEGACY_VAULT_FOLDER}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
