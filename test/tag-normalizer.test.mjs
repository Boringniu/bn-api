import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { createTagNormalizer } from "../src/tag-normalizer.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const baseOptions = {
  aliasConfig: requireConfig("alias"),
  categoryConfig: requireConfig("category"),
  ignoredConfig: requireConfig("ignored"),
  reviewRulesConfig: requireConfig("review_rules"),
  tagDictionaryConfig: requireConfig("tag_dictionary"),
  versionConfig: requireConfig("version"),
};

test("normalizes dictionary aliases, global aliases, ignored values, and reviews", () => {
  const result = createTagNormalizer(baseOptions).normalize([
    "日本成人",
    "中文",
    "ＣＨＳ",
    "电影",
    "office lady",
    "未知流派",
  ]);

  assert.equal(result.selected_category, null);
  assert.deepEqual(result.category_candidates, []);
  assert.deepEqual(result.reviews, []);
  assert.equal(result.standard_tags.length, 5);
  assert.ok(result.standard_tags.some((tag) => tag.display_name === "日本"));
  assert.ok(result.standard_tags.some((tag) => tag.display_name === "未知流派"));
  assert.equal(result.decisions.length, result.raw_tags.length);
});

test("selects the highest-priority category and retains all candidates", () => {
  const result = createTagNormalizer(baseOptions).normalize(["欧美", "JP"]);

  assert.equal(result.selected_category, null);
  assert.deepEqual(result.category_candidates, []);
  assert.deepEqual(
    result.standard_tags.map((tag) => tag.display_name),
    ["日本", "欧美"],
  );
  assert.equal(result.reviews.length, 0);
});

test("resolves multiple category matches using category priority", () => {
  const options = structuredClone(baseOptions);
  const template = options.aliasConfig.items[1];
  options.aliasConfig.items.push(
    {
      ...template,
      alias_id: "alias_900001",
      alias_type: "category",
      raw_value: "region",
      normalized_value: "region",
      target_type: "category",
      target_id: "cat_western",
      target_display_name: "欧美",
      match_mode: "prefix",
    },
    {
      ...template,
      alias_id: "alias_900002",
      alias_type: "category",
      raw_value: "region",
      normalized_value: "region",
      target_type: "category",
      target_id: "cat_japan",
      target_display_name: "日本",
      match_mode: "prefix",
    },
  );

  const result = createTagNormalizer(options).normalize(["region source"]);

  assert.equal(result.selected_category, null);
  assert.deepEqual(result.category_candidates, []);
  assert.equal(result.standard_tags.length, 1);
  assert.equal(result.standard_tags[0].display_name, "region source");
  assert.equal(result.reviews.length, 0);
});

test("creates a category review when no category is resolved", () => {
  const result = createTagNormalizer(baseOptions).normalize(["NTR", "人妻"]);

  assert.equal(result.selected_category, null);
  assert.deepEqual(result.reviews, []);
  assert.deepEqual(
    result.standard_tags.map((tag) => tag.display_name),
    ["NTR", "人妻"],
  );
});

test("does not recreate category reviews for an explicitly rejected value", () => {
  const options = structuredClone(baseOptions);
  options.ignoredConfig.items.push({
    ignore_id: "ignore_999999",
    value: "日本电影",
    normalized_value: "日本电影",
    scope: ["category", "tag"],
    match_mode: "exact",
    reason: "manual rejection",
    status: "approved",
    created_at: "2026-07-21T00:00:00Z",
  });

  const result = createTagNormalizer(options).normalize(["日本电影"]);

  assert.equal(result.selected_category, null);
  assert.equal(result.reviews.length, 0);
  assert.equal(result.decisions[0].outcome, "standard_tag");
  assert.equal(result.standard_tags[0].display_name, "日本电影");
});

test("does not activate pending dictionary entries", () => {
  const options = structuredClone(baseOptions);
  const ntr = options.tagDictionaryConfig.items.find(
    (tag) => tag.tag_id === "tag_ntr",
  );
  ntr.status = "pending";

  const result = createTagNormalizer(options).normalize(["日本", "NTR"]);

  assert.equal(result.standard_tags.length, 2);
  assert.equal(result.reviews.length, 0);
});

test("routes ambiguous broad aliases to review", () => {
  const options = structuredClone(baseOptions);
  const template = options.aliasConfig.items[1];
  options.aliasConfig.items.push(
    {
      ...template,
      alias_id: "alias_900001",
      raw_value: "office",
      normalized_value: "office",
      target_id: "tag_office",
      target_display_name: "办公室",
      match_mode: "prefix",
    },
    {
      ...template,
      alias_id: "alias_900002",
      raw_value: "office",
      normalized_value: "office",
      target_id: "tag_story",
      target_display_name: "剧情",
      match_mode: "prefix",
    },
  );

  const result = createTagNormalizer(options).normalize([
    "日本",
    "office worker",
  ]);

  assert.equal(result.standard_tags.length, 2);
  assert.equal(result.reviews.length, 0);
});

test("keeps all standard tags while applying display and database limits", () => {
  const options = structuredClone(baseOptions);
  options.tagDictionaryConfig.rules.max_tags_per_video = 1;
  options.tagDictionaryConfig.rules.max_display_tags_per_video = 1;

  const result = createTagNormalizer(options).normalize([
    "日本",
    "NTR",
    "人妻",
  ]);

  assert.equal(result.standard_tags.length, 3);
  assert.equal(result.display_tags.length, 1);
  assert.deepEqual(result.violations, [
    {
      code: "max_tags_per_video_exceeded",
      actual: 3,
      limit: 1,
    },
  ]);
});

test("returns output that conforms to the normalization contract", async () => {
  const contract = JSON.parse(
    await readFile(
      new URL(
        "../contracts/tag-normalization-result.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ allErrors: true }).compile(contract);
  const result = createTagNormalizer(baseOptions).normalize([
    "日本成人",
    "CHS",
    "电影",
    "未知流派",
  ]);

  assert.equal(validate(result), true, JSON.stringify(validate.errors, null, 2));
});

test("rejects invalid input instead of silently discarding it", () => {
  const normalizer = createTagNormalizer(baseOptions);

  assert.throws(() => normalizer.normalize("NTR"), /must be an array/);
  assert.deepEqual(normalizer.normalize([]).standard_tags, []);
  assert.throws(() => normalizer.normalize(["  "]), /must not be blank/);
  assert.throws(() => normalizer.normalize([42]), /must be a string/);
});

function requireConfig(name) {
  const config = configs.get(name)?.data;
  assert.ok(config, `config/${name}.json must exist`);
  return config;
}
