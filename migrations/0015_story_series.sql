CREATE TABLE story_series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  normalized_title TEXT NOT NULL UNIQUE,
  created_by_tg_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX story_series_updated_idx
  ON story_series (updated_at DESC, title);

CREATE TABLE story_series_media (
  story_id TEXT NOT NULL REFERENCES story_series (id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  added_by_tg_user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (story_id, media_id)
);

CREATE INDEX story_series_media_story_idx
  ON story_series_media (story_id, added_at DESC, media_id);
CREATE INDEX story_series_media_media_idx
  ON story_series_media (media_id, story_id);

CREATE TABLE story_series_sessions (
  tg_user_id TEXT PRIMARY KEY,
  story_id TEXT REFERENCES story_series (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('awaiting_title', 'awaiting_media_query')),
  query TEXT,
  page INTEGER NOT NULL DEFAULT 1 CHECK (page >= 1),
  updated_at TEXT NOT NULL,
  CHECK (
    (mode = 'awaiting_title' AND story_id IS NULL)
    OR (mode = 'awaiting_media_query' AND story_id IS NOT NULL)
  )
);

CREATE INDEX story_series_sessions_story_idx
  ON story_series_sessions (story_id, updated_at DESC);
