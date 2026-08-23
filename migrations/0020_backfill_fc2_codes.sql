-- The two rows below were verified from their saved channel titles and raw payloads.
-- This migration only supplies normalized_code; it does not modify channel messages,
-- media files, descriptions, tags, review records, or story relations.
UPDATE media
SET normalized_code = CASE id
  WHEN 'media_cac64723be8c4f7afaf0707be0e41f6d' THEN 'FC2-1297737'
  WHEN 'media_d30b76c6de19fef2506c4ce4b6e8a1ae' THEN 'FC2-3206621'
END,
updated_at = '2026-08-24T00:00:00.000Z'
WHERE status = 'approved'
  AND normalized_code IS NULL
  AND id IN (
    'media_cac64723be8c4f7afaf0707be0e41f6d',
    'media_d30b76c6de19fef2506c4ce4b6e8a1ae'
  );
