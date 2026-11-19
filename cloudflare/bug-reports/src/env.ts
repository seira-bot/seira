export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AppEnv {
  DB: D1Database;
  REPORT_LIMITER: RateLimiter;
  STATUS_LIMITER: RateLimiter;
  GITHUB_REPOSITORY: string;
  GLOBAL_HOURLY_LIMIT: string;
  REPORTS_PAUSED?: string;
  /** "true" files no issue and calls no GitHub API. For tests and local runs only. */
  DRY_RUN?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

export type TokenCache = Map<string, { token: string; expiresAt: number }>;

export interface Deps {
  fetch: typeof fetch;
  /** Milliseconds since the epoch. */
  now: () => number;
  tokens: TokenCache;
}
