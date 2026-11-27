import { accountLimit, grantScopedApps, type ConnectorScopes } from "../../shared/connector-scopes.ts";
import {
  GITHUB_APP_SLUG,
  GITHUB_APP_TOOL_RULES,
  githubBotBranchPrefix,
  githubLevelAtLeast,
  type GithubBotPolicy,
  type GithubRepoGrant,
} from "../../shared/github-app.ts";
import type { ConnectorToolGrant } from "../../shared/wire.ts";

export interface GithubBotSwitches {
  composio?: boolean;
  connectorTools?: Record<string, ConnectorToolGrant>;
  connectorScopes?: ConnectorScopes;
}

export function githubAllowedFor(bot: GithubBotSwitches): boolean {
  if (bot.composio === false) return false;
  if (bot.connectorScopes && !Object.hasOwn(bot.connectorScopes.apps, GITHUB_APP_SLUG)) return false;
  if (bot.connectorTools !== undefined && !Object.hasOwn(bot.connectorTools, GITHUB_APP_SLUG)) return false;
  return true;
}

const SCOPE_RANK = { read: 1, write: 2 } as const;

interface GithubAccess {
  /** 0 = off, 1 = read, 2 = write. */
  level: 0 | 1 | 2;
  tools: "*" | Set<string>;
  /** Connected-account ids the bot may name, or "*" for no account limit. */
  accounts: "*" | Set<string>;
}

/** What a bot may do with GitHub, as the connector relay reads it. A bot that GitHub is switched off for has no access, whatever its lists say. */
function githubAccess(bot: GithubBotSwitches): GithubAccess {
  if (!githubAllowedFor(bot)) return { level: 0, tools: new Set(), accounts: new Set() };
  const scopes = bot.connectorScopes;
  const level = !scopes ? 2 : SCOPE_RANK[scopes.apps[GITHUB_APP_SLUG]!];
  const grant = bot.connectorTools && Object.hasOwn(bot.connectorTools, GITHUB_APP_SLUG) ? bot.connectorTools[GITHUB_APP_SLUG] : undefined;
  const tools = !bot.connectorTools || grant?.tools === "*" ? "*" : new Set(grant?.tools ?? []);
  const accounts = accountLimit(scopes, GITHUB_APP_SLUG);
  return { level, tools, accounts: accounts ? new Set(accounts) : "*" };
}

const widerThan = (was: "*" | Set<string>, now: "*" | Set<string>): boolean =>
  now === "*" ? was !== "*" : was !== "*" && [...now].some((name) => !was.has(name));

/** The switches a bot holds once `patch` is stored: the same steps as the store, so a check sees what the relay will see. */
export function githubSwitchesAfter(before: GithubBotSwitches, patch: GithubBotSwitches): GithubBotSwitches {
  const next = { ...before, ...patch };
  if (patch.connectorScopes !== undefined) grantScopedApps(next);
  return next;
}

/** True when `after` lets the bot do more with GitHub than `before`: a higher level, more tools, more accounts or no account limit, or GitHub switched back on. */
export function githubGrantWidens(before: GithubBotSwitches, after: GithubBotSwitches): boolean {
  const was = githubAccess(before), now = githubAccess(after);
  return now.level > was.level || widerThan(was.tools, now.tools) || widerThan(was.accounts, now.accounts);
}

const grantKey = (grant: Pick<GithubRepoGrant, "installationId" | "repositoryId">) => `${grant.installationId}:${grant.repositoryId}`;

export function githubPolicyWidens(before: GithubBotPolicy | undefined, after: GithubBotPolicy | null): boolean {
  if (after === null) return false;
  if (before === undefined) return true;
  if (before.askBeforeBigChanges && !after.askBeforeBigChanges) return true;
  if (before.ownBranchesOnly && !after.ownBranchesOnly) return true;
  const levels = new Map(before.repos.map((grant) => [grantKey(grant), grant.level]));
  return after.repos.some((grant) => {
    const level = levels.get(grantKey(grant));
    return level === undefined || !githubLevelAtLeast(level, grant.level);
  });
}

export type GithubRepoRef = { installationId: number; repositoryId: number } | { fullName: string };

export interface GithubCallInput {
  policy: GithubBotPolicy | undefined;
  botId: string;
  tool: string;
  repo: GithubRepoRef;
  branch?: string;
  defaultBranch?: string;
  ownerLabel: string;
}

export type GithubDecision =
  | { verdict: "allow"; grant: GithubRepoGrant }
  | { verdict: "ask"; grant: GithubRepoGrant; reason: string }
  | { verdict: "deny"; message: string };

const deny = (message: string): GithubDecision => ({ verdict: "deny", message });

function findGrant(policy: GithubBotPolicy, repo: GithubRepoRef): GithubRepoGrant | undefined {
  if ("fullName" in repo) return policy.repos.find((grant) => grant.fullName.toLowerCase() === repo.fullName.toLowerCase());
  return policy.repos.find((grant) => grant.installationId === repo.installationId && grant.repositoryId === repo.repositoryId);
}

export function decideGithubCall(input: GithubCallInput): GithubDecision {
  const { policy, botId, tool, repo, branch, defaultBranch, ownerLabel } = input;
  const named = "fullName" in repo ? repo.fullName : "that repository";
  const grant = policy ? findGrant(policy, repo) : undefined;
  if (!policy || !grant) return deny(`${ownerLabel} has not given this bot access to ${named}.`);
  const rule = (GITHUB_APP_TOOL_RULES as Record<string, (typeof GITHUB_APP_TOOL_RULES)[keyof typeof GITHUB_APP_TOOL_RULES] | undefined>)[tool];
  if (!rule) return deny("This GitHub action is not available.");
  if (!githubLevelAtLeast(grant.level, rule.level)) {
    return deny(`${ownerLabel} has not allowed this bot to do that in ${grant.fullName}.`);
  }
  if (rule.ownBranch) {
    if (!branch) return deny("Name the branch to change.");
    if (policy.ownBranchesOnly) {
      if (!branch.startsWith(githubBotBranchPrefix(botId))) {
        return deny(`This bot may change only branches that start with ${githubBotBranchPrefix(botId)}.`);
      }
    } else if (grant.level === "pull_requests" && (!defaultBranch || branch === defaultBranch)) {
      return deny(`This bot may not change the main branch of ${grant.fullName}.`);
    }
  }
  if (rule.big && policy.askBeforeBigChanges) {
    return { verdict: "ask", grant, reason: `This is a big change in ${grant.fullName}. It waits for an answer in chat.` };
  }
  return { verdict: "allow", grant };
}
