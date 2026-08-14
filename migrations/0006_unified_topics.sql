-- 新频道采用“直接入库 + 可选 #话题”规则。
-- 只处理唯一媒体来源 -1004396154285；旧频道不受此迁移影响。
DELETE FROM review_items
WHERE status = 'pending'
  AND origin = 'ingest'
  AND media_id IN (
    SELECT media_id
    FROM channel_posts
    WHERE tg_chat_id = '-1004396154285'
  );

DELETE FROM media_category_candidates
WHERE media_id IN (
  SELECT media_id
  FROM channel_posts
  WHERE tg_chat_id = '-1004396154285'
);

UPDATE media
SET
  category_id = NULL,
  status = CASE
    WHEN status = 'pending' THEN 'approved'
    ELSE status
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT media_id
  FROM channel_posts
  WHERE tg_chat_id = '-1004396154285'
)
  AND status NOT IN ('rejected', 'disabled');
