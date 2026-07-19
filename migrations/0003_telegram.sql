CREATE TABLE channel_posts (
  media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
  tg_chat_id TEXT NOT NULL,
  tg_message_id INTEGER NOT NULL,
  template_version TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX channel_posts_chat_idx
  ON channel_posts (tg_chat_id, tg_message_id);

CREATE TABLE search_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id TEXT,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  resolution_type TEXT,
  resolution_target TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX search_logs_query_idx
  ON search_logs (normalized_query, created_at DESC);
CREATE INDEX search_logs_missed_idx
  ON search_logs (resolution_type, created_at DESC);

CREATE TABLE media_files (
  media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
  tg_file_id TEXT NOT NULL,
  source_chat_id TEXT,
  source_message_id TEXT,
  imported_from TEXT,
  created_at TEXT NOT NULL
);
