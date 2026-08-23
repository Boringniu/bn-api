-- 旧版本已把频道完整文字存入 media.title，但尚未把换行后的说明写入 description。
-- 本迁移仅为已审核的频道来源记录补齐空简介；不修改频道消息、媒体文件、标签或剧情关联。

CREATE TABLE media_description_backfill_audit (
  media_id TEXT PRIMARY KEY REFERENCES media (id) ON DELETE CASCADE,
  previous_description TEXT,
  recovered_description TEXT NOT NULL,
  recovery_method TEXT NOT NULL,
  recovered_at TEXT NOT NULL
);

INSERT INTO media_description_backfill_audit (
  media_id,
  previous_description,
  recovered_description,
  recovery_method,
  recovered_at
)
SELECT
  id,
  description,
  trim(substr(title, instr(title, char(10)) + 1)),
  'legacy_multiline_title',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM media
WHERE source_provider = 'channel'
  AND status = 'approved'
  AND (description IS NULL OR trim(description) = '')
  AND instr(title, char(10)) > 0
  AND length(trim(substr(title, instr(title, char(10)) + 1))) > 0
ON CONFLICT(media_id) DO NOTHING;

UPDATE media
SET
  description = (
    SELECT recovered_description
    FROM media_description_backfill_audit audit
    WHERE audit.media_id = media.id
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT media_id
  FROM media_description_backfill_audit
  WHERE recovery_method = 'legacy_multiline_title'
);
