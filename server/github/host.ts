// What server/index.ts needs from the native GitHub connection, in one object: the per-turn mount, the prompt line and the
// internal MCP handler. The tools run here, in the server: the box gets a turn's capability, never a GitHub token.
import { GITHUB_APP_MCP_SERVER, GITHUB_APP_SLUG, GITHUB_APP_TOOL_RULES, githubBotBranchPrefix, githubLevelAtLeast, type GithubAppToolName, type GithubBotPolicy, type GithubRepoGrant } from "../../shared/github-app.ts";
import { connectorAccessDecision } from "../../shared/connector-scopes.ts";
import type { AppConfig } from "../config.ts";
import { connectorRefusalText, connectorScopeRefusalText, evaluateConnectorTools } from "../connector-verdict.ts";
import { appendDecision } from "../decision-log.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, ownNode, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { OutboundHoldAnswer } from "../outbound-hold.ts";
import { GITHUB_RECONNECT_MESSAGE, GITHUB_UNREACHABLE_MESSAGE, GithubBrokerError, type GithubBrokerClient } from "./broker-client.ts";
import { githubAppEnabled } from "./flag.ts";
import { decideGithubCall, githubAllowedFor, type GithubBotSwitches } from "./policy.ts";
import type { GithubStore, GithubStoreData } from "./store.ts";
import { GITHUB_INSTRUCTIONS, GITHUB_NOT_FOUND_MESSAGE, GITHUB_TOOLS, githubError, githubText, githubToolCallProblem, isGithubToolName, runGithubTool, type GithubTool, type GithubToolResult } from "./tools.ts";
import { PublicError } from "../public-error.ts";

export const GITHUB_INTERNAL_MCP_PATH = "/api/internal/github/mcp";

export interface GithubBot extends GithubBotSwitches {
  id: string;
  name: string;
}

export interface GithubHostDeps {
  store: Pick<GithubStore, "read">;
  broker: Pick<GithubBrokerClient, "mintToken">;
  dataDir: string;
  cfg(): Pick<AppConfig, "features">;
  bot(id: string): GithubBot | undefined | null;
  /** Opens the "Send on your behalf?" card, which asks at every access level. */
  ask(input: { botId: string; threadId: string; tool: string; arguments: Record<string, unknown>; active: () => boolean }): Promise<OutboundHoldAnswer>;
  /** Text on GitHub is written by others: the conversation that read some is outside work from then on (server/host/outside-lineage.ts). */
  markOutside(threadId: string): void;
  /** An organisation's policy can keep this app off. */
  appAllowed?(): boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

const action = (name: string) => { const words = name.replace(/^GITHUB_APP_/u, "").replace(/_+/gu, " ").toLowerCase(); return words ? words[0]!.toUpperCase() + words.slice(1) : name; };

type Verdict = { ok: true; rule: string } | { ok: false; text: string; rule: string };

export function githubAccess(bot: GithubBot, name: string): Verdict {
  if (!githubAllowedFor(bot)) return { ok: false, rule: `scope:${GITHUB_APP_SLUG}:app`, text: connectorScopeRefusalText({ kind: "tools", invoked: name, names: [name] }, "app", bot.name, "GitHub", action(name)) };
  const verdict = evaluateConnectorTools([name], bot.connectorTools, [GITHUB_APP_SLUG]);
  if (!verdict.allowed) return { ok: false, rule: `connectorTools.${GITHUB_APP_SLUG}`, text: connectorRefusalText(verdict.denials) };
  const access = connectorAccessDecision(bot.connectorScopes, [{ slug: name }], [GITHUB_APP_SLUG]);
  if (!access.ok) return { ok: false, rule: `scope:${GITHUB_APP_SLUG}:${access.reason}`, text: connectorScopeRefusalText({ kind: "tools", invoked: name, names: [name] }, access.reason, bot.name, "GitHub", action(name)) };
  return { ok: true, rule: verdict.legacy ? `scope:${GITHUB_APP_SLUG}` : verdict.rule };
}

export const GITHUB_ACCESS_CHANGED_MESSAGE = "This bot's GitHub access changed. Try again.";
const GITHUB_STOPPED_MESSAGE = "This conversation stopped before GitHub was changed.";

const defaultBranchOf = (data: GithubStoreData, grant: Pick<GithubRepoGrant, "installationId" | "repositoryId">) =>
  data.accounts.find((one) => one.installationId === grant.installationId)?.repositories.find((repo) => repo.id === grant.repositoryId)?.defaultBranch;

const sameGrant = (a: GithubRepoGrant, b: GithubRepoGrant) => a.installationId === b.installationId && a.repositoryId === b.repositoryId && a.fullName === b.fullName && a.level === b.level;

const READS_OUTSIDE_TEXT: ReadonlySet<GithubAppToolName> = new Set(["GITHUB_APP_GET_FILE", "GITHUB_APP_SEARCH_CODE", "GITHUB_APP_LIST_ISSUES", "GITHUB_APP_GET_ISSUE", "GITHUB_APP_LIST_PULLS", "GITHUB_APP_GET_PULL"]);

const LEVEL_WORDS: Record<GithubRepoGrant["level"], string> = { read: "read only", pull_requests: "pull requests", write: "read and write" };

export function githubPrompt(policy: GithubBotPolicy, botId: string): string {
  const own = policy.ownBranchesOnly ? ` Push only to branches that start with ${githubBotBranchPrefix(botId)}.` : "";
  const repos = policy.repos.length ? policy.repos.map((grant) => `${grant.fullName} (${LEVEL_WORDS[grant.level]})`).join(", ") : "none yet";
  return ` For GitHub, use the ${GITHUB_APP_MCP_SERVER} tools (GITHUB_APP_*), for example GITHUB_APP_LIST_REPOS. They work now, in your granted repositories: ${repos}.${own}`
    + " Do not use Composio for GitHub, do not search for another GitHub tool, and never ask the person for a token or a sign-in for GitHub.";
}

export function createGithubHost(deps: GithubHostDeps) {
  const env = deps.env ?? process.env;
  const enabled = () => githubAppEnabled(deps.cfg(), env);
  const policyOf = (botId: string) => deps.store.read().bots[botId];
  const allowedHere = () => deps.appAllowed?.() ?? true;
  const mounts = (bot: GithubBot) => allowedHere() && enabled() && policyOf(bot.id) !== undefined && githubAllowedFor(bot);
  const scrub = (text: string, token: string) => (token ? text.split(token).join("[removed]") : text);

  function listed(bot: GithubBot): GithubTool[] {
    const policy = policyOf(bot.id);
    if (!policy) return [];
    return GITHUB_TOOLS.filter((tool) => githubAccess(bot, tool.name).ok && policy.repos.some((grant) => githubLevelAtLeast(grant.level, GITHUB_APP_TOOL_RULES[tool.name].level)));
  }

  type Authorized = { ok: true; grant: GithubRepoGrant; defaultBranch: string; verdict: "allow" | "ask" } | { ok: false; text: string; rule: string };

  function authorize(name: GithubAppToolName, args: Record<string, unknown>, botId: string): Authorized {
    if (!allowedHere() || !enabled()) return { ok: false, text: "GitHub is not available.", rule: "github:off" };
    const bot = deps.bot(botId);
    if (!bot) return { ok: false, text: "This bot no longer exists.", rule: "github:bot" };
    const access = githubAccess(bot, name);
    if (!access.ok) return { ok: false, text: access.text, rule: access.rule };
    const data = deps.store.read();
    const policy = data.bots[botId];
    const named = String(args.repo);
    const grant = policy?.repos.find((one) => one.fullName.toLowerCase() === named.toLowerCase());
    const defaultBranch = grant && defaultBranchOf(data, grant);
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const decision = decideGithubCall({ policy, botId, tool: name, repo: { fullName: named }, ...(branch ? { branch } : {}), ...(defaultBranch ? { defaultBranch } : {}), ownerLabel: data.ownerLabel ?? "The owner of this connection" });
    if (decision.verdict === "deny") return { ok: false, text: decision.message, rule: "github:policy" };
    if (!defaultBranch) return { ok: false, text: GITHUB_NOT_FOUND_MESSAGE, rule: "github:repo" };
    if (name === "GITHUB_APP_DELETE_BRANCH" && branch === defaultBranch) return { ok: false, text: `This bot may not delete the main branch of ${decision.grant.fullName}.`, rule: "github:main-branch" };
    return { ok: true, grant: decision.grant, defaultBranch, verdict: decision.verdict };
  }

  async function call(name: GithubAppToolName, args: Record<string, unknown>, bot: GithubBot, capability: { botId: string; threadId: string }, assertActive: () => void): Promise<GithubToolResult> {
    const log = (decision: "auto-approved" | "auto-denied", rule: string) => appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: name, decision, source: "connector-scope", rule });
    if (name === "GITHUB_APP_LIST_REPOS") {
      const data = deps.store.read();
      log("auto-approved", "github:list");
      return githubText({ repos: (data.bots[bot.id]?.repos ?? []).map((grant) => ({ repo: grant.fullName, level: grant.level, defaultBranch: defaultBranchOf(data, grant) ?? null })) });
    }
    const first = authorize(name, args, capability.botId);
    if (!first.ok) { log("auto-denied", first.rule); return githubError(first.text); }
    const active = () => { try { assertActive(); return true; } catch { return false; } };
    if (first.verdict === "ask") {
      const answer = await deps.ask({ botId: bot.id, threadId: capability.threadId, tool: name, arguments: args, active });
      if (!answer.ok) return githubError(answer.text);
      assertActive();
    }
    const refusal = (): string | null => {
      if (!active()) return GITHUB_STOPPED_MESSAGE;
      const now = authorize(name, args, capability.botId);
      if (!now.ok) return now.text;
      if (now.verdict === "ask" && first.verdict !== "ask") return GITHUB_ACCESS_CHANGED_MESSAGE;
      return sameGrant(now.grant, first.grant) && now.defaultBranch === first.defaultBranch ? null : GITHUB_ACCESS_CHANGED_MESSAGE;
    };
    const refuse = (text: string) => { log("auto-denied", "github:changed"); return githubError(text); };
    const before = refusal();
    if (before) return refuse(before);
    if (READS_OUTSIDE_TEXT.has(name)) deps.markOutside(capability.threadId);
    let token = "";
    try {
      const minted = await deps.broker.mintToken(first.grant.installationId, first.grant.repositoryId, first.grant.level);
      token = minted.token;
      const afterMint = refusal();
      if (afterMint) return refuse(afterMint);
      log("auto-approved", first.verdict === "ask" ? "github:asked" : `github:${first.grant.level}`);
      const result = await runGithubTool(name, args, { token, repo: { fullName: first.grant.fullName, defaultBranch: first.defaultBranch }, writeRefusal: () => { const text = refusal(); if (text) log("auto-denied", "github:changed"); return text; }, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      return { ...result, content: result.content.map((part) => ({ ...part, text: scrub(part.text, token) })) };
    } catch (error) {
      return githubError(error instanceof GithubBrokerError && (error.kind === "reconnect" || error.kind === "gone") ? GITHUB_RECONNECT_MESSAGE : GITHUB_UNREACHABLE_MESSAGE);
    }
  }

  return {
    mounts,
    available: () => allowedHere() && enabled(),
    integration(bot: GithubBot, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null {
      if (!mounts(bot)) return null;
      return { command: ownNode(), args: [SPAWNED_PROXIES.harnessMcp, "github"], env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("github")]: mint(), SEIRA_HARNESS_URL: harnessUrl } };
    },
    prompt(bot: GithubBot): string {
      const policy = policyOf(bot.id);
      return policy && mounts(bot) ? githubPrompt(policy, bot.id) : "";
    },
    toolListing: () => (enabled() && allowedHere() ? { [GITHUB_APP_SLUG]: GITHUB_TOOLS.map(({ name, description }) => ({ name, description })) } : null),

    /** The JSON-RPC entry the harness proxy reaches: tools/list (what this bot may run) and tools/call (validate, verdict, run). */
    async handle(body: unknown, capability: { botId: string; threadId: string }, assertActive: () => void): Promise<{ tools: GithubTool[]; instructions: string } | GithubToolResult> {
      const request = (body ?? {}) as { method?: unknown; params?: unknown };
      const liveBot = () => deps.bot(capability.botId);
      if (request.method === "tools/list") {
        assertActive();
        const bot = liveBot();
        return { tools: bot && mounts(bot) ? listed(bot) : [], instructions: GITHUB_INSTRUCTIONS };
      }
      if (request.method !== "tools/call") throw new PublicError("unsupported github method", 400);
      const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const problem = githubToolCallProblem(params.name, args);
      if (problem || !isGithubToolName(params.name)) return githubError(problem ?? "Unknown GitHub tool.");
      const name = params.name;
      assertActive();
      const bot = liveBot();
      if (!bot) return githubError("This bot no longer exists.");
      if (!allowedHere() || !enabled()) return githubError("GitHub is not available.");
      const allowed = githubAccess(bot, name);
      if (!allowed.ok) {
        appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: name, decision: "auto-denied", source: "connector-scope", rule: allowed.rule });
        return githubError(allowed.text);
      }
      const result = await call(name, args, bot, capability, assertActive);
      assertActive();
      return result;
    },
  };
}

export type GithubHost = ReturnType<typeof createGithubHost>;
