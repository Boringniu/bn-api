-- This exact zero-video story was accidentally created from the /duplicates command
-- while an administrator was entering a new story title. It has no media relations.
-- Record the same delete_story audit shape as the normal Bot flow, then remove only
-- this exact story. No channel message, media record, media file, or other story is affected.
INSERT INTO story_series_admin_audit (
  id,
  operation,
  story_id,
  media_id,
  operator_tg_user_id,
  snapshot_json,
  created_at
)
SELECT
  'storyaudit_a08382da9f8342909f4c1724e6cb004f',
  'delete_story',
  ss.id,
  NULL,
  '7590811080',
  json_object(
    'story',
    json_object(
      'id', ss.id,
      'title', ss.title,
      'video_count', 0,
      'created_at', ss.created_at,
      'updated_at', ss.updated_at
    ),
    'media_ids', json_array()
  ),
  '2026-08-24T03:50:44.000Z'
FROM story_series ss
WHERE ss.id = 'story_c0a142339950422a8230e3706aa5a93a'
  AND ss.title = '/duplicates'
  AND NOT EXISTS (
    SELECT 1
    FROM story_series_media ssm
    WHERE ssm.story_id = ss.id
  );

DELETE FROM story_series
WHERE id = 'story_c0a142339950422a8230e3706aa5a93a'
  AND title = '/duplicates'
  AND NOT EXISTS (
    SELECT 1
    FROM story_series_media ssm
    WHERE ssm.story_id = story_series.id
  );
