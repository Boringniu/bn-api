-- 截图确认：新频道 ADN-100 的转发可见 caption 包含 #松下纱荣子。
-- 仅回填消息 15–17，保留频道原消息不变。

UPDATE media
SET
  raw_payload_json = json_set(
    raw_payload_json,
    '$.raw_tags',
    json_array('松下纱荣子')
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT cp.media_id
  FROM channel_posts cp
  JOIN media m ON m.id = cp.media_id
  WHERE cp.tg_chat_id = '-1004396154285'
    AND cp.tg_message_id BETWEEN 15 AND 17
    AND m.normalized_code = 'ADN-100'
);

DELETE FROM media_tags
WHERE media_id IN (
  SELECT cp.media_id
  FROM channel_posts cp
  JOIN media m ON m.id = cp.media_id
  WHERE cp.tg_chat_id = '-1004396154285'
    AND cp.tg_message_id BETWEEN 15 AND 17
    AND m.normalized_code = 'ADN-100'
);

INSERT INTO media_tags (
  media_id,
  tag_id,
  display_name_snapshot,
  tag_group,
  weight,
  display_enabled,
  search_enabled,
  matched_raw_values_json,
  match_sources_json
)
SELECT
  cp.media_id,
  'tag_topic_4802e7fc8bee920f',
  '松下纱荣子',
  'other',
  0,
  1,
  1,
  '["松下纱荣子"]',
  '["manual_backfill"]'
FROM channel_posts cp
JOIN media m ON m.id = cp.media_id
WHERE cp.tg_chat_id = '-1004396154285'
  AND cp.tg_message_id BETWEEN 15 AND 17
  AND m.normalized_code = 'ADN-100';
