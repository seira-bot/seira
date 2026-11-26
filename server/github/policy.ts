import {
  GITHUB_APP_TOOL_RULES,
  githubBotBranchPrefix,
  githubLevelAtLeast,
  type GithubBotPolicy,
  type GithubRepoGrant,
} from "../../shared/github-app.ts";

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
