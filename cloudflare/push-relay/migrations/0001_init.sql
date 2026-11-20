-- The push relay holds no account, no raw IP address, and no message text.
CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  blocked_until INTEGER
);

CREATE TABLE installation_credentials (
  lookup_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX installation_credentials_installation ON installation_credentials(installation_id);

CREATE TABLE push_devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('apns', 'fcm')),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 64 AND 4096),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  purpose TEXT NOT NULL CHECK (purpose IN ('alert', 'activity', 'activity-start')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  PRIMARY KEY (installation_id, token_hash)
);
CREATE INDEX push_devices_token_hash ON push_devices(token_hash);

CREATE TABLE action_limits (
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (subject, action, window_start)
);
