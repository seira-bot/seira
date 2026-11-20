// Whether this computer can already reach GitHub, so that a bot's request for a GitHub token gets no card.
// Security: the check learns only yes or no. It never reads, prints, keeps or returns a token. gh runs without -t, its
// output goes nowhere, and a check that fails or runs too long counts as no access, so the card shows as before.
import { spawn, type ChildProcess } from "node:child_process";

import { homeProgramsDistrusted } from "./bot-box/program-trust.ts";
import { PROVIDER_CREDENTIAL_ENV, stripEnvNames, stripWorkspaceCredentialEnv } from "./credential-env.ts";
import { augmentedPath, userHome } from "./env-path.ts";
import { OWN_GROUP, stopGroup } from "./group-exec.ts";

export const GITHUB_CHECK_TIMEOUT_MS = 5_000;
/** gh 2.x: exits 0 only when its sign-in for github.com works, and shows no token without -t (--show-token). */
export const GITHUB_STATUS_ARGS = ["auth", "status", "--hostname", "github.com"] as const;
/** gh 2.x uses these before its own sign-in. The check removes them, so it sees only the sign-in gh keeps under HOME. */
const GITHUB_TOKEN_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

const GITHUB_NAMES = new Set(["github", "gh", "ghp", "gho"]);
const TOKEN_WORDS = new Set(["token", "tokens", "pat", "pats", "credential", "credentials", "access", "auth", "api"]);
const GENERIC_TOKEN_WORDS = new Set(["personal", "access", "token", "tokens", "pat", "pats", "classic", "fine", "grained", "api", "key", "auth"]);
/** GitHub secrets that a gh sign-in does not replace, and GitHub hosts other than github.com. */
const OTHER_SECRET = new Set([
  "webhook", "webhooks", "secret", "secrets", "private", "ssh", "deploy", "gpg", "signing", "app", "apps", "oauth", "client",
  "enterprise", "ghe", "ghes", "packages", "package", "registry", "ghcr", "npm", "docker", "container", "runner", "actions",
  "models", "copilot", "password", "username",
]);
const OTHER_HOST = new Set(["enterprise", "ghe", "ghes"]);

function words(text: string): string[] {
  return text.replace(/github/giu, " github ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

export interface CredentialAsk {
  label: string;
  reason?: string;
  placeholder?: string;
}

/** A request for a token that works with GitHub on github.com, by its label and placeholder; a generic label counts
 * only when its reason names GitHub. */
export function asksForGithubToken(ask: CredentialAsk): boolean {
  const named = words(`${ask.label} ${ask.placeholder ?? ""}`);
  const why = words(ask.reason ?? "");
  if (named.some((word) => OTHER_SECRET.has(word)) || why.some((word) => OTHER_HOST.has(word))) return false;
  if (named.some((word) => GITHUB_NAMES.has(word))) {
    return named.every((word) => GITHUB_NAMES.has(word)) || named.some((word) => TOKEN_WORDS.has(word));
  }
  return named.length > 0 && named.every((word) => GENERIC_TOKEN_WORDS.has(word))
    && why.some((word) => GITHUB_NAMES.has(word)) && !why.some((word) => OTHER_SECRET.has(word));
}

/** The server's own HOME and PATH for gh, without a token that gh would use before its own sign-in. */
export function githubCheckEnvironment(source: NodeJS.ProcessEnv = process.env, path: string = augmentedPath()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: path, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  if (process.platform !== "win32") env.HOME = userHome(source);
  stripWorkspaceCredentialEnv(env);
  stripEnvNames(env, [...PROVIDER_CREDENTIAL_ENV, ...GITHUB_TOKEN_ENV]);
  return env;
}

/** The exit code of a command whose output nobody reads; null when it does not start, a signal stops it, or it runs past
 * `timeoutMs`. */
function exitCode(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { env, stdio: "ignore", ...OWN_GROUP });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      stopGroup(child);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** True when gh is signed in to github.com for the user the server runs as. */
export async function localGithubAccess(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<boolean> {
  // Security: with the bot box on, a boxed bot can write folders on PATH, so the server runs no gh from them.
  if (homeProgramsDistrusted()) return false;
  const env = options.env ?? githubCheckEnvironment();
  return await exitCode("gh", GITHUB_STATUS_ARGS, env, options.timeoutMs ?? GITHUB_CHECK_TIMEOUT_MS) === 0;
}

/** What the bot hears instead of a card. */
export function githubAccessText(label: string): string {
  return `Seira showed no card for ${label}: this computer already has GitHub access, because gh is signed in to github.com. `
    + "Use gh for GitHub work. For git over HTTPS, add -c credential.helper= -c 'credential.helper=!gh auth git-credential' to the git command. "
    + "Never show the token: do not run gh auth token or gh auth status -t. "
    + "If a command fails because of a missing scope or another account, show the person the exact error and ask them to fix the gh sign-in. "
    + "If you need a secret for another service, ask again with a label that names that service.";
}
