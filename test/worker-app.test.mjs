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
