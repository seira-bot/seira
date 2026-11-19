ALTER TABLE reports ADD COLUMN ip_hash TEXT;

CREATE INDEX reports_ip_created ON reports (ip_hash, created_at);
