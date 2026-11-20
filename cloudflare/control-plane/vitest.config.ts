import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

const root = fileURLToPath(new URL(".", import.meta.url));
const TEST_AUTH_SECRET = "test-only-better-auth-secret-with-more-than-32-characters";
const TEST_CLOUDFLARE_TOKEN = "test-only-cloudflare-api-token-with-no-real-access";
const wranglerPath = fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// What the deployment file says, for the test that pins it.
const deployedVars = unstable_readConfig({ config: wranglerPath }).vars;
// Rows written before an account was recorded default to this account (migration 0007).
const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
const accountMigration = readdirSync(migrationsDir).find((name) => name.startsWith("0007_"));
const TEST_CLOUDFLARE_ACCOUNT_ID = /DEFAULT '([0-9a-f]{32})'/.exec(
  readFileSync(`${migrationsDir}${accountMigration}`, "utf8"),
)![1];
const TEST_CLOUDFLARE_ZONE_ID = "fedcba9876543210fedcba9876543210";
process.env.BETTER_AUTH_SECRET ??= TEST_AUTH_SECRET;
process.env.CLOUDFLARE_API_TOKEN ??= TEST_CLOUDFLARE_TOKEN;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: wranglerPath },
      miniflare: {
        bindings: {
          // The suite runs in Better Auth mode. The Seira Cloud tests pass their own Env.
          ACCOUNT_SERVICE: "",
          BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
          BETTER_AUTH_URL: "https://accounts.seira.bot",
          EMAIL_FROM: "noreply@seira.bot",
          CLOUDFLARE_API_TOKEN: TEST_CLOUDFLARE_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: TEST_CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_ZONE_ID: TEST_CLOUDFLARE_ZONE_ID,
          COMPANION_HOST_SUFFIX: "seira.bot",
          // A busy test account is not a limit test; the limit tests set their own.
          SEIRA_ENDPOINTS_PER_ACCOUNT: "100",
          SEIRA_TUNNEL_LIMIT: "1000",
          SEIRA_DNS_RECORD_LIMIT: "3500",
          SEIRA_CLEANUP_SWEEP_LIMIT: "20",
          RELAY_NODES: "relay1.seira.bot,relay2.seira.bot",
          RELAY_NODES_AMERICAS: "",
          RELAY_TOKEN_KID: "k1",
          RELAY_ROLLOUT_PERCENT: "100",
          RELAY_ALLOW_INSTALLATIONS: "",
          RELAY_DISABLED: "0",
          RELAY_CAPABLE_MIN_VERSION: "0.1.145",
          // The suite starts from the primary account alone; the account
          // tests add accounts themselves.
          CLOUDFLARE_ENDPOINT_ACCOUNTS: "",
          TEST_DEPLOYED_ENDPOINT_ACCOUNTS: JSON.stringify(deployedVars.CLOUDFLARE_ENDPOINT_ACCOUNTS ?? []),
          TEST_DEPLOYED_DNS_RECORD_LIMIT: String(deployedVars.SEIRA_DNS_RECORD_LIMIT),
          ALLOWED_ORIGINS: "https://app.seira.test",
          // Production starts in observe (wrangler.jsonc); the suite exercises reclaiming.
          SEIRA_TUNNEL_RECLAIM: "on",
          // The tunnel release switches as the code defaults them (off), whatever wrangler.jsonc has live; the
          // release and cutoff tests turn each one on themselves.
          RELAY_TUNNEL_RELEASE_PERCENT: "0",
          RELAY_TUNNEL_RELEASE_DAYS: "3",
          TUNNEL_LEGACY_PHONE_CUTOFF_PERCENT: "0",
          TUNNEL_MIN_APP_VERSION: "",
          TUNNEL_REASON_MIN_VERSION: "",
          TEST_MIGRATIONS: await readD1Migrations(`${root}migrations`),
        },
        // Better Auth mode sends OTP email; the deployment file has no such binding.
        email: { send_email: [{ name: "EMAIL" }] },
        // The SEIRA_CLOUD binding needs a worker of this name. It answers 500, so a test that forgets
        // its own stub sees an outage, never a sign-in.
        workers: [{
          name: "seira-cloud",
          modules: true,
          script: "export default { fetch() { return new Response('{\"error\":\"internal\"}', { status: 500 }); } };",
        }],
        // An empty database for migration tests that need data written by an
        // older schema before the next migration runs.
        d1Databases: ["MIGRATION_DB", "PUSH_MIGRATION_DB"],
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
