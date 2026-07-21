import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReviewDecisions,
  validateDecisionRows,
} from "../scripts/lib/review-decisions.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);

test("validates the two-column owner decision format", () => {
  assert.deepEqual(
    validateDecisionRows([
      ["三上", "1"],
      ["无码中字", "1", "中文字幕"],
      ["日本电影", "2"],
    ]),
    [],
  );
  assert.ok(validateDecisionRows([["三上", "3"]]).length > 0);
  assert.ok(validateDecisionRows([["日本电影", "2", "日本"]]).length > 0);
  assert.ok(validateDecisionRows([["三上", "1"], ["三上", "2"]]).length > 0);
});

test("approves an unambiguous actor shorthand as an alias", () => {
  const state = createState();
  const result = applyReviewDecisions({
    ...state,
    decisions: [["三上", "1"]],
    reviewItems: [review("pending_actor", "三上")],
  });

  const actor = state.actorConfig.items.find(
    (item) => item.actor_id === "actor_000003",
  );
  assert.ok(actor.aliases.some((alias) => alias.value === "三上"));
  assert.equal(result.applied[0].outcome, "actor_alias:actor_000003");
  assert.equal(result.version, "1.3.3");
});

test("rejects a category-like tag in both relevant scopes", () => {
  const state = createState();
  applyReviewDecisions({
    ...state,
    decisions: [["日本电影", "2"]],
    reviewItems: [
      review("pending_tag", "日本电影"),
      review("pending_category", "日本电影"),
    ],
  });

  const ignored = state.ignoredConfig.items.find(
    (item) => item.value === "日本电影",
  );
  assert.deepEqual(ignored.scope, ["category", "tag"]);
});

test("creates a deterministic manual tag for a new approved term", () => {
  const state = createState();
  applyReviewDecisions({
    ...state,
    decisions: [["新题材", "1"]],
    reviewItems: [review("pending_tag", "新题材")],
  });

  const tag = state.tagConfig.items.at(-1);
  assert.equal(tag.tag_id, "tag_manual_000001");
  assert.equal(tag.display_name, "新题材");
  assert.equal(tag.category, "other");
});

test("links an explicit synonym to an existing standard topic", () => {
  const state = createState();
  const result = applyReviewDecisions({
    ...state,
    decisions: [["字幕版", "1", "中文字幕"]],
    reviewItems: [review("pending_tag", "字幕版")],
  });

  const tag = state.tagConfig.items.find(
    (item) => item.tag_id === "tag_chinese_subtitle",
  );
  assert.ok(tag.aliases.includes("字幕版"));
  assert.equal(result.applied[0].outcome, "tag_alias:tag_chinese_subtitle");
});

test("stops when an explicit synonym target does not exist", () => {
  const state = createState();
  assert.throws(
    () =>
      applyReviewDecisions({
        ...state,
        decisions: [["CHT", "1", "不存在话题"]],
        reviewItems: [review("pending_tag", "CHT")],
      }),
    /target "不存在话题" does not exist/,
  );
});

function createState() {
  return {
    actorConfig: structuredClone(configs.get("actor_dictionary").data),
    ignoredConfig: structuredClone(configs.get("ignored").data),
    tagConfig: structuredClone(configs.get("tag_dictionary").data),
    timestamp: "2026-07-21T16:00:00Z",
    versionConfig: structuredClone(configs.get("version").data),
  };
}

function review(reviewType, value) {
  return {
    review_type: reviewType,
    raw_values: [value],
    normalized_values: [value],
  };
}
