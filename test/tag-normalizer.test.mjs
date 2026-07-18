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

  assert.equal(result.selected_category.category_id, "cat_japan");
  assert.deepEqual(
    result.standard_tags.map((tag) => tag.tag_id),
    ["tag_chinese_subtitle", "tag_office"],
  );
  assert.deepEqual(
    result.standard_tags[0].matched_raw_values,
    ["中文", "ＣＨＳ"],
  );
  assert.equal(result.ignored_tags[0].raw_value, "电影");
  assert.deepEqual(
    result.reviews.map((review) => review.review_type),
    ["pending_tag"],
  );
  assert.equal(result.decisions.length, result.raw_tags.length);
});

test("selects the highest-priority category and retains all candidates", () => {
  const result = createTagNormalizer(baseOptions).normalize(["欧美", "JP"]);

  assert.equal(result.selected_category.category_id, "cat_japan");
  assert.deepEqual(
    result.category_candidates.map((category) => category.category_id),
    ["cat_japan", "cat_western"],
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

  assert.equal(result.selected_category.category_id, "cat_japan");
  assert.deepEqual(
    result.category_candidates.map((category) => category.category_id),
    ["cat_japan", "cat_western"],
  );
  assert.equal(result.decisions[0].reference_id, "cat_japan");
  assert.equal(result.reviews.length, 0);
});

test("creates a category review when no category is resolved", () => {
  const result = createTagNormalizer(baseOptions).normalize(["NTR", "人妻"]);

  assert.equal(result.selected_category, null);
  assert.deepEqual(
    result.reviews.map((review) => review.review_type),
    ["pending_category"],
  );
  assert.equal(result.reviews[0].required_reviewer_role, "admin");
});

test("does not activate pending dictionary entries", () => {
  const options = structuredClone(baseOptions);
  const ntr = options.tagDictionaryConfig.items.find(
    (tag) => tag.tag_id === "tag_ntr",
  );
  ntr.status = "pending";

  const result = createTagNormalizer(options).normalize(["日本", "NTR"]);

  assert.equal(result.standard_tags.length, 0);
  assert.equal(result.reviews[0].review_type, "pending_tag");
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

  assert.equal(result.standard_tags.length, 0);
  assert.equal(result.reviews[0].review_type, "pending_alias");
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

  assert.equal(result.standard_tags.length, 2);
  assert.equal(result.display_tags.length, 1);
  assert.deepEqual(result.violations, [
    {
      code: "max_tags_per_video_exceeded",
      actual: 2,
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
  assert.throws(
    () => normalizer.normalize([]),
    /must contain at least one tag/,
  );
  assert.throws(() => normalizer.normalize(["  "]), /must not be blank/);
  assert.throws(() => normalizer.normalize([42]), /must be a string/);
});

function requireConfig(name) {
  const config = configs.get(name)?.data;
  assert.ok(config, `config/${name}.json must exist`);
  return config;
}
