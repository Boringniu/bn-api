-- 旧频道 -1004460339207 已永久退出本项目。
-- 本迁移只清理其测试索引及关联数据库记录；不会修改任何 Telegram 消息，
-- 也不会触及新频道 -1004396154285 的媒体。

DELETE FROM media_category_candidates
WHERE media_id IN (
  SELECT id
  FROM media
  WHERE source_provider = 'channel'
    AND source_external_id LIKE '-1004460339207:%'
);

DELETE FROM media_actors
WHERE media_id IN (
  SELECT id
  FROM media
  WHERE source_provider = 'channel'
    AND source_external_id LIKE '-1004460339207:%'
);

DELETE FROM media_tags
WHERE media_id IN (
  SELECT id
  FROM media
  WHERE source_provider = 'channel'
    AND source_external_id LIKE '-1004460339207:%'
);

DELETE FROM review_items
WHERE media_id IN (
  SELECT id
  FROM media
  WHERE source_provider = 'channel'
    AND source_external_id LIKE '-1004460339207:%'
);

DELETE FROM ingest_events
WHERE media_id IN (
  SELECT id
  FROM media
  WHERE source_provider = 'channel'
    AND source_external_id LIKE '-1004460339207:%'
);

DELETE FROM media_files
WHERE source_chat_id = '-1004460339207'
   OR media_id IN (
     SELECT id
     FROM media
     WHERE source_provider = 'channel'
       AND source_external_id LIKE '-1004460339207:%'
   );

DELETE FROM channel_posts
WHERE tg_chat_id = '-1004460339207';

DELETE FROM media
WHERE source_provider = 'channel'
  AND source_external_id LIKE '-1004460339207:%';

DELETE FROM telegram_update_audit
WHERE chat_id = '-1004460339207';
