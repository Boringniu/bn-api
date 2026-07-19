import assert from "node:assert/strict";
import test from "node:test";

import { createActorNormalizer } from "../src/actor-normalizer.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const normalizer = createActorNormalizer({
  actorDictionaryConfig: requireConfig("actor_dictionary"),
  aliasConfig: requireConfig("alias"),
  reviewRulesConfig: requireConfig("review_rules"),
  versionConfig: requireConfig("version"),
});

test("normalizes actor dictionary and global aliases", () => {
  const result = normalizer.normalize([
    "希島あいり",
    "希島愛理",
    "Yua Mikami",
  ]);

  assert.deepEqual(
    result.actors.map((actor) => actor.actor_id),
    ["actor_000001", "actor_000003"],
  );
  assert.deepEqual(result.actors[0].matched_raw_values, [
    "希島あいり",
    "希島愛理",
  ]);
  assert.equal(result.reviews.length, 0);
});

test("routes unknown actors to review without creating dictionary entries", () => {
  const result = normalizer.normalize(["未知演员"]);

  assert.equal(result.actors.length, 0);
  assert.equal(result.reviews[0].review_type, "pending_actor");
  assert.equal(result.reviews[0].allow_auto_approve, false);
  assert.equal(result.decisions[0].outcome, "pending_review");
});

test("accepts a missing actor list as an empty list", () => {
  assert.deepEqual(normalizer.normalize().actors, []);
  assert.throws(() => normalizer.normalize("希岛爱理"), /must be an array/);
});

test("refuses runtime rules that allow AI to create actors", () => {
  const actorDictionaryConfig = structuredClone(
    requireConfig("actor_dictionary"),
  );
  actorDictionaryConfig.rules.allow_ai_create_actor = true;

  assert.throws(
    () =>
      createActorNormalizer({
        actorDictionaryConfig,
        aliasConfig: requireConfig("alias"),
        reviewRulesConfig: requireConfig("review_rules"),
        versionConfig: requireConfig("version"),
      }),
    /allow_ai_create_actor=false/,
  );
});

function requireConfig(name) {
  const config = configs.get(name)?.data;
  assert.ok(config, `config/${name}.json must exist`);
  return config;
}
