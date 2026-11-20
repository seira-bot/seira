// The environment a boxed process gets: an allow-list, never the server's whole environment. The drivers already strip
// the workspace credentials and every SEIRA_CLOUD_ setting before a spawn (server/config.ts stripWorkspaceCredentialEnv);
// this is the second gate, applied at the box boundary, so a name a driver forgot never reaches a bot's shell.

/** Names a bot's engine, its tools and the proxies Seira starts inside the box may read. */
export const BOX_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "HOSTNAME", "PWD",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG",
  "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AGENT_BROWSER_EXECUTABLE_PATH", "BROWSER", "BASH_MAX_TIMEOUT_MS", "ELECTRON_RUN_AS_NODE", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
]);

/** Seira's own variables a boxed process reads: what the harness sets for a bot's engine, its hooks and the MCP
 * proxies it starts. Security: no other `SEIRA_` name passes, whatever the operator set on the server (an SMTP URL, a
 * token); env.test.ts lists every `SEIRA_` name the server knows, so a new one needs a decision. */
export const BOX_ENV_SEIRA_NAMES: ReadonlySet<string> = new Set([
  "SEIRA_HARNESS_URL", "SEIRA_BOT_ID", "SEIRA_THREAD_ID", "SEIRA_COMMS_TOKEN", "SEIRA_EXTERNAL_RUNTIME",
  "SEIRA_CHIEF_OF_STAFF", "SEIRA_SEIRA", "SEIRA_SKILL_AUTHORING_ENABLED", "SEIRA_MEMORY_ENABLED", "SEIRA_SHARED_COMPUTERS_ENABLED",
  "SEIRA_VOICE_NOTES", "SEIRA_X_RESEARCH", "SEIRA_RESEARCH", "SEIRA_TEAM_PEOPLE", "SEIRA_COMPUTER_SELECTION", "SEIRA_ROOM",
  "SEIRA_IMAGE_GENERATION", "SEIRA_MEETINGS", "SEIRA_APP_HOSTING", "SEIRA_TOOLS_OFF", "SEIRA_LOCAL_VM", "SEIRA_AGENTS_TOOL_BRIDGE", "SEIRA_AGENTS_DEFER_TOOLS", "SEIRA_TOOL_LIMIT", "SEIRA_TOOL_SCHEMA_PROFILE",
  "SEIRA_MCP_CONFIG", "SEIRA_MCP_RESTART", "SEIRA_MCP_RESULT_BUDGET",
  "SEIRA_HOOK_URL", "SEIRA_HOOK_TOKEN_FILE", "SEIRA_HOOK_TIMEOUT_MS", "SEIRA_PERMISSION_TOOL_SCOPE",
  "SEIRA_CONNECTOR_UPSTREAM_URL", "SEIRA_CONNECTOR_UPSTREAM_HEADERS", "SEIRA_CONNECTOR_TOKEN", "SEIRA_CONNECTOR_ALLOWED_TOOLS",
  "SEIRA_CONNECTOR_SERVICE_SLUGS", "SEIRA_CONNECTOR_APP_TOOLS", "SEIRA_CONNECTOR_APP_TOOL_NAMES",
  "SEIRA_GATE_NAME", "SEIRA_GATE_UPSTREAM", "SEIRA_GATE_BUDGET", "SEIRA_GATE_SPILL_DIR", "SEIRA_GATE_SPILL_HINT", "SEIRA_GATE_TOOL_SCOPE",
  "SEIRA_GATE_DIRECTORY", "SEIRA_GATE_APPS", "SEIRA_REMOTE_MCP_SERVER", "SEIRA_REMOTE_MCP_DIRECTORY", "SEIRA_REMOTE_MCP_APPS",
  "SEIRA_CONTROL_URL", "SEIRA_CONTROL_TOKEN", "SEIRA_COMPUTER_JOURNAL", "SEIRA_CUA_ARGS", "SEIRA_CUA_COMMAND", "SEIRA_CUA_PLATFORM", "SEIRA_HOST_FILES",
  "SEIRA_PHONE_TOKEN", "SEIRA_ADB_PATH", "SEIRA_RESOURCES_PATH", "SEIRA_CODEX_AUTH_SOCKET", "SEIRA_CODEX_AUTH_SECRET",
  "SEIRA_COPILOT_MCP_CONFIG", "SEIRA_BROWSER_PROFILE", "SEIRA_BOX_PROBE", "SEIRA_EXTRA_PATH", "SEIRA_TEST_SEALED_PATH",
  "SEIRA_CODEX_API_KEY", "SEIRA_CHATGPT_TOKEN", "SEIRA_COMPANY_API_KEY", "SEIRA_TRIAL_CREDIT_KEY",
]);
/** Families of the same, one variable per server or kind: a harness MCP server's token, a gated or remote server's config. */
export const BOX_ENV_SEIRA_PREFIXES: readonly string[] = ["SEIRA_MCP_TOKEN_", "SEIRA_GATE_CONFIG_", "SEIRA_REMOTE_MCP_CONFIG_"];
/** The key an engine reads for one provider or host: `SEIRA_CODEX_<provider>_TOKEN`, `SEIRA_CODEX_<provider>_HEADER_<n>`,
 * `SEIRA_LOCAL_<host>_API_KEY`, `SEIRA_QWEN_<host>_API_KEY`. Security: the whole name must match, so a server setting
 * that only starts the same way stays on the server. */
export const BOX_ENV_SEIRA_ENGINE_KEY = /^SEIRA_(?:CODEX_[A-Z0-9_]+_(?:TOKEN|HEADER_\d+)|(?:LOCAL|QWEN)_[A-Z0-9_]+_API_KEY)$/;

/** Prefixes of the engines' own settings and keys (T0b replaces the keys with per-turn broker tokens). */
export const BOX_ENV_PREFIXES: readonly string[] = [
  "LC_", "NPM_CONFIG_", "npm_config_",
  "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "OPENCODE_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "GROK_", "XAI_",
  "MISTRAL_", "CEREBRAS_", "GROQ_", "GREENFERENCE_", "MODELGO_", "META_", "MINIMAX_", "KIMI_", "MOONSHOT_", "CURSOR_", "FACTORY_", "CLINE_", "HERMES_",
  "MUSE_", "PI_", "DWEB_", "UNSLOTH_", "FAKE_CLAUDE_", "MCP_", "ANTIGRAVITY_", "AGY_",
];

/** Never, whatever the allow-list says: the control plane's settings and secrets, and the server's own placement. The
 * CLI's session token and server address (server/headless/client.ts) too: nothing in a box reads them. */
export const BOX_ENV_NEVER: ReadonlySet<string> = new Set([
  "SEIRA_LICENSE_KEY", "SEIRA_INSTALLATION_CREDENTIAL", "SEIRA_LOOPBACK_TRUST", "SEIRA_CLOUD_SECRETS_FD",
  "SEIRA_DATA_DIR", "SEIRA_STATIC_DIR", "SEIRA_DUCKDB_DIR", "SEIRA_PORT", "SEIRA_WEBHOOK_PORT",
  "SEIRA_TOKEN", "SEIRA_URL",
]);
export const BOX_ENV_NEVER_PREFIXES: readonly string[] = ["SEIRA_CLOUD_"];

/** `allow` is what one spawn vouches for: the keys the person saved for its engine, under whatever name that engine reads
 * (NANO_GPT_API_KEY, OPENCODE_API_KEY). Security: it lifts the allow-list and `deny` for that process only, and never for
 * a name of Seira's own (`SEIRA_`) or one on the never-list. */
export function boxEnvironmentAllows(name: string, deny: ReadonlySet<string> = new Set(), allow: ReadonlySet<string> = new Set()): boolean {
  if (BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (allow.has(name) && !name.startsWith("SEIRA_")) return true;
  if (deny.has(name)) return false;
  if (name.startsWith("SEIRA_")) {
    return BOX_ENV_SEIRA_NAMES.has(name) || BOX_ENV_SEIRA_PREFIXES.some((prefix) => name.startsWith(prefix)) || BOX_ENV_SEIRA_ENGINE_KEY.test(name);
  }
  return BOX_ENV_NAMES.has(name) || BOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The box's environment: the allowed names of `env` with a value, in a fresh object. `deny` adds names (the workspace
 * credentials) that are refused even when a prefix would allow them. */
export function boxEnvironment(
  env: Record<string, string | undefined>,
  deny: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !boxEnvironmentAllows(name, deny, allow)) continue;
    kept[name] = value;
  }
  return kept;
}

/** The names of `env` that hold the value `instance` gave them: what the environment configured for one engine instance
 * (its saved keys) put in a spawn, for that spawn's `allowEnv`. */
export function instanceEnvNames(instance: Readonly<Record<string, string>>, env: Record<string, string | undefined>): string[] {
  return Object.keys(instance).filter((name) => env[name] !== undefined && env[name] === instance[name]);
}
