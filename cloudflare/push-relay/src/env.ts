export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The Worker bindings and settings. Written by hand: the APNs and FCM secrets are optional, so `wrangler types` does not list them. */
export interface AppEnv {
  DB: D1Database;
  ENROLL_LIMITER: RateLimiter;
  REQUEST_LIMITER: RateLimiter;
  /** "true" turns off register, send, and activity. */
  PUSH_PAUSED?: string;
  /** "true" turns off enroll. */
  ENROLL_PAUSED?: string;
  /** Comma list of "production" and "sandbox". */
  APNS_ENVIRONMENTS?: string;
  ENROLL_PER_IP_DAILY?: string;
  ENROLL_GLOBAL_DAILY?: string;
  SEND_GLOBAL_HOURLY?: string;
  TOKEN_DAILY?: string;
  /** Secret. Keys the hash of each IP address. Without it, enroll fails closed. */
  IP_HASH_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
  /** Secret. The service-account JSON file of Firebase, whole. */
  FCM_SERVICE_ACCOUNT?: string;
}

export interface Deps {
  fetch: typeof fetch;
  /** Milliseconds since the epoch. */
  now: () => number;
}
