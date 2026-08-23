-- 用户确认：JUR-754 的“七海ティナ”已不在频道中，仅为目录残留。
-- 先写入独立审计快照，再删除该目录记录；不调用 Telegram，也不影响其他 JUR-754 记录。
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
  'stale-japanese-duplicate-purge-' || lower(hex(randomblob(16))),
  m.id,
  cp.tg_chat_id,
  cp.tg_message_id,
  mf.tg_file_unique_id,
  'user_authorized_stale_duplicate_cleanup',
  json_object(
    'media_id', m.id,
    'normalized_code', m.normalized_code,
    'title', m.title,
    'status', m.status,
    'updated_at', m.updated_at,
    'tg_chat_id', cp.tg_chat_id,
    'tg_message_id', cp.tg_message_id,
    'tg_file_unique_id', mf.tg_file_unique_id,
    'cleanup_reason', 'User confirmed Japanese-name duplicate has no channel resource'
  ),
  'completed',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'User-authorized cleanup of stale Japanese-name duplicate; no Telegram delete attempted.',
  'legacy_catalog_only'
FROM media m
JOIN channel_posts cp ON cp.media_id = m.id
LEFT JOIN media_files mf ON mf.media_id = m.id
WHERE m.normalized_code = 'JUR-754'
  AND m.title LIKE '%七海ティナ%';

DELETE FROM media
WHERE id IN (
  SELECT m.id
  FROM media m
  WHERE m.normalized_code = 'JUR-754'
    AND m.title LIKE '%七海ティナ%'
);
