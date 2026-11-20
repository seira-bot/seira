-- An operator blocks an account by its ID. There is no foreign key: a block
-- may exist before the account has any row in this database.
CREATE TABLE account_blocks (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- A block ends the account's installations the way revoking each one does.
-- The next cleanup run removes their endpoints.
CREATE TRIGGER account_blocks_revoke_after_insert
AFTER INSERT ON account_blocks
BEGIN
  UPDATE installations
     SET revoked_at = NEW.created_at, updated_at = NEW.created_at
   WHERE owner_user_id = NEW.user_id AND revoked_at IS NULL;
  UPDATE installation_credentials
     SET revoked_at = NEW.created_at
   WHERE revoked_at IS NULL
     AND installation_id IN (SELECT id FROM installations WHERE owner_user_id = NEW.user_id);
  DELETE FROM installation_push_devices
   WHERE installation_id IN (SELECT id FROM installations WHERE owner_user_id = NEW.user_id);
END;

CREATE TRIGGER installations_blocked_owner_before_insert
BEFORE INSERT ON installations
WHEN EXISTS (SELECT 1 FROM account_blocks WHERE user_id = NEW.owner_user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_blocked');
END;
