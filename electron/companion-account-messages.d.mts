// Types for companion-account-messages.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.

export type FriendlyMessageCode =
  | "invalid_email" | "invalid_request" | "invalid_otp" | "otp_expired" | "unauthorized" | "forbidden" | "signed_out"
  | "network_unavailable" | "rate_limited" | "credential_rotation_rate_limited" | "sign_in_unavailable" | "signup_closed"
  | "device_limit" | "endpoint_limit" | "account_blocked" | "installation_limit_reached" | "installation_exists"
  | "endpoint_busy" | "endpoint_rate_limited" | "update_required" | "endpoint_capacity" | "endpoint_unavailable"
  | "endpoint_cleanup_pending" | "control_plane_unavailable" | "internal_error" | "invalid_response" | "request_failed";

/** One line per control-plane code. "{wait}" in a text stands for the retry delay. */
export declare const FRIENDLY_MESSAGES: Readonly<Record<FriendlyMessageCode, string>>;
export declare function friendlyCompanionAccountError(error: unknown): string;
