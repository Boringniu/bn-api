import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramService } from "../src/telegram-service.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const displayConfig = configs.get("display").data;
const versionConfig = configs.get("version").data;

function createService({ searchService, fetchImpl } = {}) {
  return createTelegramService({
    displayConfig,
    searchConfig: configs.get("search").data,
    searchService: searchService ?? createSearchStub(),
    versionConfig,
    fetchImpl: fetchImpl ?? (async () => ({ json: async () => ({ ok: true, result: {} }) })),
  });
}

const sampleMedia = {
  id: "media_1",
  title: "raw title should never appear",
  code: "ABP-123",
  category: { category_id: "cat_japan", display_name: "日本" },
  actors: [{ actor_id: "actor_000001", display_name: "希岛爱理" }],
  tags: [
    { tag_id: "tag_wife", display_name: "人妻" },
    { tag_id: "tag_story", display_name: "剧情" },
    { tag_id: "tag_chinese_subtitle", display_name: "中文字幕" },
  ],
};

test("renders the channel template with only category, actors, and tags", () => {
  const text = createService().renderChannelPost(sampleMedia);

  assert.equal(
    text,
    "🎬影视库索引\n\n📂分类\n#日本\n\n👤演员\n#希岛爱理\n\n🏷类型\n#人妻 #剧情 #中文字幕",
  );
  assert.ok(!text.includes("ABP-123"), "code must not appear in channel");
  assert.ok(!text.includes("raw title"), "raw title must not appear");
});

test("hashtags apply replacement rules and skip invalid values", () => {
  const service = createService();
  const text = service.renderChannelPost({
    ...sampleMedia,
    tags: [
      { tag_id: "tag_x", display_name: "A-B/C.D" },
      { tag_id: "tag_y", display_name: "(全括号)" },
      { tag_id: "tag_z", display_name: "x".repeat(70) },
    ],
  });

  assert.ok(text.includes("#A_B_C_D"));
  assert.ok(text.includes("#全括号"));
  assert.ok(!text.includes("x".repeat(70)));
});

test("hides empty actor and tag blocks per config", () => {
  const text = createService().renderChannelPost({
    ...sampleMedia,
    actors: [],
    tags: [],
  });
  assert.ok(!text.includes("👤演员"));
  assert.ok(!text.includes("🏷类型"));
  assert.ok(text.includes("📂分类"));
});

test("caps channel actors and tags at configured maximums", () => {
  const actors = Array.from({ length: 9 }, (_, i) => ({
    actor_id: `actor_00000${i}`,
    display_name: `演员${i}`,
  }));
  const tags = Array.from({ length: 12 }, (_, i) => ({
    tag_id: `tag_${i}`,
    display_name: `标签${i}`,
  }));
  const text = createService().renderChannelPost({ ...sampleMedia, actors, tags });

  assert.equal((text.match(/#演员/gu) ?? []).length, 5);
  assert.equal((text.match(/#标签/gu) ?? []).length, 8);
});

test("bot results include code and hide source links from strangers", () => {
  const service = createService();
  const result = {
    query: "希岛爱理",
    page: 1,
    page_size: 10,
    total: 1,
    results: [{ ...sampleMedia, source_url: "https://example.com/secret" }],
  };

  const publicText = service.renderBotResults(result, { isAuthorized: false });
  assert.ok(publicText.includes("ABP-123"));
  assert.ok(publicText.includes("共 1 条结果"));
  assert.ok(!publicText.includes("https://example.com/secret"));

  const adminText = service.renderBotResults(result, { isAuthorized: true });
  assert.ok(adminText.includes("https://example.com/secret"));
});

test("webhook update runs a search, logs it, and replies", async () => {
  const searchService = createSearchStub({
    resolution: { type: "actor", match: "exact_alias", actor_id: "actor_000001" },
    media: [sampleMedia],
  });
  const telegramCalls = [];
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });
  const db = new FakeD1();

  await service.handleUpdate(
    db,
    {
      message: {
        chat: { id: 111 },
        from: { id: 8351469516 },
        text: "希岛爱理",
      },
    },
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_ADMIN_IDS: "8351469516",
    },
  );

  const logInsert = db.statements.find((s) => s.sql.includes("INSERT INTO search_logs"));
  assert.ok(logInsert);
  assert.equal(logInsert.values[0], "8351469516");
  assert.equal(logInsert.values[3], "actor");
  assert.equal(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].url.includes("/sendMessage"));
  assert.equal(telegramCalls[0].body.chat_id, 111);
});

test("publishToChannel creates then edits, tracking message ids", async () => {
  const telegramCalls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 42 } }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };

  const createDb = new FakeD1();
  const created = await service.publishToChannel(createDb, sampleMedia, env);
  assert.equal(created.outcome, "created");
  assert.equal(created.tg_message_id, 42);
  assert.ok(telegramCalls[0].url.includes("/sendMessage"));
  assert.ok(
    createDb.statements.some((s) => s.sql.includes("INSERT INTO channel_posts")),
  );

  const editDb = new FakeD1({ existing: { tg_message_id: 42 } });
  const edited = await service.publishToChannel(editDb, sampleMedia, env);
  assert.equal(edited.outcome, "edited");
  assert.ok(telegramCalls[1].url.includes("/editMessageText"));
});

function createSearchStub({ resolution = null, media = [] } = {}) {
  return {
    resolveQuery(query) {
      return { query, resolution };
    },
    async findMedia() {
      return { page: 1, page_size: 10, total: media.length, results: media };
    },
    async getMedia() {
      return media[0] ?? null;
    },
    async listCodePrefixes() {
      return [];
    },
  };
}

class FakeD1 {
  constructor({ existing = null } = {}) {
    this.existing = existing;
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
        return db.existing;
      },
      async run() {
        db.statements.push(this);
        return { success: true };
      },
    };
  }

  async batch(statements) {
    this.statements.push(...statements);
    return statements.map(() => ({ results: [] }));
  }
}
