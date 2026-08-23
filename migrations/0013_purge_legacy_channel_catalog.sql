-- 用户已明确确认：已注销旧频道的目录遗留应直接销毁；当前频道为 -1004460339207。
-- 先保留逐条审计快照，再删除 media，以外键级联清理其目录关联项。
INSERT INTO duplicate_deletion_audit (
  audit_token,
  media_id,
  tg_chat_id,
  tg_message_id,
  tg_file_unique_id,
  deleted_by_tg_user_id,
  snapshot_json,
  outcome,
  requested_at,
  catalog_deleted_at,
  error_message,
  deletion_scope
)
SELECT
  'legacy-channel-purge-' || lower(hex(randomblob(16))),
  m.id,
  cp.tg_chat_id,
  cp.tg_message_id,
  mf.tg_file_unique_id,
  'user_authorized_bulk_cleanup',
  json_object(
    'media_id', m.id,
    'normalized_code', m.normalized_code,
    'title', m.title,
    'status', m.status,
    'updated_at', m.updated_at,
    'tg_chat_id', cp.tg_chat_id,
    'tg_message_id', cp.tg_message_id,
    'tg_file_unique_id', mf.tg_file_unique_id,
    'raw_payload_json', m.raw_payload_json,
    'cleanup_reason', 'User authorized removal after legacy channel closure'
  ),
  'completed',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'User-authorized bulk cleanup after legacy channel closure; no Telegram delete attempted.',
  'legacy_catalog_only'
FROM channel_posts cp
JOIN media m ON m.id = cp.media_id
LEFT JOIN media_files mf ON mf.media_id = m.id
WHERE cp.tg_chat_id <> '-1004460339207';

DELETE FROM media
WHERE id IN (
  SELECT media_id
  FROM channel_posts
  WHERE tg_chat_id <> '-1004460339207'
);
