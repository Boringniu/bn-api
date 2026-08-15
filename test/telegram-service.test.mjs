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
  channel_chat_id: "-1004396154285",
  channel_message_id: 88,
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

test("renders the channel template with actors and unified topics only", () => {
  const text = createService().renderChannelPost(sampleMedia);

  assert.equal(
    text,
    "🎬影视库索引\n\n👤演员\n#希岛爱理\n\n🏷话题\n#人妻 #剧情 #中文字幕",
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
  assert.ok(!text.includes("🏷话题"));
  assert.ok(!text.includes("📂分类"));
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

test("bot results render only a clickable code and actress hashtag", () => {
  const text = createService().renderBotResults({
    results: [{ ...sampleMedia, video_count: 3 }],
  });

  assert.equal(
    text,
    '1 • <a href="https://t.me/c/4396154285/88">#ABP-123</a>  #希岛爱理',
  );
  assert.ok(!text.includes("3 个视频"));
  assert.ok(!text.includes("人妻"));
  assert.ok(!text.includes("共 1 条结果"));
});

test("strips forwarded source by copying before deleting the original", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      calls.push({ method, payload: JSON.parse(init.body) });
      return {
        json: async () => ({
          ok: true,
          result: method === "copyMessage" ? { message_id: 88 } : true,
        }),
      };
    },
  });

  const copied = await service.stripForwardSource(
    { message_id: 77, forward_origin: { type: "channel" } },
    "-1004396154285",
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_STRIP_FORWARD_SOURCE: "true" },
  );

  assert.equal(copied.message_id, 88);
  assert.deepEqual(calls.map((call) => call.method), ["copyMessage", "deleteMessage"]);
  assert.equal(calls[0].payload.message_id, 77);
  assert.equal(calls[1].payload.message_id, 77);
});

test("rolls back the copy when deleting the forwarded original fails", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      const payload = JSON.parse(init.body);
      calls.push({ method, payload });
      if (method === "copyMessage") {
        return { json: async () => ({ ok: true, result: { message_id: 88 } }) };
      }
      if (method === "deleteMessage" && payload.message_id === 77) {
        return { json: async () => ({ ok: false, description: "not allowed" }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    },
  });

  await assert.rejects(
    () => service.stripForwardSource(
      { message_id: 77, forward_origin: { type: "channel" } },
      "-1004396154285",
      { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_STRIP_FORWARD_SOURCE: "true" },
    ),
    /deleteMessage failed/,
  );
  assert.deepEqual(calls.map((call) => call.method), [
    "copyMessage",
    "deleteMessage",
    "deleteMessage",
  ]);
  assert.equal(calls[2].payload.message_id, 88);
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

test("private bot accepts actress-directory searches", async () => {
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

  assert.equal(searchService.findCalls.length, 1);
  assert.deepEqual(searchService.findCalls[0].filters, { actor_id: "actor_000001" });
  assert.equal(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].body.text.includes("#ABP-123"));
  assert.equal(telegramCalls[0].body.parse_mode, "HTML");
  assert.equal(telegramCalls[0].body.disable_web_page_preview, true);
});

test("private media is never accepted as a submission", async () => {
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
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        caption: "ADN-001 #人妻",
        video: { file_id: "PRIVATE", file_name: "ADN-001.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_ADMIN_IDS: "111" },
  );

  assert.equal(result, null);
  assert.equal(telegramCalls.length, 0);
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

test("configures webhook to receive channel posts and channel edits", async () => {
  const telegramCalls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      const method = url.split("/").at(-1);
      const resultByMethod = {
        setWebhook: true,
        getWebhookInfo: {
          url: "https://bn-api.nnmmc326.workers.dev/",
          allowed_updates: ["message", "channel_post", "edited_channel_post"],
          pending_update_count: 0,
        },
        getMe: { id: 8101858846 },
        getChatMember: {
          status: "administrator",
          can_post_messages: true,
          can_edit_messages: false,
          can_delete_messages: true,
        },
      };
      return { json: async () => ({ ok: true, result: resultByMethod[method] }) };
    },
  });

  const result = await service.configureWebhook(
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TELEGRAM_CHANNEL_ID: "-1004460339207",
    },
    "https://bn-api.nnmmc326.workers.dev/",
  );

  assert.deepEqual(telegramCalls[0].body, {
    url: "https://bn-api.nnmmc326.workers.dev/",
    secret_token: "webhook-secret",
    allowed_updates: ["message", "channel_post", "edited_channel_post"],
  });
  assert.ok(telegramCalls[0].url.includes("/setWebhook"));
  assert.deepEqual(telegramCalls[1].body, {});
  assert.ok(telegramCalls[1].url.includes("/getWebhookInfo"));
  assert.deepEqual(telegramCalls[2].body, {});
  assert.ok(telegramCalls[2].url.includes("/getMe"));
  assert.deepEqual(telegramCalls[3].body, {
    chat_id: "-1004460339207",
    user_id: 8101858846,
  });
  assert.ok(telegramCalls[3].url.includes("/getChatMember"));
  assert.deepEqual(result.allowed_updates, ["message", "channel_post", "edited_channel_post"]);
  assert.deepEqual(result.channel_member, {
    status: "administrator",
    can_post_messages: true,
    can_edit_messages: false,
    can_delete_messages: true,
  });
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
  assert.ok(!sendCall.body.text.includes("📂分类"));
  assert.ok(sendCall.body.text.includes("#希岛爱理"));
  assert.ok(sendCall.body.text.includes("#人妻"));
  assert.ok(
    freshDb.statements.some((s) => s.sql.includes("INSERT INTO database_metadata")),
  );

  telegramCalls.length = 0;
  const editDb = new FakeD1({
    batchResults: [[], []],
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

test("private channel forwarded video is catalogued without reposting or deleting it", async () => {
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
      return { json: async () => ({ ok: true, result: { message_id: 101 } }) };
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
    },
  );

  assert.equal(result.ingested, "media_new");
  assert.equal(result.status, "approved");
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
  assert.deepEqual(ingestCalls[0].actors, ["希島あいり", "波多野結衣"]);
  assert.equal(ingestCalls[0].metadata.tg_file_id, "VIDFILE");
  assert.equal(ingestCalls[0].metadata.tg_message_id, "99");
  assert.ok(
    db.statements.some((s) => s.sql.includes("INSERT INTO media_files")),
  );
  assert.ok(
    db.statements.some((s) => s.sql.includes("INSERT INTO channel_posts")),
  );
  assert.ok(
    !telegramCalls.some((call) =>
      /\/(copyMessage|deleteMessage|editMessageCaption)$/u.test(call.url),
    ),
    "private-channel media must retain its original post and caption",
  );
  assert.ok(
    telegramCalls.some((call) => call.url.includes("/sendMessage")),
    "approved ingest should still maintain the pinned index",
  );
});

test("editing an indexed channel video synchronizes catalog metadata without reposting it", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const previousPayload = {
    source: { provider: "channel", external_id: "-1004460339207:100" },
    title: "OLD-001 #旧标签",
    raw_tags: ["旧标签"],
    actors: ["旧演员"],
    metadata: { tg_file_id: "FILE", tg_message_id: "100" },
  };
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_edit", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 55 } }) };
    },
  });
  const db = new FakeD1({
    firstResults: [
      { raw_payload_json: JSON.stringify(previousPayload) },
      null,
      null,
    ],
    batchResults: [[], [], []],
  });

  const result = await service.handleUpdate(
    db,
    {
      edited_channel_post: {
        chat: { id: -1004460339207 },
        message_id: 100,
        caption: "ADN-001 #中文字幕 #人妻 希島あいり\n\n更新后的两行说明\n排版保留",
        caption_entities: [{ offset: 0, length: 7, type: "bold" }],
        video: { file_id: "FILE", file_name: "ADN-001.mp4" },
      },
    },
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHANNEL_ID: "-1004460339207",
    },
  );

  assert.deepEqual(result, { synchronized: 100, ingested: "media_edit", status: "approved" });
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].source.external_id, "-1004460339207:100");
  assert.equal(ingestCalls[0].code, "ADN-001");
  assert.deepEqual(ingestCalls[0].actors, ["希島あいり"]);
  assert.ok(ingestCalls[0].raw_tags.includes("中文字幕"));
  assert.ok(ingestCalls[0].raw_tags.includes("人妻"));
  assert.equal(ingestCalls[0].description, "更新后的两行说明\n排版保留");
  assert.ok(
    !telegramCalls.some((call) =>
      /\/(copyMessage|deleteMessage|editMessageCaption)$/u.test(call.url),
    ),
    "native channel editing must not trigger a repost, deletion, or caption rewrite",
  );
});

test("editing an unmapped private-channel video imports it without reposting", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_backfill", status: "pending" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });

  const result = await service.handleUpdate(
    new FakeD1({ firstResults: [null] }),
    {
      edited_channel_post: {
        chat: { id: -1004460339207 },
        message_id: 999,
        caption: "ADN-999 #测试",
        video: { file_id: "OTHER", file_name: "ADN-999.mp4" },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.deepEqual(result, { ingested: "media_backfill", status: "pending" });
  assert.equal(ingestCalls[0].code, "ADN-999");
  assert.ok(ingestCalls[0].raw_tags.includes("测试"));
  assert.ok(
    !telegramCalls.some((call) =>
      /\/(copyMessage|deleteMessage|editMessageCaption)$/u.test(call.url),
    ),
    "first-edit import must leave the channel media untouched",
  );
});

test("direct private-channel media without a forward origin is catalogued", async () => {
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_direct", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
  });

  const result = await service.handleUpdate(
    new FakeD1(),
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 124,
        caption: "ADN-001",
        video: { file_id: "LOCAL", file_name: "ADN-001.mp4" },
      },
    },
    { TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.deepEqual(result, { ingested: "media_direct", status: "approved" });
  assert.equal(ingestCalls[0].code, "ADN-001");
  assert.deepEqual(ingestCalls[0].raw_tags, []);
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

test("inherits hashtags from a preceding channel context message", async () => {
  const ingestCalls = [];
  const context = {
    message_id: 500,
    code: "ADN-100",
    raw_tags: ["松下纱荣子"],
  };
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_context", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
  });
  const db = new FakeD1({
    firstResults: [null, { value: JSON.stringify(context) }, null, null],
  });

  await service.handleUpdate(
    db,
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 501,
        video: { file_id: "CONTEXT", file_name: "ADN-100-1.mp4" },
      },
    },
    { TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.equal(ingestCalls[0].code, "ADN-100");
  assert.deepEqual(ingestCalls[0].raw_tags, ["松下纱荣子"]);
});

test("preserves an actor-name hashtag as a topic and actress association", async () => {
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_topic", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub({
      resolution: {
        type: "actor",
        actor_id: "actor_000001",
        display_name: "松下纱荣子",
      },
    }),
    versionConfig,
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      channel_post: {
        chat: { id: -1004460339207 },
        message_id: 502,
        caption: "ADN-100 #松下纱荣子",
        video: { file_id: "TOPIC", file_name: "ADN-100.mp4" },
      },
    },
    { TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.deepEqual(ingestCalls[0].raw_tags, ["松下纱荣子"]);
  assert.deepEqual(ingestCalls[0].actors, ["松下纱荣子"]);
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
