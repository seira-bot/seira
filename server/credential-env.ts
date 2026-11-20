// Credential env names and the strippers that keep them out of child processes. Lives apart from
// config.ts so the lists can grow (one name per engine) without that file growing with them.

/** Workspace credential env names; spawned engine CLIs must never inherit them. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "SEIRA_GROQ_API_KEY",
  "SEIRA_GREENFERENCE_API_KEY",
  "SEIRA_MODELGO_API_KEY",
  "SEIRA_META_API_KEY",
  "SEIRA_DEEPSEEK_API_KEY",
  "SEIRA_ANTHROPIC_API_KEY",
  "SEIRA_ANTHROPIC_API_URL",
  "SEIRA_HOSTED_MODEL_TOKEN",
  "SEIRA_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "SEIRA_OPENAI_API_KEY",
  "SEIRA_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "SEIRA_TTS_KEY",
  "SEIRA_FISH_AUDIO_API_KEY",
  "SEIRA_GEMINI_API_KEY",
  "SEIRA_JEV_API_KEY",
  "SEIRA_OPENROUTER_DECIDER_KEY",
  "SEIRA_WORKERS_AI_TOKEN",
  "SEIRA_CUSTOM_DECIDER_KEY",
  "SEIRA_OPENAI_IMAGE_KEY",
  "SEIRA_CUSTOM_IMAGE_KEY",
  "SEIRA_GEMINI_IMAGE_KEY",
  "SEIRA_OPENAI_LIVE_KEY", "SEIRA_TREG_KEY", "SEIRA_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "SEIRA_COMPOSIO_BROKER_TOKEN",
  "SEIRA_CLOUD_BOAT_TOKEN",
  "SEIRA_CLOUD_VOICE_TOKEN",
  "SEIRA_CLOUD_DECIDER_TOKEN",
  "SEIRA_CLOUD_AI_TOKEN", "SEIRA_CLOUD_X_TOKEN", "SEIRA_CLOUD_HOSTING_TOKEN", "SEIRA_CLOUD_CONNECTED_APPS_GRANT",
  // Not credentials, but they point a shell-capable agent at app-owned state.
  "SEIRA_BROWSER_CONNECTION", "SEIRA_USER_DATA", "SEIRA_BOAT_API",
] as const;

/** Operator secrets only this process reads, plus every `SEIRA_CLOUD_` var (the underscore leaves out SEIRA_CLOUDFLARED_PATH). */
export const CONTROL_PLANE_ENV = ["SEIRA_LICENSE_KEY", "SEIRA_INSTALLATION_CREDENTIAL", "SEIRA_SIGNIN_SMTP_URL", "SEIRA_TOKEN"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "SEIRA_CLOUD_";

/** Names compare case-insensitively because Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = canonicalEnvName(key);
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

/** An env name as filters compare it: in capitals (Windows environments are case-insensitive) with the old `OMB_` prefix read as `SEIRA_`. */
export function canonicalEnvName(name: string): string {
  const upper = name.toUpperCase();
  return upper.startsWith("OMB_") ? `SEIRA_${upper.slice("OMB_".length)}` : upper;
}

/** Deletes every name of `env` that matches one of `names` under {@link canonicalEnvName}, except a name `keep` lists exactly (in capitals,
 * and not under the old prefix). */
export function stripEnvNames(env: Record<string, string | undefined>, names: readonly string[], keep: readonly string[] = []): void {
  const denied = new Set(names.map(canonicalEnvName));
  const kept = new Set(keep.map((name) => name.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (denied.has(canonicalEnvName(key)) && !kept.has(key.toUpperCase())) delete env[key];
  }
}

/** Removes every workspace credential in any letter case, and its `OMB_` twin. `keep` spares a name (in capitals), never its twin. */
export function stripWorkspaceCredentialKeys(env: Record<string, string | undefined>, keep: ReadonlySet<string> = new Set()): void {
  stripEnvNames(env, WORKSPACE_CREDENTIAL_ENV, [...keep]);
}

export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  stripWorkspaceCredentialKeys(env);
  stripControlPlaneEnv(env);
}

const DESKTOP_STORE_KEY_ENV: ReadonlySet<string> = new Set(["MISTRAL_API_KEY", "CEREBRAS_API_KEY", "OPENAI_COMPAT_API_KEY", "SEIRA_OPENAI_API_KEY", "SEIRA_OPENROUTER_API_KEY"]);

/** A key an operator set on the server. Security: under the desktop app these variables hold workspace keys from its
 * encrypted store, which reach only the instances the workspace routes, never one with a URL of its own. */
export function operatorEnvKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SEIRA_DESKTOP_PARENT === "1" && DESKTOP_STORE_KEY_ENV.has(name) ? undefined : env[name];
}

/** Env a provider CLI may read as its billing identity; a foreign key must never move a subscription CLI onto API billing. */
export const PROVIDER_CREDENTIAL_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "GREENFERENCE_API_KEY",
  "MODELGO_API_KEY",
  "META_API_KEY",
  "DEEPSEEK_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment (with ANTHROPIC_API_KEY set it lists Anthropic's models). */
export const OPENCODE_PROVIDER_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
