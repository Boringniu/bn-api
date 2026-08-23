import { normalizeValue } from "./value-normalizer.mjs";

const APPROVED_STATUS = "approved";

export function createStoryService({ searchService }) {
  if (!searchService || typeof searchService.getMedia !== "function") {
    throw new TypeError("searchService.getMedia is required");
  }

  return Object.freeze({
    async listStories(db, { page = 1, pageSize = 10 } = {}) {
      assertDatabase(db);
      const currentPage = normalizePage(page);
      const size = normalizePageSize(pageSize);
      const offset = (currentPage - 1) * size;
      const [listResult, countResult] = await db.batch([
        db.prepare(
          `SELECT
             ss.id,
             ss.title,
             ss.created_at,
             ss.updated_at,
             COUNT(ssm.media_id) AS video_count
           FROM story_series ss
           LEFT JOIN story_series_media ssm ON ssm.story_id = ss.id
           GROUP BY ss.id
           ORDER BY ss.updated_at DESC, ss.id
           LIMIT ? OFFSET ?`,
        ).bind(size, offset),
        db.prepare("SELECT COUNT(*) AS total FROM story_series"),
      ]);
      return {
        page: currentPage,
        page_size: size,
        total: Number(countResult.results?.[0]?.total ?? 0),
        results: (listResult.results ?? []).map(formatStory),
      };
    },

    async getStory(db, storyId) {
      assertDatabase(db);
      if (!isStoryId(storyId)) {
        return null;
      }
      const row = await db
        .prepare(
          `SELECT
             ss.id,
             ss.title,
             ss.created_at,
             ss.updated_at,
             COUNT(ssm.media_id) AS video_count
           FROM story_series ss
           LEFT JOIN story_series_media ssm ON ssm.story_id = ss.id
           WHERE ss.id = ?
           GROUP BY ss.id`,
        )
        .bind(storyId)
        .first();
      return row ? formatStory(row) : null;
    },

    async createStory(db, { title, createdByUserId }) {
      assertDatabase(db);
      const parsed = parseTitle(title);
      const userId = normalizeUserId(createdByUserId);
      const existing = await db
        .prepare(
          "SELECT id, title FROM story_series WHERE normalized_title = ? LIMIT 1",
        )
        .bind(parsed.normalizedTitle)
        .first();
      if (existing) {
        return { story: await this.getStory(db, existing.id), created: false };
      }

      const now = new Date().toISOString();
      const storyId = newStoryId();
      try {
        await db
          .prepare(
            `INSERT INTO story_series (
               id, title, normalized_title, created_by_tg_user_id, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(storyId, parsed.title, parsed.normalizedTitle, userId, now, now)
          .run();
      } catch (error) {
        const concurrent = await db
          .prepare("SELECT id FROM story_series WHERE normalized_title = ? LIMIT 1")
          .bind(parsed.normalizedTitle)
          .first();
        if (!concurrent) {
          throw error;
        }
        return { story: await this.getStory(db, concurrent.id), created: false };
      }
      return { story: await this.getStory(db, storyId), created: true };
    },

    async findStoryMedia(db, { storyId, page = 1, pageSize = 10 } = {}) {
      assertDatabase(db);
      if (!isStoryId(storyId)) {
        return emptyPage(page, pageSize);
      }
      const currentPage = normalizePage(page);
      const size = normalizePageSize(pageSize);
      const offset = (currentPage - 1) * size;
      const [listResult, countResult] = await db.batch([
        db.prepare(
          `SELECT ssm.media_id
           FROM story_series_media ssm
           JOIN media m ON m.id = ssm.media_id
           WHERE ssm.story_id = ? AND m.status = ?
           ORDER BY ssm.added_at DESC, ssm.media_id
           LIMIT ? OFFSET ?`,
        ).bind(storyId, APPROVED_STATUS, size, offset),
        db.prepare(
          `SELECT COUNT(*) AS total
           FROM story_series_media ssm
           JOIN media m ON m.id = ssm.media_id
           WHERE ssm.story_id = ? AND m.status = ?`,
        ).bind(storyId, APPROVED_STATUS),
      ]);
      const ids = (listResult.results ?? []).map((row) => row.media_id);
      const loaded = await Promise.all(
        ids.map((mediaId) => searchService.getMedia(db, mediaId, { includeChannelLinks: true })),
      );
      return {
        page: currentPage,
        page_size: size,
        total: Number(countResult.results?.[0]?.total ?? 0),
        results: loaded.filter(Boolean),
      };
    },

    async startTitleEntry(db, userId) {
      return writeSession(db, {
        userId,
        storyId: null,
        mode: "awaiting_title",
        query: null,
        page: 1,
      });
    },

    async startMediaSelection(db, { userId, storyId }) {
      const story = await this.getStory(db, storyId);
      if (!story) {
        return null;
      }
      await writeSession(db, {
        userId,
        storyId,
        mode: "awaiting_media_query",
        query: null,
        page: 1,
      });
      await clearSelectedMedia(db, userId);
      return story;
    },

    async getSession(db, userId) {
      assertDatabase(db);
      const row = await db
        .prepare(
          `SELECT
             sss.tg_user_id,
             sss.story_id,
             sss.mode,
             sss.query,
             sss.page,
             sss.updated_at,
             (SELECT COUNT(*) FROM story_series_session_media sm
                WHERE sm.tg_user_id = sss.tg_user_id) AS selected_count
           FROM story_series_sessions sss
           WHERE sss.tg_user_id = ?`,
        )
        .bind(normalizeUserId(userId))
        .first();
      return row ? formatSession(row) : null;
    },

    async setMediaQuery(db, { userId, query, page = 1 }) {
      const session = await this.getSession(db, userId);
      if (!session || session.mode !== "awaiting_media_query") {
        return null;
      }
      const nextQuery = typeof query === "string" ? query.trim() : "";
      if (!nextQuery) {
        return null;
      }
      await writeSession(db, {
        userId,
        storyId: session.story_id,
        mode: session.mode,
        query: nextQuery,
        page,
      });
      return { ...session, query: nextQuery, page: normalizePage(page) };
    },

    async selectMediaForActiveStory(db, { userId, mediaId }) {
      const session = await this.getSession(db, userId);
      if (!session || session.mode !== "awaiting_media_query" || !isMediaId(mediaId)) {
        return { outcome: "no_active_story", selected_count: 0 };
      }
      const media = await searchService.getMedia(db, mediaId, { includeChannelLinks: true });
      if (!media) {
        return { outcome: "media_not_found", selected_count: session.selected_count };
      }
      const inserted = await db
        .prepare(
          `INSERT INTO story_series_session_media (tg_user_id, media_id, selected_at)
           VALUES (?, ?, ?)
           ON CONFLICT (tg_user_id, media_id) DO NOTHING`,
        )
        .bind(normalizeUserId(userId), media.id, new Date().toISOString())
        .run();
      const changes = inserted?.meta?.changes ?? inserted?.changes ?? 0;
      return {
        outcome: changes > 0 ? "selected" : "already_selected",
        media,
        selected_count: await countSelectedMedia(db, userId),
      };
    },

    async toggleMediaSelection(db, { userId, mediaId }) {
      const session = await this.getSession(db, userId);
      if (!session || session.mode !== "awaiting_media_query" || !isMediaId(mediaId)) {
        return { outcome: "no_active_story", selected_count: 0 };
      }
      const media = await searchService.getMedia(db, mediaId, { includeChannelLinks: true });
      if (!media) {
        return { outcome: "media_not_found", selected_count: session.selected_count };
      }
      const now = new Date().toISOString();
      const inserted = await db
        .prepare(
          `INSERT INTO story_series_session_media (tg_user_id, media_id, selected_at)
           VALUES (?, ?, ?)
           ON CONFLICT (tg_user_id, media_id) DO NOTHING`,
        )
        .bind(normalizeUserId(userId), media.id, now)
        .run();
      const changes = inserted?.meta?.changes ?? inserted?.changes ?? 0;
      if (changes === 0) {
        await db
          .prepare(
            "DELETE FROM story_series_session_media WHERE tg_user_id = ? AND media_id = ?",
          )
          .bind(normalizeUserId(userId), media.id)
          .run();
      }
      return {
        outcome: changes > 0 ? "selected" : "deselected",
        media,
        selected_count: await countSelectedMedia(db, userId),
      };
    },

    async listSelectedMediaIds(db, userId) {
      assertDatabase(db);
      const result = await db
        .prepare(
          "SELECT media_id FROM story_series_session_media WHERE tg_user_id = ? ORDER BY selected_at, media_id",
        )
        .bind(normalizeUserId(userId))
        .all();
      return (result.results ?? []).map((row) => row.media_id).filter(isMediaId);
    },

    async commitMediaSelection(db, { userId }) {
      const session = await this.getSession(db, userId);
      if (!session || session.mode !== "awaiting_media_query") {
        return { outcome: "no_active_story", added_count: 0, selected_count: 0 };
      }
      const story = await this.getStory(db, session.story_id);
      if (!story) {
        return { outcome: "story_not_found", added_count: 0, selected_count: session.selected_count };
      }
      const selected = await db
        .prepare(
          `SELECT sm.media_id
           FROM story_series_session_media sm
           JOIN media m ON m.id = sm.media_id
           WHERE sm.tg_user_id = ? AND m.status = ?
           ORDER BY sm.selected_at, sm.media_id`,
        )
        .bind(normalizeUserId(userId), APPROVED_STATUS)
        .all();
      const mediaIds = (selected.results ?? []).map((row) => row.media_id);
      if (mediaIds.length === 0) {
        return { outcome: "no_selection", added_count: 0, selected_count: 0, story };
      }
      const now = new Date().toISOString();
      const writes = mediaIds.map((mediaId) => db
        .prepare(
          `INSERT INTO story_series_media (story_id, media_id, added_by_tg_user_id, added_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (story_id, media_id) DO NOTHING`,
        )
        .bind(story.id, mediaId, normalizeUserId(userId), now));
      const inserted = await db.batch(writes);
      const addedCount = inserted.reduce(
        (total, result) => total + Number(result?.meta?.changes ?? result?.changes ?? 0),
        0,
      );
      if (addedCount > 0) {
        await db
          .prepare("UPDATE story_series SET updated_at = ? WHERE id = ?")
          .bind(now, story.id)
          .run();
      }
      await clearSelectedMedia(db, userId);
      return {
        outcome: "committed",
        added_count: addedCount,
        selected_count: mediaIds.length,
        story: await this.getStory(db, story.id),
      };
    },

    async startMediaRemoval(db, { userId, storyId }) {
      const story = await this.getStory(db, storyId);
      if (!story) {
        return null;
      }
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO story_series_removal_sessions (tg_user_id, story_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (tg_user_id) DO UPDATE SET
             story_id = excluded.story_id,
             created_at = excluded.created_at`,
        )
        .bind(normalizeUserId(userId), story.id, now)
        .run();
      return story;
    },

    async getMediaRemovalSession(db, userId) {
      assertDatabase(db);
      const row = await db
        .prepare(
          "SELECT tg_user_id, story_id, created_at FROM story_series_removal_sessions WHERE tg_user_id = ?",
        )
        .bind(normalizeUserId(userId))
        .first();
      return row ?? null;
    },

    async clearMediaRemovalSession(db, userId) {
      assertDatabase(db);
      await db
        .prepare("DELETE FROM story_series_removal_sessions WHERE tg_user_id = ?")
        .bind(normalizeUserId(userId))
        .run();
    },

    async deleteStory(db, { userId, storyId }) {
      const story = await this.getStory(db, storyId);
      if (!story) {
        return { outcome: "story_not_found" };
      }
      const linked = await db
        .prepare("SELECT media_id FROM story_series_media WHERE story_id = ? ORDER BY added_at, media_id")
        .bind(story.id)
        .all();
      await writeStoryAudit(db, {
        operation: "delete_story",
        storyId: story.id,
        mediaId: null,
        userId,
        snapshot: { story, media_ids: (linked.results ?? []).map((row) => row.media_id) },
      });
      await db.prepare("DELETE FROM story_series WHERE id = ?").bind(story.id).run();
      return {
        outcome: "deleted_story",
        story,
        removed_media_count: (linked.results ?? []).length,
      };
    },

    async removeMediaFromStory(db, { userId, storyId, mediaId }) {
      if (!isStoryId(storyId) || !isMediaId(mediaId)) {
        return { outcome: "story_media_not_found" };
      }
      const story = await this.getStory(db, storyId);
      if (!story) {
        return { outcome: "story_not_found" };
      }
      const relation = await db
        .prepare(
          "SELECT added_at, added_by_tg_user_id FROM story_series_media WHERE story_id = ? AND media_id = ?",
        )
        .bind(story.id, mediaId)
        .first();
      if (!relation) {
        return { outcome: "story_media_not_found" };
      }
      const media = await searchService.getMedia(db, mediaId, { includeChannelLinks: true });
      const now = new Date().toISOString();
      await writeStoryAudit(db, {
        operation: "remove_story_media",
        storyId: story.id,
        mediaId,
        userId,
        snapshot: { story, media, relation },
      });
      await db
        .prepare("DELETE FROM story_series_media WHERE story_id = ? AND media_id = ?")
        .bind(story.id, mediaId)
        .run();
      await db
        .prepare("UPDATE story_series SET updated_at = ? WHERE id = ?")
        .bind(now, story.id)
        .run();
      return {
        outcome: "removed_story_media",
        story: await this.getStory(db, story.id),
        media,
      };
    },

    async clearSession(db, userId) {
      assertDatabase(db);
      await db
        .prepare("DELETE FROM story_series_sessions WHERE tg_user_id = ?")
        .bind(normalizeUserId(userId))
        .run();
    },
  });
}

function formatStory(row) {
  return {
    id: row.id,
    title: row.title,
    video_count: Number(row.video_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatSession(row) {
  return {
    tg_user_id: row.tg_user_id,
    story_id: row.story_id,
    mode: row.mode,
    query: row.query,
    page: normalizePage(Number(row.page)),
    selected_count: Number(row.selected_count ?? 0),
    updated_at: row.updated_at,
  };
}

function parseTitle(value) {
  const title = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!title || title.length > 300) {
    throw new TypeError("剧情名称长度须为 1 至 300 个字符");
  }
  const normalizedTitle = normalizeValue(title);
  if (!normalizedTitle) {
    throw new TypeError("剧情名称不能为空");
  }
  return { title, normalizedTitle };
}

function normalizeUserId(value) {
  const userId = String(value ?? "").trim();
  if (!userId) {
    throw new TypeError("Telegram 用户 ID 不能为空");
  }
  return userId;
}

function newStoryId() {
  return `story_${crypto.randomUUID().replaceAll("-", "")}`;
}

function newStoryAuditId() {
  return `story_audit_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isStoryId(value) {
  return /^story_[a-f0-9]{32}$/iu.test(value ?? "");
}

function isMediaId(value) {
  return /^media_[a-f0-9]{32}$/iu.test(value ?? "");
}

function normalizePage(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizePageSize(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : 10;
}

function emptyPage(page, pageSize) {
  return { page: normalizePage(page), page_size: normalizePageSize(pageSize), total: 0, results: [] };
}

async function countSelectedMedia(db, userId) {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM story_series_session_media WHERE tg_user_id = ?")
    .bind(normalizeUserId(userId))
    .first();
  return Number(row?.total ?? 0);
}

async function clearSelectedMedia(db, userId) {
  await db
    .prepare("DELETE FROM story_series_session_media WHERE tg_user_id = ?")
    .bind(normalizeUserId(userId))
    .run();
}

async function writeStoryAudit(db, {
  operation,
  storyId,
  mediaId,
  userId,
  snapshot,
}) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO story_series_admin_audit (
         id, operation, story_id, media_id, operator_tg_user_id, snapshot_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newStoryAuditId(),
      operation,
      storyId,
      mediaId,
      normalizeUserId(userId),
      JSON.stringify(snapshot),
      now,
    )
    .run();
}

async function writeSession(db, { userId, storyId, mode, query, page }) {
  assertDatabase(db);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO story_series_sessions (tg_user_id, story_id, mode, query, page, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tg_user_id) DO UPDATE SET
         story_id = excluded.story_id,
         mode = excluded.mode,
         query = excluded.query,
         page = excluded.page,
         updated_at = excluded.updated_at`,
    )
    .bind(normalizeUserId(userId), storyId, mode, query, normalizePage(page), now)
    .run();
}

function assertDatabase(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("D1 database binding is required");
  }
}
