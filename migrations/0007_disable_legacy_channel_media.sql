-- 旧频道 -1004460339207 已永久退出本项目。
-- 保留历史行以便审计，但禁止其媒体继续出现在任何 approved 搜索结果中。
UPDATE media
SET
  status = 'disabled',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT media_id
  FROM channel_posts
  WHERE tg_chat_id = '-1004460339207'
)
  AND status <> 'disabled';
