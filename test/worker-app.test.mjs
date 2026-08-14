import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerApp } from "../src/worker-app.mjs";

const versionConfig = {
  release: {
    version: "1.1.0",
  },
};

test("reports health without exposing protected operations", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/health"),
    {},
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "bn-api",
    ruleset_version: "1.1.0",
  });
});

test("requires the configured bearer token for ingest", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    versionConfig,
  });
  const response = await app.fetch(
    jsonRequest("https://api.example.com/v1/media", {}),
    {
      DB: {},
      INGEST_TOKEN: "secret",
    },
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("returns the ingest result and created status", async () => {
  const ingestService = createIngestStub({
    id: "media_123",
    outcome: "created",
    status: "approved",
  });
  const app = createWorkerApp({
    ingestService,
    versionConfig,
  });
  const response = await app.fetch(
    jsonRequest("https://api.example.com/v1/media", {
      source: {
        provider: "example",
        external_id: "video-001",
      },
      title: "Sample",
      raw_tags: ["日本"],
    }, "secret"),
    {
      DB: {},
      INGEST_TOKEN: "secret",
    },
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.id, "media_123");
  assert.equal(ingestService.calls.length, 1);
});

test("rejects request bodies above the ingest limit", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/media", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "x".repeat(1_048_576) }),
    }),
    {
      DB: {},
      INGEST_TOKEN: "secret",
    },
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "payload_too_large");
});

test("requires an application/json media type", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/media", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "text/application/json",
      },
      body: "{}",
    }),
    {
      DB: {},
      INGEST_TOKEN: "secret",
    },
  );

  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, "unsupported_media_type");
});

test("serves public search with query resolution", async () => {
  const searchService = createSearchStub();
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    searchService,
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/search?q=%E4%BA%BA%E5%A6%BB&page=2"),
    { DB: {} },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.resolution.type, "tag");
  assert.equal(searchService.findCalls[0].filters.tag_id, "tag_wife");
  assert.equal(searchService.findCalls[0].page, 2);
});

test("search returns empty result set for unresolvable queries", async () => {
  const searchService = createSearchStub({ resolution: null });
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    searchService,
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/search?q=unknown"),
    { DB: {} },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.total, 0);
  assert.equal(searchService.findCalls.length, 0);
});

test("search rejects more than five filters", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    searchService: createSearchStub(),
    versionConfig,
  });
  const response = await app.fetch(
    new Request(
      "https://api.example.com/v1/search?category_id=a&actor_id=b&tag_id=c&code=d&subtitle=1&year=2026",
    ),
    { DB: {} },
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_filter");
});

test("returns 404 for missing media detail", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    searchService: createSearchStub({ media: null }),
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/media/media_missing"),
    { DB: {} },
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "media_not_found");
});

test("serves media detail and code prefixes", async () => {
  const searchService = createSearchStub({
    media: { id: "media_1", title: "t" },
    prefixes: [{ prefix: "ABP", media_count: 3 }],
  });
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    searchService,
    versionConfig,
  });

  const detail = await app.fetch(
    new Request("https://api.example.com/v1/media/media_1"),
    { DB: {} },
  );
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.id, "media_1");

  const codes = await app.fetch(
    new Request("https://api.example.com/v1/codes"),
    { DB: {} },
  );
  assert.equal(codes.status, 200);
  assert.deepEqual((await codes.json()).data.prefixes, [
    { prefix: "ABP", media_count: 3 },
  ]);
});

test("review queue distinguishes editor and admin tokens", async () => {
  const reviewService = createReviewStub();
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService,
    searchService: createSearchStub(),
    versionConfig,
  });
  const env = {
    DB: {},
    REVIEW_TOKEN_EDITOR: "editor-secret",
    REVIEW_TOKEN_ADMIN: "admin-secret",
  };

  const unauthorized = await app.fetch(
    new Request("https://api.example.com/v1/review"),
    env,
  );
  assert.equal(unauthorized.status, 401);

  const asAdmin = await app.fetch(
    new Request("https://api.example.com/v1/review", {
      headers: { authorization: "Bearer admin-secret" },
    }),
    env,
  );
  assert.equal(asAdmin.status, 200);
  assert.equal((await asAdmin.json()).data.reviewer_role, "admin");
});

test("review action passes the authenticated role, not a client claim", async () => {
  const reviewService = createReviewStub();
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService,
    searchService: createSearchStub(),
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/review/review_1/action", {
      method: "POST",
      headers: {
        authorization: "Bearer editor-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "approve", reviewerRole: "admin" }),
    }),
    {
      DB: {},
      REVIEW_TOKEN_EDITOR: "editor-secret",
      REVIEW_TOKEN_ADMIN: "admin-secret",
    },
  );

  assert.equal(response.status, 200);
  assert.equal(reviewService.actionCalls[0].options.reviewerRole, "editor");
});

test("configures Telegram webhook updates through a protected endpoint", async () => {
  const telegramService = {
    calls: [],
    async configureWebhook(env, webhookUrl) {
      this.calls.push({ env, webhookUrl });
      return {
        url: webhookUrl,
        allowed_updates: ["message", "channel_post", "edited_channel_post"],
        pending_update_count: 0,
      };
    },
  };
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    telegramService,
    versionConfig,
  });

  const response = await app.fetch(
    new Request("https://bn-api.nnmmc326.workers.dev/v1/telegram/webhook", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    { INGEST_TOKEN: "secret" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    url: "https://bn-api.nnmmc326.workers.dev/",
    allowed_updates: ["message", "channel_post", "edited_channel_post"],
    pending_update_count: 0,
  });
  assert.equal(telegramService.calls.length, 1);
  assert.equal(telegramService.calls[0].webhookUrl, "https://bn-api.nnmmc326.workers.dev/");
});

test("rejects Telegram webhook configuration without internal authorization", async () => {
  const telegramService = {
    async configureWebhook() {
      throw new Error("must not be called");
    },
  };
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    telegramService,
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/v1/telegram/webhook", { method: "POST" }),
    { INGEST_TOKEN: "secret" },
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthorized");
});

test("accepts authenticated Telegram webhooks on the root path", async () => {
  const telegramService = {
    updates: [],
    async handleUpdate(db, update) {
      this.updates.push({ db, update });
    },
  };
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService,
    versionConfig,
  });

  const response = await app.fetch(
    new Request("https://api.example.com/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret",
      },
      body: JSON.stringify({ update_id: 1 }),
    }),
    { DB: {}, TELEGRAM_WEBHOOK_SECRET: "webhook-secret" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(telegramService.updates.length, 1);
});

test("audits Telegram channel updates without persisting caption content", async () => {
  const db = new AuditD1();
  const telegramService = {
    async handleUpdate() {
      return { ingested: "media_1", status: "approved" };
    },
  };
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService,
    versionConfig,
  });
  const caption = "ADN-162 #日本 不应写入审计表";
  const response = await app.fetch(
    new Request("https://api.example.com/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "webhook-secret",
      },
      body: JSON.stringify({
        update_id: 88,
        edited_channel_post: {
          message_id: 1686,
          chat: { id: -1004460339207 },
          caption,
        },
      }),
    }),
    { DB: db, TELEGRAM_WEBHOOK_SECRET: "webhook-secret" },
  );

  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 2);
  const serialized = JSON.stringify(db.calls);
  assert.match(serialized, /edited_channel_post/);
  assert.match(serialized, /-1004460339207/);
  assert.match(serialized, /1686/);
  assert.doesNotMatch(serialized, new RegExp(caption));
});

test("rejects unauthenticated Telegram webhooks on the root path", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService: { async handleUpdate() {} },
    versionConfig,
  });
  const response = await app.fetch(
    new Request("https://api.example.com/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    }),
    { DB: {}, TELEGRAM_WEBHOOK_SECRET: "webhook-secret" },
  );

  assert.equal(response.status, 401);
});

test("removed channel distribution routes return 404", async () => {
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService: {},
    versionConfig,
  });
  const env = { DB: {}, INGEST_TOKEN: "secret" };

  for (const path of [
    "/v1/channel/publish/media_1",
    "/v1/channel/reconcile",
  ]) {
    const response = await app.fetch(
      new Request(`https://api.example.com${path}`, {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
      env,
    );
    assert.equal(response.status, 404, path);
  }
});

test("reindex skips Telegram index refresh when Telegram is not configured", async () => {
  const telegramService = {
    refreshCalls: 0,
    async refreshPinnedIndex() {
      this.refreshCalls += 1;
      return { outcome: "edited", pages: 1, message_ids: [10] };
    },
  };
  const app = createWorkerApp({
    ingestService: createIngestStub(),
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService,
    versionConfig,
  });

  const response = await app.fetch(
    new Request("https://api.example.com/v1/catalog/reindex", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    { DB: new CatalogD1([]), INGEST_TOKEN: "secret" },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.processed, 0);
  assert.equal(body.data.remaining, 0);
  assert.deepEqual(body.data.index, {
    outcome: "skipped",
    reason: "telegram_not_configured",
  });
  assert.equal(telegramService.refreshCalls, 0);
});

test("reindexes stored payloads and refreshes the index when complete", async () => {
  const ingestService = createIngestStub({ status: "approved" });
  const telegramService = {
    refreshCalls: 0,
    async refreshPinnedIndex() {
      this.refreshCalls += 1;
      return { outcome: "edited", pages: 1, message_ids: [10] };
    },
  };
  const app = createWorkerApp({
    ingestService,
    reviewService: createReviewStub(),
    searchService: createSearchStub(),
    telegramService,
    versionConfig,
  });
  const db = new CatalogD1([
    {
      id: "media_1",
      raw_payload_json: JSON.stringify({
        source: { provider: "channel", external_id: "-100:1" },
        title: "ABP-123",
        raw_tags: ["日本"],
      }),
    },
  ]);

  const response = await app.fetch(
    new Request("https://api.example.com/v1/catalog/reindex", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }),
    {
      DB: db,
      INGEST_TOKEN: "secret",
      TELEGRAM_CHANNEL_ID: "-100",
      TELEGRAM_BOT_TOKEN: "bot-token",
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.processed, 1);
  assert.equal(body.data.remaining, 0);
  assert.equal(ingestService.calls.length, 1);
  assert.equal(telegramService.refreshCalls, 1);
});

function createReviewStub() {
  return {
    actionCalls: [],
    async listQueue() {
      return { page: 1, page_size: 20, total: 0, results: [] };
    },
    async applyAction(db, id, options) {
      this.actionCalls.push({ id, options });
      return { id, status: "approved", resolution: {} };
    },
  };
}

function createSearchStub({
  resolution = { type: "tag", match: "exact_alias", tag_id: "tag_wife" },
  media = null,
  prefixes = [],
} = {}) {
  return {
    findCalls: [],
    resolveQuery(query) {
      return { query, resolution };
    },
    async findMedia(db, options) {
      this.findCalls.push(options);
      return { page: options.page, page_size: 10, total: 0, results: [] };
    },
    async getMedia() {
      return media;
    },
    async listCodePrefixes() {
      return prefixes;
    },
  };
}

function createIngestStub(result = {}) {
  return {
    calls: [],
    async ingest(db, payload) {
      this.calls.push({ db, payload });
      return result;
    },
  };
}

function jsonRequest(url, body, token = null) {
  const headers = {
    "content-type": "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

class AuditD1 {
  constructor() {
    this.calls = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        db.calls.push({ sql, args });
        return this;
      },
      async run() {
        return { success: true };
      },
    };
  }
}

class CatalogD1 {
  constructor(rows) {
    this.rows = rows;
  }

  prepare(sql) {
    const db = this;
    return {
      bind() {
        return this;
      },
      async all() {
        return { results: db.rows };
      },
      async first() {
        return { total: 0 };
      },
    };
  }
}
