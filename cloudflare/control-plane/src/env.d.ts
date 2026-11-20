// Bindings and values that only Better Auth mode reads, or that a deployment may leave out of
// wrangler.jsonc. `wrangler types` does not declare them when a deployment drops them.
declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_URL?: string;
    EMAIL?: SendEmail;
    EMAIL_FROM?: string;
    CLOUDFLARE_ENDPOINT_ACCOUNTS?: unknown;
    CLOUDFLARE_API_TOKEN_SEIRA_SI?: string;
    RELAY_TOKEN_SIGNING_KEY?: string;
  }
}
