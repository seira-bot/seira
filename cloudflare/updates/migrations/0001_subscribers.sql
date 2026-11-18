CREATE TABLE subscribers (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  text_version TEXT NOT NULL,
  confirm_hash TEXT,
  confirm_sent_at INTEGER,
  confirmed_hash TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  unsubscribed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subscribers_confirm_hash ON subscribers (confirm_hash) WHERE confirm_hash IS NOT NULL;

CREATE TABLE receipts (
  receipt_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES subscribers (email),
  install_id TEXT,
  text_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  confirm_hash TEXT
);

CREATE INDEX receipts_email ON receipts (email);
