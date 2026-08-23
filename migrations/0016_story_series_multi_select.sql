CREATE TABLE story_series_session_media (
  tg_user_id TEXT NOT NULL REFERENCES story_series_sessions (tg_user_id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (tg_user_id, media_id)
);

CREATE INDEX story_series_session_media_user_idx
  ON story_series_session_media (tg_user_id, selected_at DESC, media_id);
