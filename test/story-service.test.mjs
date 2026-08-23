import assert from "node:assert/strict";
import test from "node:test";

import { createStoryService } from "../src/story-service.mjs";

const story = {
  id: "story_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  title: "频道转发剧情",
  video_count: 0,
  created_at: "2026-08-24T00:00:00.000Z",
  updated_at: "2026-08-24T00:00:00.000Z",
};
const media = {
  id: "media_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  code: "ADN-405",
};

function createSearchService() {
  return {
    calls: [],
    async getMedia(_db, mediaId, options) {
      this.calls.push({ mediaId, options });
      return mediaId === media.id ? media : null;
    },
  };
}

test("a pending video forwarded from the current channel can be selected for an active story", async () => {
  const searchService = createSearchService();
  const service = createStoryService({ searchService });
  const db = new StoryDb({ selectedCount: 1 });

  const result = await service.selectMediaForActiveStory(db, {
    userId: "222",
    mediaId: media.id,
  });

  assert.equal(result.outcome, "selected");
  assert.equal(result.selected_count, 1);
  assert.deepEqual(searchService.calls, [{
    mediaId: media.id,
    options: { includeChannelLinks: true, includePending: true },
  }]);
});

test("batch commit keeps selected pending channel videos instead of filtering them out", async () => {
  const searchService = createSearchService();
  const service = createStoryService({ searchService });
  const db = new StoryDb({ selectedMediaIds: [media.id], batchChanges: 1 });

  const result = await service.commitMediaSelection(db, { userId: "222" });

  assert.equal(result.outcome, "committed");
  assert.equal(result.added_count, 1);
  assert.equal(result.selected_count, 1);
  const selectedQuery = db.statements.find((statement) =>
    statement.sql.includes("WHERE sm.tg_user_id = ? AND m.status"),
  );
  assert.match(selectedQuery.sql, /m\.status IN \('approved', 'pending'\)/);
  assert.ok(db.statements.some((statement) =>
    statement.sql.includes("INSERT INTO story_series_media"),
  ));
});

class StoryDb {
  constructor({ selectedCount = 0, selectedMediaIds = [], batchChanges = 0 } = {}) {
    this.selectedCount = selectedCount;
    this.selectedMediaIds = selectedMediaIds;
    this.batchChanges = batchChanges;
    this.statements = [];
  }

  prepare(sql) {
    const db = this;
    return {
      sql,
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        db.statements.push(this);
        if (sql.includes("FROM story_series_sessions")) {
          return {
            tg_user_id: "222",
            story_id: story.id,
            mode: "awaiting_media_query",
            query: null,
            page: 1,
            updated_at: story.updated_at,
            selected_count: db.selectedCount,
          };
        }
        if (sql.includes("FROM story_series ss")) {
          return story;
        }
        if (sql.includes("COUNT(*) AS total FROM story_series_session_media")) {
          return { total: db.selectedCount };
        }
        return null;
      },
      async all() {
        db.statements.push(this);
        if (sql.includes("FROM story_series_session_media sm")) {
          return { results: db.selectedMediaIds.map((media_id) => ({ media_id })) };
        }
        return { results: [] };
      },
      async run() {
        db.statements.push(this);
        return { meta: { changes: 1 } };
      },
    };
  }

  async batch(statements) {
    this.statements.push(...statements);
    return statements.map(() => ({ meta: { changes: this.batchChanges } }));
  }
}
