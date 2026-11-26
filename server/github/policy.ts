import type { ConnectorScopes } from "../../shared/connector-scopes.ts";
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
