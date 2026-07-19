CREATE TABLE database_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO database_metadata (key, value, updated_at)
VALUES (
  'database_schema_version',
  '1.0.0',
  '2026-07-19T00:00:00Z'
);
