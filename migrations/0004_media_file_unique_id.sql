ALTER TABLE media_files ADD COLUMN tg_file_unique_id TEXT;

CREATE INDEX media_files_unique_idx
  ON media_files (tg_file_unique_id);
CREATE INDEX media_files_file_idx
  ON media_files (tg_file_id);
