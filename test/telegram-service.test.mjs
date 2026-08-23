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
    "影视库索引\n\n👤演员\n#希岛爱理\n\n🏷话题\n#人妻 #剧情 #中文字幕",
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

test("bot results render a clickable code and every native hashtag", () => {
  const text = createService().renderBotResults({
    results: [{ ...sampleMedia, raw_tags: ["人妻", "剧情", "中文字幕"], video_count: 3 }],
  });

  assert.equal(
    text,
    '1 • <a href="https://t.me/c/4396154285/88">#ABP-123</a>  <a href="https://t.me/c/4396154285/88">#人妻</a>  <a href="https://t.me/c/4396154285/88">#剧情</a>  <a href="https://t.me/c/4396154285/88">#中文字幕</a>',
  );
  assert.ok(!text.includes("3 个视频"));
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

test("strips a forwarded media group in one copy to preserve album layout", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      calls.push({ method, payload: JSON.parse(init.body) });
      const result = method === "copyMessages"
        ? [{ message_id: 90 }, { message_id: 91 }]
        : true;
      return { json: async () => ({ ok: true, result }) };
    },
  });

  const copied = await service.stripForwardMediaGroup(
    [{ message_id: 70 }, { message_id: 71 }],
    "-1004396154285",
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.deepEqual(copied, [90, 91]);
  assert.deepEqual(calls.map((call) => call.method), [
    "copyMessages",
    "deleteMessage",
    "deleteMessage",
  ]);
  assert.deepEqual(calls[0].payload, {
    chat_id: "-1004396154285",
    from_chat_id: "-1004396154285",
    message_ids: [70, 71],
  });
  assert.ok(!Object.hasOwn(calls[0].payload, "caption"));
  assert.equal(calls[1].payload.message_id, 70);
  assert.equal(calls[2].payload.message_id, 71);
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

  assert.equal(searchService.findCalls.length, 2);
  assert.deepEqual(searchService.findCalls[0].filters, { raw_tag: "希岛爱理" });
  assert.deepEqual(searchService.findCalls[1].filters, { actor_id: "actor_000001" });
  assert.equal(telegramCalls.length, 1);
  assert.ok(telegramCalls[0].body.text.includes("#ABP-123"));
  assert.equal(telegramCalls[0].body.parse_mode, "HTML");
  assert.equal(telegramCalls[0].body.disable_web_page_preview, true);
});

test("private bot searches any native hashtag and returns a fully linked resource entry", async () => {
  const telegramCalls = [];
  const nativeMedia = { ...sampleMedia, raw_tags: ["希岛爱理", "剧情", "人妻"] };
  const searchService = createSearchStub({
    rawTagMedia: [nativeMedia],
  });
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "#剧情",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.deepEqual(searchService.findCalls[0].filters, { raw_tag: "剧情" });
  const resultText = telegramCalls[0].body.text;
  for (const label of ["#ABP-123", "#希岛爱理", "#剧情", "#人妻"]) {
    assert.ok(resultText.includes(`>${label}</a>`), label);
  }
  assert.equal((resultText.match(/https:\/\/t\.me\/c\/4396154285\/88/gu) ?? []).length, 4);
});

test("plain native name takes precedence over a conflicting actor dictionary match", async () => {
  const telegramCalls = [];
  const nativeMedia = {
    ...sampleMedia,
    code: "JUC-048",
    raw_tags: ["爱弓凉", "不伦", "合集1"],
  };
  const searchService = createSearchStub({
    resolution: {
      type: "actor",
      actor_id: "actor_wrong_match",
      display_name: "本乡爱",
    },
    media: [{ ...sampleMedia, code: "STARS-676" }],
    rawTagMedia: [nativeMedia],
  });
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "爱弓凉",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.deepEqual(searchService.findCalls, [
    {
      filters: { raw_tag: "爱弓凉" },
      page: 1,
      pageSize: 10,
      includeChannelLinks: true,
    },
  ]);
  assert.ok(telegramCalls[0].body.text.includes("#JUC-048"));
  assert.ok(!telegramCalls[0].body.text.includes("#STARS-676"));
});

test("index command links to the first pinned channel index message", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  const db = new FakeD1({ firstResults: [{ value: "[4]" }] });

  await service.handleUpdate(
    db,
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "/index",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHANNEL_ID: "-1004396154285" },
  );

  assert.equal(calls[0].method, "sendMessage");
  assert.equal(
    calls[0].body.text,
    '📚 <a href="https://t.me/c/4396154285/4">跳转频道索引</a>',
  );
});

test("about command explains the direct query workflow", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "/about",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.equal(calls[0].method, "sendMessage");
  assert.ok(calls[0].body.text.includes("BN·media"));
  assert.ok(calls[0].body.text.includes("ADN-100、ADN、白雪、#剧情"));
  assert.ok(calls[0].body.text.includes("/stats - 查看收录统计"));
});

test("stats command shows public catalog totals and admin quality metrics", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  const publicDb = new FakeD1({
    batchResults: [
      [
        {
          media_count: 65,
          code_count: 58,
          latest_updated_at: "2026-08-23T03:51:38.744Z",
        },
      ],
      [{ file_count: 61 }],
    ],
  });
  await service.handleUpdate(
    publicDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 222 }, text: "/stats" } },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );
  assert.ok(calls[0].body.text.includes("已审核媒体：65 条"));
  assert.ok(calls[0].body.text.includes("不同编号：58 个"));
  assert.ok(calls[0].body.text.includes("不同文件：61 个"));
  assert.ok(!calls[0].body.text.includes("管理员数据质量"));

  const adminDb = new FakeD1({
    batchResults: [
      [
        {
          media_count: 65,
          code_count: 58,
          latest_updated_at: "2026-08-23T03:51:38.744Z",
        },
      ],
      [{ file_count: 61 }],
      [{ pending_review_count: 0 }],
      [{ duplicate_file_group_count: 4, duplicate_media_count: 8 }],
    ],
  });
  await service.handleUpdate(
    adminDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/stats" } },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_ADMIN_IDS: "2002" },
  );
  assert.ok(calls[1].body.text.includes("管理员数据质量"));
  assert.ok(calls[1].body.text.includes("待审核：0 条"));
  assert.ok(calls[1].body.text.includes("重复候选：4 组 / 8 条"));
});

test("duplicates command is admin-only and only renders review candidates", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  await service.handleUpdate(
    new FakeD1(),
    { message: { chat: { id: 111, type: "private" }, from: { id: 222 }, text: "/duplicates" } },
    { TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_ADMIN_IDS: "2002" },
  );
  assert.equal(calls[0].body.text, "权限不足");

  const adminDb = new FakeD1({
    allResults: [
      [
        {
          media_id: "media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          tg_file_unique_id: "same-file",
          normalized_code: "ADN-100",
          title: "候选标题 A",
          tg_chat_id: "-1004460339207",
          tg_message_id: 17,
        },
        {
          media_id: "media_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          tg_file_unique_id: "same-file",
          normalized_code: "ADN-100",
          title: "候选标题 B",
          tg_chat_id: "-1009988776655",
          tg_message_id: 18,
        },
      ],
    ],
  });
  await service.handleUpdate(
    adminDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/duplicates" } },
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_ADMIN_IDS: "2002",
      TELEGRAM_CHANNEL_ID: "-1004460339207",
    },
  );
  assert.ok(calls[1].body.text.includes("重复候选"));
  assert.ok(calls[1].body.text.includes("未执行合并或删除"));
  assert.ok(calls[1].body.text.includes("https://t.me/c/4460339207/17"));
  assert.ok(calls[1].body.text.includes("候选标题 A"));
  assert.ok(calls[1].body.text.includes("当前频道：删除消息与目录"));
  assert.ok(calls[1].body.text.includes("旧频道遗留：仅删除目录"));
  assert.ok(calls[1].body.text.includes("/delete media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa CONFIRM"));
  assert.deepEqual(calls[1].body.reply_markup, {
    inline_keyboard: [
      [{ text: "删除 #ADN-100", callback_data: "dupdel:d:media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      [{ text: "删除 #ADN-100", callback_data: "dupdel:d:media_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    ],
  });
  assert.equal(
    adminDb.statements.filter((statement) => /^(INSERT|UPDATE|DELETE)/iu.test(statement.sql.trim())).length,
    0,
  );
});

test("delete command requires explicit confirmation and preserves records when Telegram deletion fails", async () => {
  const calls = [];
  const candidate = {
    media_id: "media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    normalized_code: "ADN-100",
    title: "候选标题",
    updated_at: "2026-08-23T00:00:00Z",
    tg_chat_id: "-1004460339207",
    tg_message_id: 17,
    tg_file_unique_id: "same-file",
  };
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      const response = method === "deleteMessage"
        ? { ok: true, result: true }
        : { ok: true, result: { message_id: 1 } };
      return { json: async () => response };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "2002",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };

  await service.handleUpdate(
    new FakeD1(),
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/delete media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    env,
  );
  assert.ok(calls[0].body.text.includes("CONFIRM"));

  const deleteDb = new FakeD1({ firstResults: [candidate] });
  await service.handleUpdate(
    deleteDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/delete media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa CONFIRM" } },
    env,
  );
  assert.equal(calls.at(-2).method, "deleteMessage");
  assert.deepEqual(calls.at(-2).body, { chat_id: "-1004460339207", message_id: 17 });
  assert.ok(calls.at(-1).body.text.includes("已删除 #ADN-100"));
  assert.ok(deleteDb.statements.some((statement) => statement.sql.includes("INSERT INTO duplicate_deletion_audit")));
  assert.ok(deleteDb.statements.some((statement) => statement.sql === "DELETE FROM media WHERE id = ?"));

  const failedCalls = [];
  const failingService = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      failedCalls.push({ method, body: JSON.parse(init.body) });
      const response = method === "deleteMessage"
        ? { ok: false, description: "message can't be deleted" }
        : { ok: true, result: { message_id: 1 } };
      return { json: async () => response };
    },
  });
  const failedDb = new FakeD1({ firstResults: [candidate] });
  await failingService.handleUpdate(
    failedDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/delete media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa CONFIRM" } },
    env,
  );
  assert.ok(failedCalls.at(-1).body.text.includes("索引记录已保留"));
  assert.ok(failedDb.statements.some((statement) => statement.sql.includes("telegram_delete_failed")));
  assert.ok(!failedDb.statements.some((statement) => statement.sql === "DELETE FROM media WHERE id = ?"));

  const legacyCalls = [];
  const legacyService = createService({
    fetchImpl: async (url, init) => {
      legacyCalls.push({
        method: url.split("/").at(-1),
        body: JSON.parse(init.body),
      });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  const legacyCandidate = {
    ...candidate,
    media_id: "media_cccccccccccccccccccccccccccccccc",
    tg_chat_id: "-1009988776655",
    tg_message_id: 99,
  };
  const legacyDb = new FakeD1({ firstResults: [legacyCandidate] });
  await legacyService.handleUpdate(
    legacyDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 2002 }, text: "/delete media_cccccccccccccccccccccccccccccccc CONFIRM" } },
    env,
  );
  assert.ok(!legacyCalls.some((call) => call.method === "deleteMessage"));
  assert.ok(legacyCalls.at(-1).body.text.includes("旧频道遗留目录记录"));
  assert.ok(legacyDb.statements.some((statement) => statement.sql === "DELETE FROM media WHERE id = ?"));
  assert.ok(legacyDb.statements.some((statement) => statement.sql.includes("legacy_catalog_only")));
});

test("duplicate deletion buttons require an explicit second confirmation", async () => {
  const calls = [];
  const candidate = {
    media_id: "media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    normalized_code: "ADN-100",
    title: "候选标题",
    updated_at: "2026-08-23T00:00:00Z",
    tg_chat_id: "-1004460339207",
    tg_message_id: 17,
    tg_file_unique_id: "same-file",
  };
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      calls.push({ method, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 91 } }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "2002",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };
  const candidateDb = new FakeD1({ firstResults: [candidate] });
  const baseCallback = {
    from: { id: 2002 },
    message: { message_id: 90, chat: { id: 111, type: "private" } },
  };

  await service.handleUpdate(
    candidateDb,
    {
      callback_query: {
        ...baseCallback,
        id: "duplicate-delete-1",
        data: "dupdel:d:media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    env,
  );
  assert.deepEqual(calls.map((call) => call.method), ["answerCallbackQuery", "sendMessage"]);
  assert.match(calls[1].body.text, /确认删除 #ADN-100/);
  assert.deepEqual(calls[1].body.reply_markup, {
    inline_keyboard: [[
      { text: "确认删除此条", callback_data: "dupdel:c:media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { text: "取消", callback_data: "dupdel:x:media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ]],
  });
  assert.ok(!candidateDb.statements.some((statement) => statement.sql === "DELETE FROM media WHERE id = ?"));

  const confirmDb = new FakeD1({ firstResults: [candidate] });
  await service.handleUpdate(
    confirmDb,
    {
      callback_query: {
        ...baseCallback,
        id: "duplicate-confirm-1",
        data: "dupdel:c:media_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    env,
  );
  assert.deepEqual(calls.slice(2).map((call) => call.method), [
    "deleteMessage",
    "answerCallbackQuery",
    "editMessageText",
  ]);
  assert.deepEqual(calls[2].body, { chat_id: "-1004460339207", message_id: 17 });
  assert.ok(confirmDb.statements.some((statement) => statement.sql === "DELETE FROM media WHERE id = ?"));
  assert.match(calls.at(-1).body.text, /已删除 #ADN-100/);
});

test("refresh command rejects non-admins and permits configured admins", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "1001, 2002",
    TELEGRAM_CHANNEL_ID: "-1004396154285",
  };

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 3003 },
        text: "/refresh",
      },
    },
    env,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "getChatMember");
  assert.equal(calls.at(-1).body.text, "权限不足");

  const adminDb = new FakeD1({
    batchResults: [
      [{ display_name: "松下纱荣子" }],
      [{ display_name: "人妻", weight: 1 }],
    ],
    firstResults: [null, null],
  });
  await service.handleUpdate(
    adminDb,
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 2002 },
        text: "/refresh",
      },
    },
    env,
  );
  assert.ok(calls.some((call) => call.method === "pinChatMessage"));
  assert.equal(calls.at(-1).body.text, "✅ 置顶索引已刷新");
});

test("channel administrators receive bot admin permissions while regular members do not", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      const method = url.split("/").at(-1);
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      const result = method === "getChatMember"
        ? { status: body.user_id === "7001" ? "administrator" : "member" }
        : { message_id: 1 };
      return { json: async () => ({ ok: true, result }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };
  const adminDb = new FakeD1({
    allResults: [[{
      tg_file_unique_id: "same-file",
      normalized_code: "ADN-100",
      title: "候选标题",
      tg_chat_id: "-1004460339207",
      tg_message_id: 17,
    }, {
      tg_file_unique_id: "same-file",
      normalized_code: "ADN-100",
      title: "候选标题副本",
      tg_chat_id: "-1004460339207",
      tg_message_id: 18,
    }]],
  });
  await service.handleUpdate(
    adminDb,
    { message: { chat: { id: 111, type: "private" }, from: { id: 7001 }, text: "/duplicates" } },
    env,
  );
  assert.equal(calls[0].method, "getChatMember");
  assert.deepEqual(calls[0].body, { chat_id: "-1004460339207", user_id: "7001" });
  assert.ok(calls.at(-1).body.text.includes("重复候选"));

  await service.handleUpdate(
    new FakeD1(),
    { message: { chat: { id: 111, type: "private" }, from: { id: 7002 }, text: "/duplicates" } },
    env,
  );
  assert.equal(calls.at(-2).method, "getChatMember");
  assert.equal(calls.at(-1).body.text, "权限不足");
});

test("private bot gives a specific message for recognized but uncollected searches", async () => {
  const telegramCalls = [];
  const searchService = createSearchStub({
    resolution: { type: "code_prefix", match: "prefix", prefix: "ADN" },
    media: [],
  });
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "ADN",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.equal(
    telegramCalls[0].body.text,
    "暂未收录 #ADN。\n请检查番号格式，或只输入前缀后重试。",
  );
});

test("private bot gives examples for unrecognized searches", async () => {
  const calls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  });

  await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "不存在的查询",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );

  assert.ok(calls[0].body.text.includes("番号或前缀：ADN-100、ADN"));
  assert.ok(calls[0].body.text.includes("话题：#剧情"));
  assert.ok(calls[0].body.text.includes("/index 浏览已收录索引"));
});

test("private bot adds next-page navigation and edits the result on callback", async () => {
  const calls = [];
  const searchService = {
    resolveQuery(query) {
      return {
        query,
        resolution: { type: "code_prefix", match: "prefix", prefix: "ADN" },
      };
    },
    async findMedia(_db, { page }) {
      return {
        page,
        page_size: 10,
        total: 12,
        results: page === 1 ? [sampleMedia] : [{ ...sampleMedia, code: "ADN-200" }],
      };
    },
  };
  const service = createService({
    searchService,
    fetchImpl: async (url, init) => {
      calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: true }) };
    },
  });
  const db = new FakeD1();

  await service.handleUpdate(
    db,
    {
      message: {
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        text: "ADN",
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );
  assert.equal(calls[0].method, "sendMessage");
  assert.deepEqual(calls[0].body.reply_markup, {
    inline_keyboard: [[{ text: "下一页 ›", callback_data: "search:2:ADN" }]],
  });

  await service.handleUpdate(
    db,
    {
      callback_query: {
        id: "callback-1",
        data: "search:2:ADN",
        message: { message_id: 88, chat: { id: 111, type: "private" } },
      },
    },
    { TELEGRAM_BOT_TOKEN: "bot-token" },
  );
  assert.equal(calls[1].method, "answerCallbackQuery");
  assert.equal(calls[2].method, "editMessageText");
  assert.ok(calls[2].body.text.startsWith("11 •"));
  assert.deepEqual(calls[2].body.reply_markup, {
    inline_keyboard: [[{ text: "‹ 上一页", callback_data: "search:1:ADN" }]],
  });
});

test("admin private forward from the configured legacy channel is indexed then deleted", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_legacy_1", outcome: "created", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });
  const db = new FakeD1();

  const result = await service.handleUpdate(
    db,
    {
      message: {
        message_id: 12,
        chat: { id: 111, type: "private" },
        from: { id: 222 },
        caption: "ADN-001 #人妻",
        video: { file_id: "PRIVATE", file_unique_id: "UNIQUE", file_name: "ADN-001.mp4" },
        forward_origin: {
          type: "channel",
          chat: { id: -1004460339207 },
          message_id: 777,
        },
      },
    },
    {
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_ADMIN_IDS: "222",
      TELEGRAM_CHANNEL_ID: "-1004460339207",
    },
  );

  assert.equal(result.private_copy_deleted, true);
  assert.equal(result.source_channel_message_id, 777);
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].source.external_id, "-1004460339207:777");
  assert.equal(ingestCalls[0].code, "ADN-001");
  assert.deepEqual(ingestCalls[0].raw_tags, ["人妻"]);
  assert.deepEqual(telegramCalls.map((call) => call.method), ["deleteMessage", "sendMessage"]);
  assert.equal(telegramCalls[0].body.message_id, 12);
  assert.ok(telegramCalls[1].body.text.includes("已收录 #ADN-001"));
  assert.ok(
    db.statements.some((statement) =>
      typeof statement.sql === "string" &&
      statement.sql.includes("INSERT INTO channel_posts") &&
      Array.isArray(statement.values) &&
      statement.values.includes(777),
    ),
  );
});

test("private forwarded media group inherits caption tags and removes every private copy", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_group_legacy", outcome: "created", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    mediaGroupSettleMs: 0,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "222",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };
  const origin = {
    type: "channel",
    chat: { id: -1004460339207 },
    message_id: 778,
  };
  const groupId = "private_album_1";
  const captionPost = {
    message_id: 60,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    caption: "ADN-002 #松下纱荣子",
    forward_origin: origin,
  };
  const videoPost = {
    message_id: 61,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    video: { file_id: "GROUP", file_name: "clip.mp4" },
    forward_origin: origin,
  };
  const storedCaption = { value: JSON.stringify(captionPost) };
  const storedVideo = { value: JSON.stringify(videoPost) };
  const db = new FakeD1({
    allResults: [
      [storedCaption],
      [storedCaption],
      [storedCaption, storedVideo],
      [storedCaption, storedVideo],
    ],
  });

  const buffered = await service.handleUpdate(db, { message: captionPost }, env);
  const completed = await service.handleUpdate(db, { message: videoPost }, env);

  assert.deepEqual(buffered, {
    buffered: true,
    media_group_id: groupId,
  });
  assert.equal(completed.source_channel_message_id, 778);
  assert.equal(ingestCalls[0].code, "ADN-002");
  assert.deepEqual(ingestCalls[0].raw_tags, ["松下纱荣子"]);
  assert.equal(ingestCalls[0].actors, undefined);
  assert.deepEqual(
    telegramCalls.map((call) => [call.method, call.body.message_id]),
    [["deleteMessage", 60], ["deleteMessage", 61], ["sendMessage", undefined]],
  );
  assert.ok(
    db.statements.some((statement) => statement.sql.includes("substr(key, 1, length(?))")),
    "media-group lookup must use an exact prefix comparison for D1",
  );
  assert.ok(
    !db.statements.some((statement) => statement.sql.includes("key LIKE")),
    "media-group lookup must not interpret underscores in state keys as LIKE wildcards",
  );
});

test("private forwarded all-media album deletes every member after one catalog entry", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_group_video", outcome: "created", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    mediaGroupSettleMs: 0,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "222",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };
  const origin = {
    type: "channel",
    chat: { id: -1004460339207 },
    message_id: 779,
  };
  const groupId = "private_album_2";
  const firstVideo = {
    message_id: 70,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    caption: "STARS-676 #人妻 #不伦",
    video: { file_id: "FIRST", file_name: "STARS-676.mp4" },
    forward_origin: origin,
  };
  const secondVideo = {
    message_id: 71,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    video: { file_id: "SECOND", file_name: "clip.mp4" },
    forward_origin: origin,
  };
  const storedFirst = { value: JSON.stringify(firstVideo) };
  const storedSecond = { value: JSON.stringify(secondVideo) };
  const db = new FakeD1({
    allResults: [
      [storedFirst, storedSecond],
      [storedFirst, storedSecond],
      [storedFirst, storedSecond],
      [storedFirst, storedSecond],
    ],
  });

  const first = await service.handleUpdate(db, { message: firstVideo }, env);
  const completed = await service.handleUpdate(db, { message: secondVideo }, env);

  assert.deepEqual(first, {
    buffered: true,
    media_group_id: groupId,
    collected: 2,
  });
  assert.equal(completed.source_channel_message_id, 779);
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].code, "STARS-676");
  assert.deepEqual(ingestCalls[0].raw_tags, ["人妻", "不伦"]);
  assert.deepEqual(
    telegramCalls.map((call) => [call.method, call.body.message_id]),
    [["deleteMessage", 70], ["deleteMessage", 71], ["sendMessage", undefined]],
  );
});

test("private forwarded album ingests its video when the last member is non-media", async () => {
  const telegramCalls = [];
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_group_trailing_photo", outcome: "created", status: "approved" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
    mediaGroupSettleMs: 0,
    fetchImpl: async (url, init) => {
      telegramCalls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: {} }) };
    },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_ADMIN_IDS: "222",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };
  const origin = {
    type: "channel",
    chat: { id: -1004460339207 },
    message_id: 780,
  };
  const groupId = "private_album_trailing_photo";
  const videoPost = {
    message_id: 72,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    caption: "ADN-200 #松下纱荣子",
    video: { file_id: "VIDEO", file_name: "ADN-200.mp4" },
    forward_origin: origin,
  };
  const firstPhoto = {
    message_id: 73,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    photo: [{ file_id: "PHOTO1" }],
    forward_origin: origin,
  };
  const lastPhoto = {
    message_id: 74,
    chat: { id: 111, type: "private" },
    from: { id: 222 },
    media_group_id: groupId,
    photo: [{ file_id: "PHOTO2" }],
    forward_origin: origin,
  };
  const storedPosts = [videoPost, firstPhoto, lastPhoto].map((post) => ({
    value: JSON.stringify(post),
  }));
  const db = new FakeD1({
    allResults: [
      storedPosts,
      storedPosts,
      storedPosts,
      storedPosts,
      storedPosts,
      storedPosts,
    ],
  });

  const first = await service.handleUpdate(db, { message: videoPost }, env);
  const second = await service.handleUpdate(db, { message: firstPhoto }, env);
  const completed = await service.handleUpdate(db, { message: lastPhoto }, env);

  assert.equal(first.buffered, true);
  assert.equal(second.buffered, true);
  assert.equal(completed.source_channel_message_id, 780);
  assert.equal(ingestCalls.length, 1);
  assert.equal(ingestCalls[0].code, "ADN-200");
  assert.deepEqual(ingestCalls[0].raw_tags, ["松下纱荣子"]);
  assert.deepEqual(
    telegramCalls.map((call) => [call.method, call.body.message_id]),
    [
      ["deleteMessage", 72],
      ["deleteMessage", 73],
      ["deleteMessage", 74],
      ["sendMessage", undefined],
    ],
  );
});

test("legacy private forwarding rejects non-admins and other origins", async () => {
  const ingestCalls = [];
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "must_not_happen" };
      },
    },
    searchConfig: configs.get("search").data,
    searchService: createSearchStub(),
    versionConfig,
  });
  const baseMessage = {
    message_id: 12,
    chat: { id: 111, type: "private" },
    caption: "ADN-001 #人妻",
    video: { file_id: "PRIVATE", file_name: "ADN-001.mp4" },
    forward_origin: {
      type: "channel",
      chat: { id: -1004460339207 },
      message_id: 777,
    },
  };
  const env = {
    TELEGRAM_ADMIN_IDS: "222",
    TELEGRAM_CHANNEL_ID: "-1004460339207",
  };

  const nonAdmin = await service.handleUpdate(
    new FakeD1(),
    { message: { ...baseMessage, from: { id: 333 } } },
    env,
  );
  const otherChannel = await service.handleUpdate(
    new FakeD1(),
    {
      message: {
        ...baseMessage,
        from: { id: 222 },
        forward_origin: {
          type: "channel",
          chat: { id: -1004396154285 },
          message_id: 888,
        },
      },
    },
    env,
  );

  assert.deepEqual(nonAdmin, { ignored: "private_forward_not_admin" });
  assert.equal(otherChannel, null);
  assert.equal(ingestCalls.length, 0);
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
          allowed_updates: [
            "message",
            "callback_query",
            "channel_post",
            "edited_channel_post",
          ],
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
    allowed_updates: [
      "message",
      "callback_query",
      "channel_post",
      "edited_channel_post",
    ],
  });
  assert.ok(telegramCalls[0].url.includes("/setWebhook"));
  assert.deepEqual(telegramCalls[1].body, {
    commands: [
      { command: "stats", description: "查看收录统计" },
      { command: "index", description: "跳转频道索引" },
      { command: "duplicates", description: "查看重复候选（管理员）" },
      { command: "delete", description: "删除重复候选（管理员）" },
      { command: "refresh", description: "刷新频道索引（管理员）" },
      { command: "about", description: "简介说明" },
    ],
  });
  assert.ok(telegramCalls[1].url.includes("/setMyCommands"));
  assert.deepEqual(telegramCalls[2].body, {});
  assert.ok(telegramCalls[2].url.includes("/getWebhookInfo"));
  assert.deepEqual(telegramCalls[3].body, {});
  assert.ok(telegramCalls[3].url.includes("/getMe"));
  assert.deepEqual(telegramCalls[4].body, {
    chat_id: "-1004460339207",
    user_id: 8101858846,
  });
  assert.ok(telegramCalls[4].url.includes("/getChatMember"));
  assert.deepEqual(result.allowed_updates, [
    "message",
    "callback_query",
    "channel_post",
    "edited_channel_post",
  ]);
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
    firstResults: [null],
    batchResults: [
      [{ display_name: "希岛爱理" }, { display_name: "希岛爱理" }],
      [
        { display_name: "剧情", weight: 80 },
        { display_name: "中文字幕", weight: 70 },
        { display_name: "剧情", weight: 80 },
      ],
    ],
  });
  const pinned = await service.refreshPinnedIndex(freshDb, env);
  assert.equal(pinned.outcome, "pinned");
  assert.equal(pinned.pages, 1);
  assert.deepEqual(pinned.message_ids, [55]);
  assert.ok(telegramCalls.some((c) => c.url.includes("/pinChatMessage")));
  const sendCall = telegramCalls.find((c) => c.url.includes("/sendMessage"));
  assert.equal(
    sendCall.body.text,
    "影视库索引\n演员 1 位 · 话题 2 项\n\n👤演员 · 1\n#希岛爱理\n\n🏷话题 · 2\n#剧情 #中文字幕",
  );
  assert.ok(
    freshDb.statements.some(
      (s) => s.sql.includes("FROM media_tags") && s.sql.includes("tag_id NOT LIKE 'tag_topic_%'"),
    ),
    "index tags must exclude free raw topics and use standardized media_tags",
  );
  assert.ok(
    freshDb.statements.some((s) => s.sql.includes("INSERT INTO database_metadata")),
  );

  telegramCalls.length = 0;
  const editDb = new FakeD1({
    firstResults: [{ value: "[55]" }],
    batchResults: [
      [{ display_name: "希岛爱理" }, { display_name: "希岛爱理" }],
      [
        { display_name: "剧情", weight: 80 },
        { display_name: "中文字幕", weight: 70 },
        { display_name: "剧情", weight: 80 },
      ],
    ],
  });
  const edited = await service.refreshPinnedIndex(editDb, env);
  assert.equal(edited.outcome, "edited");
  assert.ok(telegramCalls[0].url.includes("/editMessageText"));
  assert.equal(telegramCalls[0].body.message_id, 55);
});

test("channel index deduplicates tags and groups long sections", () => {
  const service = createService();
  const tags = Array.from({ length: 25 }, (_, index) => ({
    display_name: `话题${index + 1}`,
  }));
  const pages = service.renderIndexPages({
    actors: [{ display_name: "希岛爱理" }, { display_name: "希岛爱理" }],
    tags: [...tags, { display_name: "话题1" }],
  });

  assert.equal(pages.length, 1);
  assert.match(pages[0], /演员 1 位 · 话题 25 项/);
  assert.match(pages[0], /👤演员 · 1/);
  assert.match(pages[0], /🏷话题 · 25（1\/2）/);
  assert.match(pages[0], /🏷话题 · 25（2\/2）/);
  assert.equal((pages[0].match(/#话题1(?:\s|$)/gu) ?? []).length, 1);
});

test("channel index excludes actor aliases, categories, and duplicate standard tags", () => {
  const service = createService({
    searchService: createSearchStub({
      resolutions: {
        "七海ティナ": { type: "actor", display_name: "七海蒂娜" },
        "日本": { type: "category", display_name: "日本" },
      },
    }),
  });
  const [page] = service.renderIndexPages({
    actors: [{ display_name: "七海蒂娜" }],
    tags: [
      { display_name: "七海蒂娜" },
      { display_name: "七海ティナ" },
      { display_name: "日本" },
      { display_name: "剧情" },
      { display_name: "剧情" },
    ],
  });

  assert.match(page, /👤演员 · 1\n#七海蒂娜/);
  assert.match(page, /🏷话题 · 1\n#剧情/);
  assert.ok(!page.includes("#七海ティナ"));
  assert.ok(!page.includes("#日本"));
});

test("empty channel index falls back to a single title message", async () => {
  const telegramCalls = [];
  const service = createService({
    fetchImpl: async (url, init) => {
      telegramCalls.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 101 } }) };
    },
  });
  const db = new FakeD1({ firstResults: [null], batchResults: [[], []] });

  const result = await service.refreshPinnedIndex(db, {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHANNEL_ID: "-100",
  });

  assert.equal(result.pages, 1);
  assert.deepEqual(result.message_ids, [101]);
  const sends = telegramCalls.filter((call) => call.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.text, "影视库索引");
  const pins = telegramCalls.filter((call) => call.url.includes("/pinChatMessage"));
  assert.equal(pins.length, 1);
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

test("inherits a preceding code when the video file name has no code", async () => {
  const ingestCalls = [];
  const context = {
    message_id: 600,
    code: "ADN-106",
    raw_tags: ["松下纱荣子"],
  };
  const service = createTelegramService({
    categoryConfig: configs.get("category").data,
    displayConfig,
    ingestService: {
      async ingest(_db, payload) {
        ingestCalls.push(payload);
        return { id: "media_context_code", status: "approved" };
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
        message_id: 601,
        video: { file_id: "CONTEXT-NO-CODE", file_name: "clip.mp4" },
      },
    },
    { TELEGRAM_CHANNEL_ID: "-1004460339207" },
  );

  assert.equal(ingestCalls[0].code, "ADN-106");
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

function createSearchStub({
  resolution = null,
  resolutions = {},
  media = [],
  rawTagMedia = [],
} = {}) {
  return {
    findCalls: [],
    resolveQuery(query) {
      return { query, resolution: resolutions[query] ?? resolution };
    },
    async findMedia(db, options) {
      this.findCalls.push(options);
      const results = Object.hasOwn(options.filters, "raw_tag") ? rawTagMedia : media;
      return { page: 1, page_size: 10, total: results.length, results };
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
