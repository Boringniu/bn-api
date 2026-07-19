import assert from "node:assert/strict";
import test from "node:test";

import { createSearchService } from "../src/search-service.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const service = createSearchService({
  actorDictionaryConfig: requireConfig("actor_dictionary"),
  aliasConfig: requireConfig("alias"),
  categoryConfig: requireConfig("category"),
  ignoredConfig: requireConfig("ignored"),
  searchConfig: requireConfig("search"),
  tagDictionaryConfig: requireConfig("tag_dictionary"),
  versionConfig: requireConfig("version"),
});

test("resolves normalized codes first", () => {
  for (const input of ["abp123", "ABP 123", "abp_123", "ABP-123"]) {
    const { resolution } = service.resolveQuery(input);
    assert.equal(resolution.type, "code", input);
    assert.equal(resolution.code, "ABP-123", input);
  }
});

test("resolves actors via every configured name field and alias", () => {
  for (const input of [
    "希岛爱理",
    "希島あいり",
    "Airi Kijima",
    "kijima airi",
    "希島愛理",
  ]) {
    const { resolution } = service.resolveQuery(input);
    assert.equal(resolution.type, "actor", input);
    assert.equal(resolution.actor_id, "actor_000001", input);
  }
});

test("resolves tags and categories through aliases", () => {
  assert.equal(service.resolveQuery("中字").resolution.tag_id, "tag_chinese_subtitle");
  assert.equal(service.resolveQuery("office lady").resolution.tag_id, "tag_office");
  assert.equal(
    service.resolveQuery("jav").resolution.category_id,
    "cat_japan",
  );
});

test("does not resolve deprecated or ignored values", () => {
  for (const input of ["无码", "有码", "1080p", "uncensored"]) {
    const { resolution } = service.resolveQuery(input);
    assert.equal(resolution, null, input);
  }
});

test("falls back to code prefix and fuzzy matching", () => {
  const prefix = service.resolveQuery("abp").resolution;
  assert.equal(prefix.type, "code_prefix");
  assert.equal(prefix.prefix, "ABP");

  const fuzzy = service.resolveQuery("希岛爱里").resolution;
  assert.equal(fuzzy.type, "actor");
  assert.equal(fuzzy.actor_id, "actor_000001");
  assert.equal(fuzzy.match, "fuzzy");
});

test("returns null resolution for empty and unknown queries", () => {
  assert.equal(service.resolveQuery("").resolution, null);
  assert.equal(service.resolveQuery("完全不存在的词xyz").resolution, null);
});

test("findMedia queries only approved media with clamped paging", async () => {
  const db = new FakeD1();
  const result = await service.findMedia(db, {
    filters: { category_id: "cat_japan" },
    page: 1,
    pageSize: 99,
  });

  assert.equal(result.page_size, 20);
  const listSql = db.statements[0].sql;
  assert.match(listSql, /m\.status = 'approved'/);
  assert.match(listSql, /m\.category_id = \?/);
  assert.ok(!listSql.includes("raw_payload_json"));
  assert.ok(!listSql.includes("source_url"));
});

test("findMedia joins associations for actor and tag filters", async () => {
  const db = new FakeD1();
  await service.findMedia(db, {
    filters: { actor_id: "actor_000001", tag_id: "tag_wife" },
  });
  const listSql = db.statements[0].sql;
  assert.match(listSql, /JOIN media_actors/);
  assert.match(listSql, /JOIN media_tags/);
  assert.match(listSql, /fa\.search_enabled = 1/);
  assert.match(listSql, /ft\.search_enabled = 1/);
});

test("findMedia stops paging at the configured result ceiling", async () => {
  const db = new FakeD1();
  const result = await service.findMedia(db, { page: 21, pageSize: 10 });
  assert.deepEqual(result, {
    page: 21,
    page_size: 10,
    total: 0,
    results: [],
  });
  assert.equal(db.statements.length, 0);
});

test("getMedia returns null for missing or unapproved media", async () => {
  const db = new FakeD1();
  const media = await service.getMedia(db, "media_missing");
  assert.equal(media, null);
  assert.match(db.statements[0].sql, /m\.status = 'approved'/);
});

class FakeD1 {
  constructor() {
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
        return null;
      },
      async all() {
        db.statements.push(this);
        return { results: [] };
      },
    };
  }

  async batch(statements) {
    this.statements.push(...statements);
    return statements.map(() => ({ results: [] }));
  }
}

function requireConfig(name) {
  const config = configs.get(name)?.data;
  assert.ok(config, `config ${name} is required`);
  return config;
}
