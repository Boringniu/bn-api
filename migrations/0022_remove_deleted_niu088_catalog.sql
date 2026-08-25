-- 用户已明确确认：频道消息 1782 已由用户删除，且该频道账号已被封禁。
-- 先保存该单条目录记录的审计快照，再由 media 的外键级联删除目录关联。
-- 不调用 Telegram API，不删除任何其他媒体或频道消息。
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
  'deleted-channel-niu088-' || lower(hex(randomblob(16))),
  m.id,
  cp.tg_chat_id,
  cp.tg_message_id,
  mf.tg_file_unique_id,
  'user_authorized_catalog_cleanup',
  json_object(
    'media_id', m.id,
    'code', m.code,
    'normalized_code', m.normalized_code,
    'title', m.title,
    'status', m.status,
    'updated_at', m.updated_at,
    'tg_chat_id', cp.tg_chat_id,
    'tg_message_id', cp.tg_message_id,
    'tg_file_unique_id', mf.tg_file_unique_id,
    'cleanup_reason', 'User authorized removal after deleted channel message and account ban'
  ),
  'completed',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'User authorized catalog-only cleanup; no Telegram delete attempted.',
  'legacy_catalog_only'
FROM media AS m
JOIN channel_posts AS cp ON cp.media_id = m.id
LEFT JOIN media_files AS mf ON mf.media_id = m.id
WHERE m.id = 'media_d1001f9e161cc8628c4e28814cdea254'
  AND m.code = 'NIU-088'
  AND cp.tg_chat_id = '-1004460339207'
  AND cp.tg_message_id = 1782;

DELETE FROM media
WHERE id = 'media_d1001f9e161cc8628c4e28814cdea254'
  AND code = 'NIU-088'
  AND EXISTS (
    SELECT 1
    FROM channel_posts AS cp
    WHERE cp.media_id = media.id
      AND cp.tg_chat_id = '-1004460339207'
      AND cp.tg_message_id = 1782
  );
