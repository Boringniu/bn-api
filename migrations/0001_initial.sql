CREATE TABLE media (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  source_url TEXT,
  code TEXT,
  normalized_code TEXT,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  description TEXT,
  release_date TEXT,
  year INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2200),
  duration_seconds INTEGER CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  ),
  cover_url TEXT,
  subtitle INTEGER NOT NULL DEFAULT 0 CHECK (subtitle IN (0, 1)),
  category_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('approved', 'pending', 'rejected', 'disabled')
  ),
  ruleset_version TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  normalization_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_provider, source_external_id)
);

CREATE INDEX media_status_updated_idx
  ON media (status, updated_at DESC);
CREATE INDEX media_code_idx
  ON media (normalized_code);
CREATE INDEX media_category_idx
  ON media (category_id, status);
CREATE INDEX media_year_idx
  ON media (year DESC, status);
CREATE INDEX media_title_idx
  ON media (normalized_title);

CREATE TABLE media_category_candidates (
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  priority INTEGER NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 0 CHECK (is_selected IN (0, 1)),
  matched_raw_values_json TEXT NOT NULL,
  match_sources_json TEXT NOT NULL,
  PRIMARY KEY (media_id, category_id)
);

CREATE INDEX media_category_candidates_category_idx
  ON media_category_candidates (category_id, media_id);

CREATE TABLE media_actors (
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  display_enabled INTEGER NOT NULL CHECK (display_enabled IN (0, 1)),
  search_enabled INTEGER NOT NULL CHECK (search_enabled IN (0, 1)),
  matched_raw_values_json TEXT NOT NULL,
  match_sources_json TEXT NOT NULL,
  PRIMARY KEY (media_id, actor_id)
);

CREATE INDEX media_actors_actor_idx
  ON media_actors (actor_id, media_id);

CREATE TABLE media_tags (
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  tag_group TEXT NOT NULL,
  weight INTEGER NOT NULL,
  display_enabled INTEGER NOT NULL CHECK (display_enabled IN (0, 1)),
  search_enabled INTEGER NOT NULL CHECK (search_enabled IN (0, 1)),
  matched_raw_values_json TEXT NOT NULL,
  match_sources_json TEXT NOT NULL,
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX media_tags_tag_idx
  ON media_tags (tag_id, media_id);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected', 'ignored', 'merged')
  ),
  trigger TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  raw_values_json TEXT NOT NULL,
  normalized_values_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  required_reviewer_role TEXT NOT NULL,
  allow_ai_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (
    allow_ai_suggestion IN (0, 1)
  ),
  origin TEXT NOT NULL DEFAULT 'ingest',
  reviewer_id TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX review_items_queue_idx
  ON review_items (status, required_reviewer_role, created_at);
CREATE INDEX review_items_media_idx
  ON review_items (media_id, status);

CREATE TABLE ingest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  source_provider TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'updated')),
  media_status TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX ingest_events_media_idx
  ON ingest_events (media_id, created_at DESC);
