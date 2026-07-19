import assert from "node:assert/strict";
import test from "node:test";

import { createActorNormalizer } from "../src/actor-normalizer.mjs";
import { createIngestService } from "../src/ingest-service.mjs";
import { createMediaInputParser } from "../src/media-input.mjs";
import { createTagNormalizer } from "../src/tag-normalizer.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const versionConfig = requireConfig("version");
const service = createIngestService({
  actorNormalizer: createActorNormalizer({
    actorDictionaryConfig: requireConfig("actor_dictionary"),
    aliasConfig: requireConfig("alias"),
    reviewRulesConfig: requireConfig("review_rules"),
    versionConfig,
  }),
  mediaInputParser: createMediaInputParser(),
  reviewRulesConfig: requireConfig("review_rules"),
  searchConfig: requireConfig("search"),
  tagNormalizer: createTagNormalizer({
    aliasConfig: requireConfig("alias"),
    categoryConfig: requireConfig("category"),
    ignoredConfig: requireConfig("ignored"),
    reviewRulesConfig: requireConfig("review_rules"),
    tagDictionaryConfig: requireConfig("tag_dictionary"),
    versionConfig,
  }),
  versionConfig,
  now: () => new Date("2026-07-19T12:00:00Z"),
});

test("writes normalized media facts and associations in one D1 batch", async () => {
  const db = new RecordingD1();
  const result = await service.ingest(db, knownPayload());

  assert.equal(result.outcome, "created");
  assert.equal(result.status, "approved");
  assert.equal(result.category.category_id, "cat_japan");
  assert.deepEqual(
    result.actors.map((actor) => actor.actor_id),
    ["actor_000001"],
  );
  assert.deepEqual(
    result.tags.map((tag) => tag.tag_id),
    ["tag_chinese_subtitle", "tag_ntr"],
  );
  assert.equal(db.batches.length, 1);
  assert.ok(findStatement(db, "INSERT INTO media ("));
  assert.ok(findStatement(db, "INSERT INTO media_actors"));
  assert.equal(findStatements(db, "INSERT INTO media_tags").length, 2);
  assert.equal(findStatements(db, "INSERT INTO review_items").length, 0);
});

test("writes unknown values and invalid codes to review without changing rules", async () => {
  const db = new RecordingD1();
  const result = await service.ingest(db, {
    source: {
      provider: "example",
      external_id: "unknown-001",
    },
    title: "Unknown metadata",
    code: "not-a-code",
    actors: ["未知演员"],
    raw_tags: ["未知分类"],
  });

  assert.equal(result.status, "pending");
  assert.deepEqual(
    new Set(result.reviews.map((review) => review.review_type)),
    new Set(["pending_tag", "pending_category", "pending_actor", "possible_code"]),
  );
  assert.equal(findStatements(db, "INSERT INTO review_items").length, 4);
});

test("uses a stable media id and reports idempotent updates", async () => {
  const firstDb = new RecordingD1();
  const first = await service.ingest(firstDb, knownPayload());
  const secondDb = new RecordingD1({ id: first.id, status: "approved" });
  const second = await service.ingest(secondDb, knownPayload());

  assert.equal(second.id, first.id);
  assert.equal(second.outcome, "updated");
});

test("reuses an existing media id and preserves terminal media status", async () => {
  const db = new RecordingD1({
    id: "media_migrated_001",
    status: "rejected",
  });
  const result = await service.ingest(db, knownPayload());

  assert.equal(result.id, "media_migrated_001");
  assert.equal(result.outcome, "updated");
  assert.equal(result.status, "rejected");
  assert.equal(
    findStatement(db, "INSERT INTO media_actors").values[0],
    "media_migrated_001",
  );
  assert.equal(
    findStatement(db, "INSERT INTO media (").values[0],
    "media_migrated_001",
  );
  assert.match(
    findStatement(db, "INSERT INTO media (").sql,
    /WHEN media\.status IN \('rejected', 'disabled'\)/,
  );
});

test("creates new review records without reusing completed review ids", async () => {
  const firstDb = new RecordingD1();
  await service.ingest(firstDb, unknownPayload());
  const secondDb = new RecordingD1({
    id: "existing",
    status: "pending",
  });
  await service.ingest(secondDb, unknownPayload());

  const firstReviewId = findStatement(
    firstDb,
    "INSERT INTO review_items",
  ).values[0];
  const secondReviewId = findStatement(
    secondDb,
    "INSERT INTO review_items",
  ).values[0];
  assert.notEqual(secondReviewId, firstReviewId);
});

function knownPayload() {
  return {
    source: {
      provider: "example",
      external_id: "video-001",
      url: "https://example.com/video-001",
    },
    title: "Sample title",
    code: "ABP 123",
    release_date: "2026-07-19",
    actors: ["希島愛理"],
    raw_tags: ["日本成人", "NTR", "CHS"],
  };
}

function unknownPayload() {
  return {
    source: {
      provider: "example",
      external_id: "unknown-repeat",
    },
    title: "Unknown metadata",
    actors: ["未知演员"],
    raw_tags: ["未知分类"],
  };
}

class RecordingD1 {
  constructor(existing = null) {
    this.existing = existing;
    this.batches = [];
  }

  prepare(sql) {
    return new RecordingStatement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true }));
  }
}

class RecordingStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.existing;
  }
}

function findStatement(db, fragment) {
  return findStatements(db, fragment)[0];
}

function findStatements(db, fragment) {
  return db.batches.flat().filter((statement) =>
    statement.sql.includes(fragment),
  );
}

function requireConfig(name) {
  const config = configs.get(name)?.data;
  assert.ok(config, `config/${name}.json must exist`);
  return config;
}
