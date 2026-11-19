// Secrets the Worker runs without: each one's route answers 503 or 404 until the owner sets it
// (README, "App events"). Not in wrangler.jsonc's secrets.required, which would refuse a deploy without them.
interface Env {
  COMPOSIO_WEBHOOK_SECRET?: string;
  CLOUD_GRANT_SECRET?: string;
  STATS_TOKEN?: string;
  /** A var, not in wrangler.jsonc: the Cloud Admin's origin, which wakes a sleeping Cloud for its app events. */
  CLOUD_ADMIN_URL?: string;
  /** The https webhook the hourly cost watch posts alerts to: Telegram sendMessage, Discord, or Slack (README, "Usage limits"). */
  ALERT_WEBHOOK_URL?: string;
  /** The Telegram chat for alerts, where ALERT_WEBHOOK_URL is a Telegram sendMessage URL. */
  ALERT_CHAT_ID?: string;
}
