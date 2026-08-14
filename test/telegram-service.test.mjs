import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramService, parseChannelTitle } from "../src/telegram-service.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const displayConfig = configs.get("display").data;
const versionConfig = configs.get("version").data;

function createService({ searchService, fetchImpl } = {}) {
  return createTelegramService({
    categoryConfig: configs.get("category").data,
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

test("parseChannelTitle handles the observed caption formats", () => {
  const tagged = parseChannelTitle(
    "JUR-552 #无码中字 #NTR #女教师 #人妻 #巨乳 橘メアリー\n\n橘メアリー穿着套装",
  );
  assert.equal(tagged.code, "JUR-552");
  assert.deepEqual(tagged.raw_tags, ["无码中字", "NTR", "女教师", "人妻", "巨乳"]);
  assert.deepEqual(tagged.actors, ["橘メアリー"]);
  assert.equal(tagged.description, "橘メアリー穿着套装");

  const nameList = parseChannelTitle("DASS-776 橘メアリー 流川莉央 波多野結衣");
  assert.equal(nameList.code, "DASS-776");
  assert.deepEqual(nameList.actors, ["橘メアリー", "流川莉央", "波多野結衣"]);

  const pipes = parseChannelTitle("DASS-651 #无码中字 #希島あいり｜大槻ひびき｜波多野結衣");
  assert.deepEqual(pipes.actors, ["大槻ひびき", "波多野結衣"]);
  assert.ok(pipes.raw_tags.includes("希島あいり"));

  const punctuated = parseChannelTitle("DASS-652 #姐姐, #体检， #波多野结衣");
  assert.deepEqual(punctuated.raw_tags, ["姐姐", "体检", "波多野结衣"]);

  const partSuffix = parseChannelTitle("ngod-347·1");
  assert.equal(partSuffix.code, "NGOD-347");
  assert.deepEqual(partSuffix.actors, []);

  // The noisy resender title still contains a genuine code — extracting it
  // is correct (the old importer wrongly grabbed "Pu229" here).
  assert.equal(
    parseChannelTitle("搜索T.me:Pu229每日更新GVH-766-UB_part1").code,
    "GVH-766",
  );

  for (const noise of ["Join_file_034356268", "2372", "5月1日(1)"]) {
    const parsed = parseChannelTitle(noise);
    assert.equal(parsed.code, null, noise);
  }
});

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
    resolution: { type: "code", match: "exact", code: "ABP-123" },
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
        chat: { id: 111, type: "private" },
        from: { id: 8351469516 },
        text: "ABP-123",
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
  assert.equal(logInsert.values[3], "code");
  assert.equal(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].url.includes("/sendMessage"));
  assert.equal(telegramCalls[0].body.chat_id, 111);
});

test("private bot rejects non-code searches without querying media", async () => {
  const telegramCalls = [];
  const searchService = createSearchStub({
    resolution: { type: "actor", match: "exact_alias", actor_id: "actor_000001" },
    media: [sampleMedia],
  });
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  const db = new FakeD1();

  await service.handleUpdate(
    db,
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "希岛爱理",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.equal(searchService.findCalls.length, 0);
  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].body.text, "请输入完整番号，例如 ABP-123。");
});

test("bot ignores group messages", async () => {
  const telegramCalls = [];
  const searchService = createSearchStub({
    resolution: { type: "code", code: "ABP-123" },
    media: [sampleMedia],
  });
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });

  const result = await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: -100, type: "group" },
        from: { id: 222 },
        text: "ABP-123",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.equal(result, null);
  assert.equal(searchService.findCalls.length, 0);
  assert.equal(telegramCalls.length, 0);
});

test("refreshPinnedIndex posts once, pins, then edits in place", async () => {
  const telegramCalls = [];
  const fetchImpl = async (url, init) => {
    telegramCalls.push({ url, body: JSON.parse(init.body) });
    return { json: async () => ({ ok: true, result: { message_id: 55 } }) };
  };
  const service = createService({ fetchImpl });
  const env = { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-100" };

  const freshDb = new FakeD1({
    batchResults: [
      [{ category_id: "cat_japan", media_count: 23 }],
      [{ display_name: "希岛爱理" }, { display_name: "波多野结衣" }],
      [{ display_name: "人妻", weight: 90 }],
    ],
    firstResults: [null, null],
  });
  const pinned = await service.refreshPinnedIndex(freshDb, env);
  assert.equal(pinned.outcome, "pinned");
  assert.equal(pinned.pages, 1);
  assert.deepEqual(pinned.message_ids, [55]);
  assert.ok(telegramCalls.some((c) => c.url.includes("/pinChatMessage")));
  const sendCall = telegramCalls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sendCall.body.text.includes("#日本 (23)"));
  assert.ok(sendCall.body.text.includes("#希岛爱理"));
  assert.ok(sendCall.body.text.includes("#人妻"));
  assert.ok(
    freshDb.statements.some((s) => s.sql.includes("INSERT INTO database_metadata")),
  );

  telegramCalls.length = 0;
  const editDb = new FakeD1({
    batchResults: [[], [], []],
    firstResults: [{ value: "[55]" }],
  });
  const edited = await service.refreshPinnedIndex(editDb, env);
  assert.equal(edited.outcome, "edited");
  assert.ok(telegramCalls[0].url.includes("/editMessageText"));
  assert.equal(telegramCalls[0].body.message_id, 55);
});

test("index paginates into multiple messages when tags overflow", async () => {
  const telegramCalls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return {
        json: async () => ({ ok: true, result: { message_id: 100 + telegramCalls.length } }),
      };
    },
  });
  const manyActors = Array.from({ length: 700 }, (_, i) => ({
    display_name: `虚构演员名字第${String(i).padStart(4, "0")}号`,
  }));
  const db = new FakeD1({
    batchResults: [
      [{ category_id: "cat_japan", media_count: 700 }],
      manyActors,
      [{ display_name: "人妻", weight: 90 }],
    ],
    firstResults: [null, null],
  });

  const result = await service.refreshPinnedIndex(db, {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHANNEL_ID: "-100",
  });

  assert.ok(result.pages > 1, `expected multiple pages, got ${result.pages}`);
  assert.equal(result.message_ids.length, result.pages);
  const sends = telegramCalls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, result.pages);
  for (const send of sends) {
    assert.ok(send.body.text.length <= 4096);
  }
  const pins = telegramCalls.filter((c) => c.url.includes("/pinChatMessage"));
  assert.equal(pins.length, 1, "only the first page is pinned");
  assert.ok(sends[1].body.text.includes("（续）"));
});

test("approved channel video refreshes the index automatically", async () => {
  const telegramCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest() {
        return {
          id: "media_new",
          status: "approved",
          category: { category_id: "cat_japan", display_name: "日本" },
          actors: [],
          tags: [],
        };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 5 } }) };
    },
  });
  const db = new FakeD1({
    batchResults: [[], [], []],
    firstResults: [null, null],
  });

  await service.handleUpdate(
    db,
    {
      channel_post: {
        chat: { id: -100 },
        message_id: 9,
        forward_origin: {
          type: "user",
          sender_user: { id: 8101858846, is_bot: true },
        },
        video: { file_id: "F", file_name: "ABP-123.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-100" },
  );

  assert.ok(
    telegramCalls.some((c) => c.url.includes("/pinChatMessage")),
    "index refresh should run after approved ingest",
  );
});

test("authorized forwarded channel video is republished, catalogued, then cleans up the original", async () => {
  const ingestCalls = [];
  const telegramCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(db, payload) {
        ingestCalls.push(payload);
        return {
          id: "media_new",
          status: "approved",
          category: { category_id: "cat_japan", display_name: "日本" },
          actors: [{ actor_id: "actor_000001", display_name: "希岛爱理" }],
          tags: [],
        };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      const method = url.split("/").at(-1);
      return {
        json: async () => ({
          ok: true,
          result: method === "copyMessage" ? { message_id: 100 } : { message_id: 101 },
        }),
      };
    },
  });
  const db = new FakeD1();

  const result = await service.handleUpdate(
    db,
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 99,
        forward_origin: {
          type: "user",
          sender_user: { id: 8101858846, is_bot: true },
        },
        caption:
          "ABP-123 #中文字幕 #人妻 希島あいり｜波多野結衣\n\n剧情简介\n第一行保留排版\n第二行保留排版",
        caption_entities: [{ offset: 0, length: 7, type: "bold" }],
        video: { file_id: "VIDFILE", file_name: "ABP-123.mp4" },
      },
    },
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "-1004460339207",
      TELEGRAM_CHANNEL_DEFAULT_TAGS: "日本",
    },
  );

  assert.equal(result.ingested, "media_new");
  assert.equal(result.republished_message_id, 100);
  assert.equal(result.original_deleted, true);
  assert.equal(ingestCalls[0].code, "ABP-123");
  assert.equal(ingestCalls[0].source.provider, "channel");
  assert.equal(
    ingestCalls[0].title,
    "ABP-123 #中文字幕 #人妻 希島あいり｜波多野結衣\n\n剧情简介\n第一行保留排版\n第二行保留排版",
  );
  assert.equal(
    ingestCalls[0].description,
    "剧情简介\n第一行保留排版\n第二行保留排版",
  );
  assert.ok(ingestCalls[0].raw_tags.includes("中文字幕"));
  assert.ok(ingestCalls[0].raw_tags.includes("人妻"));
  assert.ok(ingestCalls[0].raw_tags.includes("日本"), "default tag applied");
  assert.deepEqual(ingestCalls[0].actors, ["希島あいり", "波多野結衣"]);
  assert.equal(ingestCalls[0].metadata.tg_file_id, "VIDFILE");
  assert.equal(ingestCalls[0].metadata.tg_message_id, "100");
  assert.ok(
    db.statements.some((s) => s.sql.includes("INSERT INTO media_files")),
  );
  assert.ok(
    db.statements.some((s) => s.sql.includes("INSERT INTO channel_posts")),
  );
  const copyCall = telegramCalls.find((call) => call.url.includes("/copyMessage"));
  assert.ok(copyCall, "authorized forwarded media must be copied as a local channel message");
  assert.deepEqual(copyCall.body, {
    chat_id: "-1004460339207",
    from_chat_id: "-1004460339207",
    message_id: 99,
  });
  assert.ok(
    !Object.hasOwn(copyCall.body, "caption"),
    "server-side copy must preserve the original caption and entities instead of rewriting them",
  );
  assert.ok(
    telegramCalls.some((call) => call.url.includes("/deleteMessage")),
    "the original forwarded message must be cleaned up after ingest succeeds",
  );
  assert.ok(
    telegramCalls.some((call) => call.url.includes("/sendMessage")),
    "approved ingest should still maintain the pinned index",
  );
});

test("untrusted forwarded channel media is deleted without copying or cataloguing", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "should_not_exist", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: true }) };
    },
  });

  const result = await service.handleUpdate(
    new FakeD1(),
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 123,
        forward_origin: {
          type: "user",
          sender_user: { id: 123456789, is_bot: true },
        },
        video: { file_id: "UNTRUSTED", file_name: "bad.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.deepEqual(result, { rejected: "untrusted_forward", original_deleted: true });
  assert.equal(ingestCalls.length, 0);
  assert.equal(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].url.includes("/deleteMessage"));
  assert.equal(telegramCalls[0].body.message_id, 123);
});

test("local channel media without a forward origin is ignored to prevent a repost loop", async () => {
  const telegramCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: { async ingest() { throw new Error("must not ingest"); } },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });

  const result = await service.handleUpdate(
    new FakeD1(),
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 124,
        video: { file_id: "LOCAL", file_name: "local.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.equal(result, null);
  assert.equal(telegramCalls.length, 0);
});

test("authorized media remains available when original cleanup is denied", async () => {
  const telegramCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest() {
        return { id: "media_keep", status: "pending" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      const method = url.split("/").at(-1);
      return {
        json: async () =>
          method === "deleteMessage"
            ? { ok: false, description: "not enough rights" }
            : { ok: true, result: { message_id: 125 } },
      };
    },
  });

  const result = await service.handleUpdate(
    new FakeD1(),
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 126,
        forward_origin: {
          type: "user",
          sender_user: { id: 8101858846, is_bot: true },
        },
        video: { file_id: "KEEP", file_name: "keep.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.equal(result.ingested, "media_keep");
  assert.equal(result.original_deleted, false);
  assert.ok(telegramCalls.some((call) => call.url.includes("/copyMessage")));
  assert.ok(telegramCalls.some((call) => call.url.includes("/deleteMessage")));
});

test("channel posts from other chats and non-videos are ignored", async () => {
  const service = createService();
  const env = { TELEGRAM_CHANNEL_ID: "-1004460339207" };

  assert.equal(
    await service.handleUpdate(new FakeD1(), {
      channel_post: { chat: { id: -999 }, message_id: 1, video: { file_id: "x" } },
    }, env),
    null,
  );
  assert.equal(
    await service.handleUpdate(new FakeD1(), {
      channel_post: { chat: { id: -1004460339207 }, message_id: 2, text: "hello" },
    }, env),
    null,
  );
});

function createSearchStub({ resolution = null, media = [] } = {}) {
  return {
    findCalls: [],
    resolveQuery(query) {
      return { query, resolution };
    },
    async findMedia(db, options) {
      this.findCalls.push(options);
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
  constructor({
    existing = null,
    firstResults = null,
    batchResults = null,
    allResults = null,
  } = {}) {
    this.existing = existing;
    this.firstResults = firstResults;
    this.batchResults = batchResults;
    this.allResults = allResults;
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
        if (db.firstResults) {
          return db.firstResults.shift() ?? null;
        }
        return db.existing;
      },
      async run() {
        db.statements.push(this);
        return { success: true };
      },
      async all() {
        db.statements.push(this);
        if (db.allResults) {
          return { results: db.allResults.shift() ?? [] };
        }
        return { results: [] };
      },
    };
  }

  async batch(statements) {
    this.statements.push(...statements);
    if (this.batchResults) {
      return statements.map((_, i) => ({ results: this.batchResults[i] ?? [] }));
    }
    return statements.map(() => ({ results: [] }));
  }
}
