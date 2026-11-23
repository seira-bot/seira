// Values that only Better Auth mode reads, or that a deployment may leave out of wrangler.jsonc.
// `wrangler types` does not declare a value that wrangler.jsonc omits.
interface OptionalDeploymentEnv {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  CLOUDFLARE_ENDPOINT_ACCOUNTS?: unknown;
  CLOUDFLARE_API_TOKEN_SEIRA_SI?: string;
  RELAY_TOKEN_SIGNING_KEY?: string;
}

declare namespace Cloudflare {
  interface Env extends OptionalDeploymentEnv {}
}

interface Env extends OptionalDeploymentEnv {}
