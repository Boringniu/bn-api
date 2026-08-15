-- Existing ADN-100 entries already preserve #松下纱荣子 as a topic.
-- Promote that verified topic to an actress association as well, so the new
-- actress-directory search can return it. The original topic remains intact.
INSERT INTO media_actors (
  media_id,
  actor_id,
  position,
  display_name_snapshot,
  display_enabled,
  search_enabled,
  matched_raw_values_json,
  match_sources_json
)
SELECT DISTINCT
  mt.media_id,
  'actor_000021',
  0,
  '松下纱荣子',
  1,
  1,
  '["松下纱荣子"]',
  '["topic_actor_promotion"]'
FROM media_tags AS mt
JOIN media AS m ON m.id = mt.media_id
JOIN channel_posts AS cp ON cp.media_id = m.id
WHERE cp.tg_chat_id = '-1004396154285'
  AND m.status = 'approved'
  AND mt.display_name_snapshot = '松下纱荣子'
ON CONFLICT (media_id, actor_id) DO NOTHING;
