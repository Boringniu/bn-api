CREATE TABLE story_series_removal_sessions (
  tg_user_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES story_series (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX story_series_removal_sessions_story_idx
  ON story_series_removal_sessions (story_id, created_at DESC);

CREATE TABLE story_series_admin_audit (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('delete_story', 'remove_story_media')),
  story_id TEXT NOT NULL,
  media_id TEXT,
  operator_tg_user_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX story_series_admin_audit_story_idx
  ON story_series_admin_audit (story_id, created_at DESC);
