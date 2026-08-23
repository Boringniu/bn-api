CREATE TABLE duplicate_deletion_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_token TEXT NOT NULL UNIQUE,
  media_id TEXT NOT NULL,
  tg_chat_id TEXT NOT NULL,
  tg_message_id INTEGER NOT NULL,
  tg_file_unique_id TEXT,
  deleted_by_tg_user_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'telegram_delete_failed', 'completed')),
  requested_at TEXT NOT NULL,
  telegram_deleted_at TEXT,
  catalog_deleted_at TEXT,
  error_message TEXT
);

CREATE INDEX duplicate_deletion_audit_media_idx
  ON duplicate_deletion_audit (media_id, requested_at DESC);

CREATE INDEX duplicate_deletion_audit_operator_idx
  ON duplicate_deletion_audit (deleted_by_tg_user_id, requested_at DESC);
