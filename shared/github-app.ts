// The native GitHub connection: fixed names and the wire types shared by the server and the app.
// Tool names are upper-snake with the GITHUB_APP_ prefix so the connector grant and scope rules apply unchanged.

/** The connector slug in a bot's connectorScopes.apps and connectorTools. "github" is the Composio toolkit. */
export const GITHUB_APP_SLUG = "github_app";
/** The MCP server name bots see (tools arrive as mcp__github_app__GITHUB_APP_<ACTION>). */
export const GITHUB_APP_MCP_SERVER = "github_app";

/** What a bot may do in one repository. Each level includes the one before it. */
export type GithubRepoLevel = "read" | "pull_requests" | "write";
export const GITHUB_REPO_LEVELS: readonly GithubRepoLevel[] = ["read", "pull_requests", "write"];

export function githubLevelAtLeast(level: GithubRepoLevel, needed: GithubRepoLevel): boolean {
  return GITHUB_REPO_LEVELS.indexOf(level) >= GITHUB_REPO_LEVELS.indexOf(needed);
}

/** The GitHub installation-token permissions a level asks the broker for. Never more. */
export type GithubPermissions = Partial<Record<"contents" | "pull_requests" | "issues" | "metadata" | "checks" | "statuses" | "actions", "read" | "write">>;

export function githubLevelPermissions(level: GithubRepoLevel): GithubPermissions {
  const read: GithubPermissions = { metadata: "read", contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read", actions: "read" };
  if (level === "read") return read;
  return { ...read, contents: "write", pull_requests: "write", issues: "write" };
}

export interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/** One GitHub user or organization where the Seira GitHub App is installed and linked to this server. */
export interface GithubAccount {
  installationId: number;
  login: string;
  type: "User" | "Organization";
  avatarUrl?: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
  /** For a person who cannot change the connection: only the repositories that bots they can see use. */
  repositories: GithubRepo[];
  /** Every repository of the account, when `repositories` lists only some. */
  repositoryCount?: number;
}

export interface GithubRepoGrant {
  installationId: number;
  repositoryId: number;
  fullName: string;
  level: GithubRepoLevel;
}

/** One bot's GitHub limits. A bot without a policy cannot use GitHub. */
export interface GithubBotPolicy {
  repos: GithubRepoGrant[];
  /** Merge, close and branch delete wait for the owner's answer in chat. */
  askBeforeBigChanges: boolean;
  /** Pushes go only to branches under githubBotBranchPrefix, at every level. */
  ownBranchesOnly: boolean;
}

export const DEFAULT_GITHUB_BOT_POLICY: GithubBotPolicy = { repos: [], askBeforeBigChanges: true, ownBranchesOnly: true };

export function githubBotBranchPrefix(botId: string): string {
  return `seira/${botId}/`;
}

/** GET /api/github-app and the answer of every change below. */
export interface GithubAppStatus {
  enabled: boolean;
  connected: boolean;
  /** The person asking is the one who connected GitHub, or nobody has connected yet and they may connect. */
  canEdit: boolean;
  ownedByYou: boolean;
  /** Display name of the person who connected GitHub. */
  ownerLabel?: string;
  accounts: GithubAccount[];
  /** Install requests that wait for an organization owner on GitHub. */
  pending: { login: string | null }[];
  bots: Record<string, GithubBotPolicy>;
}

/**
 * Routes (every change answers 403 unless the person asking owns the connection; every status lists only the bots
 * the person asking can see, and pending installs and all repositories only to a person who can change it):
 * - GET    /api/github-app                          -> GithubAppStatus
 * - POST   /api/github-app/connect                  -> GithubConnectStart (the browser opens url)
 * - POST   /api/github-app/complete  { code }       -> GithubAppStatus (the code GitHub's last page shows)
 * - POST   /api/github-app/refresh                  -> GithubAppStatus (reads the accounts again)
 * - PUT    /api/github-app/bots/:botId  GithubBotPolicy | null  -> GithubAppStatus (null removes the bot)
 * - DELETE /api/github-app/accounts/:installationId -> { manageUrl, status: GithubAppStatus }
 * - DELETE /api/github-app                          -> GithubAppStatus (disconnects every account)
 */
export const GITHUB_APP_API = "/api/github-app";

/** codeEntry: the browser cannot come back to this server by itself, so the person types the code GitHub's last page
 * shows. Otherwise the server finishes on its own and the app reads the status again. */
export interface GithubConnectStart {
  url: string;
  codeEntry: boolean;
}

/** A code from the broker's last page: 10 Crockford base32 characters, shown as XXXXX-XXXXX. */
export function normalizeGithubCompletionCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(code) ? code : null;
}

export const GITHUB_APP_READ_TOOL_NAMES = [
  "GITHUB_APP_LIST_REPOS",
  "GITHUB_APP_GET_FILE",
  "GITHUB_APP_SEARCH_CODE",
  "GITHUB_APP_LIST_ISSUES",
  "GITHUB_APP_GET_ISSUE",
  "GITHUB_APP_LIST_PULLS",
  "GITHUB_APP_GET_PULL",
] as const;

export const GITHUB_APP_WRITE_TOOL_NAMES = [
  "GITHUB_APP_CREATE_COMMENT",
  "GITHUB_APP_CREATE_ISSUE",
  "GITHUB_APP_CREATE_BRANCH",
  "GITHUB_APP_COMMIT_FILES",
  "GITHUB_APP_CREATE_PULL",
  "GITHUB_APP_MERGE_PULL",
  "GITHUB_APP_CLOSE_ISSUE_OR_PULL",
  "GITHUB_APP_DELETE_BRANCH",
] as const;

export const GITHUB_APP_TOOL_NAMES = [...GITHUB_APP_READ_TOOL_NAMES, ...GITHUB_APP_WRITE_TOOL_NAMES] as const;
export type GithubAppToolName = (typeof GITHUB_APP_TOOL_NAMES)[number];

/** The level each tool needs, and whether it waits for an answer while askBeforeBigChanges is on. */
export const GITHUB_APP_TOOL_RULES: Record<GithubAppToolName, { level: GithubRepoLevel; big?: true; ownBranch?: true }> = {
  GITHUB_APP_LIST_REPOS: { level: "read" },
  GITHUB_APP_GET_FILE: { level: "read" },
  GITHUB_APP_SEARCH_CODE: { level: "read" },
  GITHUB_APP_LIST_ISSUES: { level: "read" },
  GITHUB_APP_GET_ISSUE: { level: "read" },
  GITHUB_APP_LIST_PULLS: { level: "read" },
  GITHUB_APP_GET_PULL: { level: "read" },
  GITHUB_APP_CREATE_COMMENT: { level: "pull_requests" },
  GITHUB_APP_CREATE_ISSUE: { level: "pull_requests" },
  GITHUB_APP_CREATE_BRANCH: { level: "pull_requests", ownBranch: true },
  GITHUB_APP_COMMIT_FILES: { level: "pull_requests", ownBranch: true },
  GITHUB_APP_CREATE_PULL: { level: "pull_requests" },
  GITHUB_APP_MERGE_PULL: { level: "write", big: true },
  GITHUB_APP_CLOSE_ISSUE_OR_PULL: { level: "write", big: true },
  GITHUB_APP_DELETE_BRANCH: { level: "write", big: true, ownBranch: true },
};
