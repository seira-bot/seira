// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "seira-drafts",
  "seira-draft-attachments",
  "seira-draft-send-ids",
  "seira-draft-channel-modes",
  "seira-skin",
  "seira-show-threads",
  "seira-show-run-card",
  "seira-send-key",
  "seira-color-user-bubbles",
  "seira-chat-width",
  "seira.sidebarDensity",
  "seira.sidebarToolsLayout",
  "seira.sidebarCollapsedSections.v1",
  "seira.sidebarSectionOrder.v1",
  "seira-analytics-opt-out",
  "seira.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
