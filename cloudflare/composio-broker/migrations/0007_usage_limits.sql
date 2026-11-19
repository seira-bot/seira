-- Usage limits and cost watch (FR-147..149). Counts only: no tool arguments, results, or addresses.

-- Daily counts per installation (UTC day), which also enforce the daily quotas.
-- installation_id '' keeps the counts of erased installations, so fleet totals stay right.
CREATE TABLE usage_days (
  day            TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  connect_links  INTEGER NOT NULL DEFAULT 0,
  refused_quota  INTEGER NOT NULL DEFAULT 0,
  refused_fleet  INTEGER NOT NULL DEFAULT 0,
  refused_paused INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, installation_id)
);

-- New installations per UTC day and source. source is the SHA-256 of the IPv4 address or the IPv6 /64, never the address.
CREATE TABLE registration_days (
  day           TEXT NOT NULL,
  source        TEXT NOT NULL,
  registrations INTEGER NOT NULL DEFAULT 0,
  refused       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);

-- Owner-set limits and the kill switch, read by the Worker every 30 seconds. A missing key uses the default in
-- src/limits.ts. Change a value with `wrangler d1 execute`; no redeploy (README, "Usage limits").
CREATE TABLE broker_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Alerts sent, one per kind per UTC day.
CREATE TABLE usage_alerts (
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (day, kind)
);
