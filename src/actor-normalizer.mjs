import { normalizeValue } from "./value-normalizer.mjs";

const APPROVED_STATUS = "approved";

export function createActorNormalizer({
  actorDictionaryConfig,
  aliasConfig,
  ignoredConfig,
  reviewRulesConfig,
  versionConfig,
}) {
  assertConfig(actorDictionaryConfig, "actorDictionaryConfig");
  assertConfig(aliasConfig, "aliasConfig");
  assertConfig(ignoredConfig, "ignoredConfig");
  assertConfig(reviewRulesConfig, "reviewRulesConfig");
  assertConfig(versionConfig, "versionConfig");
  assertRuntimeRules(actorDictionaryConfig);

  const actorIndex = new Map(
    actorDictionaryConfig.items
      .filter((actor) => actor.status === APPROVED_STATUS)
      .map((actor) => [actor.actor_id, actor]),
  );
  const valueIndex = buildValueIndex({
    actorIndex,
    aliasConfig,
  });
  const reviewRules = new Map(
    reviewRulesConfig.review_types
      .filter((rule) => rule.enabled)
      .map((rule) => [rule.type, rule]),
  );
  const ignoredActors = new Set(
    ignoredConfig.items
      .filter(
        (item) =>
          item.status === APPROVED_STATUS &&
          item.match_mode !== "regex" &&
          item.scope.includes("actor"),
      )
      .map((item) => item.normalized_value),
  );

  return Object.freeze({
    normalize(rawActors = []) {
      assertRawActors(rawActors);

      const actorMatches = new Map();
      const reviews = new Map();
      const decisions = [];

      for (const [inputIndex, rawValue] of rawActors.entries()) {
        const normalizedValue = normalizeValue(rawValue);
        if (!normalizedValue) {
          throw new TypeError(`rawActors[${inputIndex}] must not be blank`);
        }

        if (ignoredActors.has(normalizedValue)) {
          decisions.push({
            input_index: inputIndex,
            raw_value: rawValue,
            normalized_value: normalizedValue,
            outcome: "ignored",
            actor_id: null,
            display_name: null,
            source: "ignored",
            review_type: null,
          });
          continue;
        }

        const matches = deduplicateMatches(
          valueIndex.get(normalizedValue) ?? [],
        );
        if (matches.length === 0) {
          const review = addReview(reviews, reviewRules, "pending_actor", {
            normalizedValues: [normalizedValue],
            rawValues: [rawValue],
          });
          decisions.push({
            input_index: inputIndex,
            raw_value: rawValue,
            normalized_value: normalizedValue,
            outcome: "pending_review",
            actor_id: null,
            display_name: null,
            source: null,
            review_type: review.review_type,
          });
          continue;
        }

        if (matches.length > 1) {
          const review = addReview(reviews, reviewRules, "pending_alias", {
            normalizedValues: [normalizedValue],
            rawValues: [rawValue],
          });
          decisions.push({
            input_index: inputIndex,
            raw_value: rawValue,
            normalized_value: normalizedValue,
            outcome: "pending_review",
            actor_id: null,
            display_name: null,
            source: null,
            review_type: review.review_type,
          });
          continue;
        }

        const match = matches[0];
        addActorMatch(actorMatches, match.actor, {
          inputIndex,
          rawValue,
          source: match.source,
        });
        decisions.push({
          input_index: inputIndex,
          raw_value: rawValue,
          normalized_value: normalizedValue,
          outcome: "standard_actor",
          actor_id: match.actor.actor_id,
          display_name: match.actor.display_name_zh_cn,
          source: match.source,
          review_type: null,
        });
      }

      const actors = [...actorMatches.values()]
        .sort(compareActorMatches)
        .map(formatActor);
      const displayActors = actors
        .filter((actor) => actor.display_enabled)
        .slice(0, actorDictionaryConfig.rules.max_display_actors_per_video);
      const violations = [];

      if (actors.length > actorDictionaryConfig.rules.max_actors_per_video) {
        violations.push({
          code: "max_actors_per_video_exceeded",
          actual: actors.length,
          limit: actorDictionaryConfig.rules.max_actors_per_video,
        });
      }

      return {
        ruleset_version: versionConfig.release.version,
        raw_actors: [...rawActors],
        actors,
        display_actors: displayActors,
        reviews: [...reviews.values()],
        decisions,
        violations,
      };
    },
  });
}

function buildValueIndex({ actorIndex, aliasConfig }) {
  const valueIndex = new Map();

  for (const actor of actorIndex.values()) {
    for (const alias of actor.aliases) {
      if (alias.status !== APPROVED_STATUS) {
        continue;
      }
      addValueMatch(valueIndex, alias.normalized_value, {
        actor,
        source: "actor_dictionary",
      });
    }
  }

  for (const alias of aliasConfig.items) {
    if (
      alias.status !== APPROVED_STATUS ||
      alias.alias_type !== "actor" ||
      alias.target_type !== "actor"
    ) {
      continue;
    }

    const actor = actorIndex.get(alias.target_id);
    if (!actor) {
      continue;
    }
    addValueMatch(valueIndex, alias.normalized_value, {
      actor,
      source: "global_alias",
    });
  }

  return valueIndex;
}

function addValueMatch(valueIndex, value, match) {
  const normalizedValue = normalizeValue(value);
  const matches = valueIndex.get(normalizedValue) ?? [];
  matches.push(match);
  valueIndex.set(normalizedValue, matches);
}

function deduplicateMatches(matches) {
  const deduplicated = new Map();
  for (const match of matches) {
    const existing = deduplicated.get(match.actor.actor_id);
    if (!existing || match.source === "global_alias") {
      deduplicated.set(match.actor.actor_id, match);
    }
  }
  return [...deduplicated.values()];
}

function addActorMatch(actorMatches, actor, match) {
  const existing = actorMatches.get(actor.actor_id);
  if (existing) {
    existing.matchedRawValues.push(match.rawValue);
    existing.matchedInputIndexes.push(match.inputIndex);
    existing.matchSources.push(match.source);
    return;
  }

  actorMatches.set(actor.actor_id, {
    actor,
    firstInputIndex: match.inputIndex,
    matchedRawValues: [match.rawValue],
    matchedInputIndexes: [match.inputIndex],
    matchSources: [match.source],
  });
}

function formatActor(match) {
  return {
    actor_id: match.actor.actor_id,
    display_name: match.actor.display_name_zh_cn,
    display_enabled: match.actor.display_enabled,
    search_enabled: match.actor.search_enabled,
    matched_raw_values: unique(match.matchedRawValues),
    matched_input_indexes: unique(match.matchedInputIndexes),
    match_sources: unique(match.matchSources),
  };
}

function compareActorMatches(left, right) {
  return (
    left.firstInputIndex - right.firstInputIndex ||
    left.actor.display_name_zh_cn.localeCompare(
      right.actor.display_name_zh_cn,
      "zh-CN",
    )
  );
}

function addReview(reviews, reviewRules, reviewType, values) {
  const rule = reviewRules.get(reviewType);
  if (!rule) {
    throw new Error(`enabled review rule ${reviewType} is required`);
  }

  const key = `${reviewType}:${values.normalizedValues.join("|")}`;
  const existing = reviews.get(key);
  if (existing) {
    existing.raw_values = unique([
      ...existing.raw_values,
      ...values.rawValues,
    ]);
    existing.normalized_values = unique([
      ...existing.normalized_values,
      ...values.normalizedValues,
    ]);
    return existing;
  }

  const review = {
    review_type: reviewType,
    status: rule.default_status,
    trigger: rule.auto_create_when,
    subject_type: reviewType === "pending_actor" ? "actor" : "alias",
    raw_values: unique(values.rawValues),
    normalized_values: unique(values.normalizedValues),
    allow_ai_suggestion: rule.allow_ai_suggestion,
    allow_auto_approve: rule.allow_auto_approve,
    required_reviewer_role: rule.required_reviewer_role,
  };
  reviews.set(key, review);
  return review;
}

function assertRawActors(rawActors) {
  if (!Array.isArray(rawActors)) {
    throw new TypeError("rawActors must be an array");
  }
  for (const [index, value] of rawActors.entries()) {
    if (typeof value !== "string") {
      throw new TypeError(`rawActors[${index}] must be a string`);
    }
  }
}

function assertConfig(config, name) {
  if (!config || typeof config !== "object") {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertRuntimeRules(actorDictionaryConfig) {
  const rules = actorDictionaryConfig.rules;
  if (rules.allow_ai_translate_actor !== false) {
    throw new Error("actor normalizer requires allow_ai_translate_actor=false");
  }
  if (rules.allow_ai_create_actor !== false) {
    throw new Error("actor normalizer requires allow_ai_create_actor=false");
  }
  if (rules.unknown_actor_action !== "review") {
    throw new Error("actor normalizer requires unknown actor review");
  }
}

function unique(values) {
  return [...new Set(values)];
}
