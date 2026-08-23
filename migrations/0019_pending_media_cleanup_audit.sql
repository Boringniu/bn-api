CREATE TABLE pending_media_cleanup_audit (
  audit_token TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  deleted_by_tg_user_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'completed', 'not_found')),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE INDEX pending_media_cleanup_audit_media_idx
  ON pending_media_cleanup_audit (media_id, requested_at DESC);

CREATE INDEX pending_media_cleanup_audit_operator_idx
  ON pending_media_cleanup_audit (deleted_by_tg_user_id, requested_at DESC);

CREATE TABLE pending_media_cleanup_sessions (
  tg_user_id TEXT PRIMARY KEY,
  media_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
