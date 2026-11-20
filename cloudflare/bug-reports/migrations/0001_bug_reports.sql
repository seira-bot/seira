CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  install_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  issue_number INTEGER,
  comment_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX reports_install_created ON reports (install_hash, created_at);
CREATE INDEX reports_created ON reports (created_at);
CREATE INDEX reports_install_payload ON reports (install_hash, payload_hash);

CREATE TABLE fingerprints (
  fingerprint TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE issues (
  number INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'fixed', 'closed')),
  fixed_in TEXT,
  checked_at INTEGER NOT NULL
);
