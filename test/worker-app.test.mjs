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
