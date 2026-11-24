/** Full, encrypted workspace snapshots are distinct from additive team copies. */
export interface WorkspaceBackupSummary {
  format: "seira.workspace-backup";
  version: 1;
  id: string;
  createdAt: string;
  appVersion: string;
  files: number;
  directories: number;
  bytes: number;
  bots: number;
  groups: number;
  threads: number;
  messages: number;
  exclusions: string[];
  warnings: string[];
  /** Parts the person chose to leave out of this export (for example "work-folders"). Absent when nothing was left out. */
  leftOut?: string[];
}

/** What a restore from another kind of computer (Windows to Linux, say) could not bring: folders and files outside
 * that computer's data folder. */
export interface WorkspaceLeftBehind {
  /** Bots whose working folder stayed there; they now start in their own folder. */
  bots: number;
  /** Up to 20 of those folders and of the files their instructions name, as written there. */
  paths: string[];
}

/** What a restore leaves to do by hand. Fixed kinds and counts only; never a name, address or secret. */
export const NEEDS_ACTION_KINDS = ["routines-on", "webhooks-on", "app-automations-on"] as const;
export type WorkspaceNeedsActionKind = typeof NEEDS_ACTION_KINDS[number];
export interface WorkspaceNeedsAction {
  kind: WorkspaceNeedsActionKind;
  /** How many of that kind were on in the backup. At least 1: a kind with none is not listed. */
  count: number;
}

export type WorkspaceBackupClientState = Record<string, string>;

export interface WorkspaceBackupPrivateMetadata {
  summary: WorkspaceBackupSummary;
  clientState: WorkspaceBackupClientState;
}
