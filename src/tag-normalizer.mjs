import { normalizeValue } from "./value-normalizer.mjs";

const APPROVED_STATUS = "approved";
const MATCH_MODE_RANK = {
  exact: 5,
  normalize: 5,
  prefix: 4,
  contains: 3,
  regex: 2,
};

export function createTagNormalizer({
  aliasConfig,
  categoryConfig,
  ignoredConfig,
  reviewRulesConfig,
  tagDictionaryConfig,
  versionConfig,
}) {
  assertConfig(aliasConfig, "aliasConfig");
  assertConfig(categoryConfig, "categoryConfig");
  assertConfig(ignoredConfig, "ignoredConfig");
  assertConfig(reviewRulesConfig, "reviewRulesConfig");
  assertConfig(tagDictionaryConfig, "tagDictionaryConfig");
  assertConfig(versionConfig, "versionConfig");
  assertRuntimeRules(categoryConfig, tagDictionaryConfig);

  const categories = indexApprovedEntities(
    categoryConfig.items,
    "category_id",
  );
  const tags = indexApprovedEntities(tagDictionaryConfig.items, "tag_id");
  const valueMatchers = buildValueMatchers({
    aliasConfig,
    categories,
    tags,
  });
  const ignoredMatchers = buildIgnoredMatchers(ignoredConfig);
  const reviewRules = indexReviewRules(reviewRulesConfig);
  const tagComparator = buildTagComparator(tagDictionaryConfig.rules.sort_by);

  return Object.freeze({
    normalize(rawTags) {
      return normalizeTags({
        ignoredMatchers,
        rawTags,
        reviewRules,
        tagComparator,
        tagDictionaryConfig,
        valueMatchers,
        versionConfig,
      });
    },
  });
}

function normalizeTags({
  ignoredMatchers,
  rawTags,
  reviewRules,
  tagComparator,
  tagDictionaryConfig,
  valueMatchers,
  versionConfig,
}) {
  assertRawTags(rawTags);

  const categoryMatches = new Map();
  const tagMatches = new Map();
  const ignoredTags = [];
  let ignoredCategoryDecision = false;
  const reviews = new Map();
  const decisions = [];

  for (const [inputIndex, rawValue] of rawTags.entries()) {
    const normalizedValue = normalizeValue(rawValue);
    if (!normalizedValue) {
      throw new TypeError(`rawTags[${inputIndex}] must not be blank`);
    }

    const ignoredMatch = findBestMatch(
      ignoredMatchers,
      rawValue,
      normalizedValue,
    );
    if (ignoredMatch) {
      if (ignoredMatch.target.scope.includes("category")) {
        ignoredCategoryDecision = true;
      }
      ignoredTags.push({
        input_index: inputIndex,
        raw_value: rawValue,
        normalized_value: normalizedValue,
        ignore_id: ignoredMatch.referenceId,
        reason: ignoredMatch.reason,
      });
      decisions.push(
        createDecision({
          displayName: null,
          inputIndex,
          normalizedValue,
          outcome: "ignored",
          rawValue,
          referenceId: ignoredMatch.referenceId,
          reviewType: null,
          source: "ignored",
        }),
      );
      continue;
    }

    const matches = findTopValueMatches(
      valueMatchers,
      rawValue,
      normalizedValue,
    );
    if (matches.length === 0) {
      const review = addReview(reviews, reviewRules, {
        normalizedValues: [normalizedValue],
        rawValues: [rawValue],
        subjectType: "tag",
        trigger: "tag_not_found_in_dictionary",
      });
      decisions.push(
        createDecision({
          displayName: null,
          inputIndex,
          normalizedValue,
          outcome: "pending_review",
          rawValue,
          referenceId: null,
          reviewType: review.review_type,
          source: null,
        }),
      );
      continue;
    }

    if (
      matches.length > 1 &&
      matches.every((match) => match.targetType === "category")
    ) {
      const orderedMatches = [...matches].sort(compareCategoryMatches);
      for (const categoryMatch of orderedMatches) {
        addEntityMatch(categoryMatches, categoryMatch.target, {
          inputIndex,
          rawValue,
          source: categoryMatch.source,
        });
      }

      const selectedMatch = orderedMatches[0];
      decisions.push(
        createDecision({
          displayName: selectedMatch.target.display_name,
          inputIndex,
          normalizedValue,
          outcome: "category_candidate",
          rawValue,
          referenceId: selectedMatch.target.category_id,
          reviewType: null,
          source: selectedMatch.source,
        }),
      );
      continue;
    }

    if (matches.length > 1) {
      const review = addReview(reviews, reviewRules, {
        normalizedValues: [normalizedValue],
        rawValues: [rawValue],
        subjectType: "alias",
        trigger: "alias_candidate_detected",
      });
      decisions.push(
        createDecision({
          displayName: null,
          inputIndex,
          normalizedValue,
          outcome: "pending_review",
          rawValue,
          referenceId: null,
          reviewType: review.review_type,
          source: null,
        }),
      );
      continue;
    }

    const match = matches[0];
    if (match.targetType === "tag") {
      addEntityMatch(tagMatches, match.target, {
        inputIndex,
        rawValue,
        source: match.source,
      });
      decisions.push(
        createDecision({
          displayName: match.target.display_name,
          inputIndex,
          normalizedValue,
          outcome: "standard_tag",
          rawValue,
          referenceId: match.target.tag_id,
          reviewType: null,
          source: match.source,
        }),
      );
      continue;
    }

    addEntityMatch(categoryMatches, match.target, {
      inputIndex,
      rawValue,
      source: match.source,
    });
    decisions.push(
      createDecision({
        displayName: match.target.display_name,
        inputIndex,
        normalizedValue,
        outcome: "category_candidate",
        rawValue,
        referenceId: match.target.category_id,
        reviewType: null,
        source: match.source,
      }),
    );
  }

  const categoryCandidates = [...categoryMatches.values()]
    .map(formatCategory)
    .sort(compareCategories);
  const selectedCategory = categoryCandidates[0] ?? null;

  if (!selectedCategory && !ignoredCategoryDecision) {
    addReview(reviews, reviewRules, {
      normalizedValues: rawTags.map(normalizeValue),
      rawValues: rawTags,
      subjectType: "category",
      trigger: "category_not_resolved",
    });
  }

  const standardTags = [...tagMatches.values()]
    .map(formatTag)
    .sort(tagComparator);
  const displayTags = standardTags
    .filter((tag) => tag.display_enabled)
    .slice(0, tagDictionaryConfig.rules.max_display_tags_per_video);
  const violations = [];

  if (standardTags.length > tagDictionaryConfig.rules.max_tags_per_video) {
    violations.push({
      code: "max_tags_per_video_exceeded",
      actual: standardTags.length,
      limit: tagDictionaryConfig.rules.max_tags_per_video,
    });
  }

  return {
    ruleset_version: versionConfig.release.version,
    raw_tags: [...rawTags],
    selected_category: selectedCategory,
    category_candidates: categoryCandidates,
    standard_tags: standardTags,
    display_tags: displayTags,
    ignored_tags: ignoredTags,
    reviews: [...reviews.values()],
    decisions,
    violations,
  };
}

function buildValueMatchers({
  aliasConfig,
  categories,
  tags,
}) {
  const matchers = [];

  for (const category of categories.values()) {
    for (const normalizedAlias of category.normalized_aliases) {
      matchers.push(
        createMatcher({
          matchMode: "exact",
          pattern: normalizedAlias,
          rawPattern: normalizedAlias,
          referenceId: category.category_id,
          source: "category_dictionary",
          target: category,
          targetType: "category",
        }),
      );
    }
  }

  for (const tag of tags.values()) {
    for (const normalizedAlias of tag.normalized_aliases) {
      matchers.push(
        createMatcher({
          matchMode: "exact",
          pattern: normalizedAlias,
          rawPattern: normalizedAlias,
          referenceId: tag.tag_id,
          source: "tag_dictionary",
          target: tag,
          targetType: "tag",
        }),
      );
    }
  }

  for (const alias of aliasConfig.items) {
    if (
      alias.status !== APPROVED_STATUS ||
      !["category", "tag"].includes(alias.alias_type)
    ) {
      continue;
    }

    const targetIndex = alias.alias_type === "category" ? categories : tags;
    const target = targetIndex.get(alias.target_id);
    if (!target) {
      throw new Error(
        `approved alias ${alias.alias_id} points to an unavailable target`,
      );
    }

    matchers.push(
      createMatcher({
        matchMode: alias.match_mode,
        pattern: alias.normalized_value,
        rawPattern: alias.raw_value,
        referenceId: alias.alias_id,
        source: "global_alias",
        target,
        targetType: alias.alias_type,
      }),
    );
  }

  return matchers;
}

function buildIgnoredMatchers(ignoredConfig) {
  return ignoredConfig.items
    .filter(
      (item) =>
        item.status === APPROVED_STATUS &&
        (item.scope.includes("tag") || item.scope.includes("category")),
    )
    .map((item) =>
      createMatcher({
        matchMode: item.match_mode,
        pattern: item.normalized_value,
        rawPattern: item.value,
        reason: item.reason,
        referenceId: item.ignore_id,
        source: "ignored",
        target: item,
        targetType: "ignored",
      }),
    );
}

function createMatcher({
  matchMode,
  pattern,
  rawPattern,
  reason = null,
  referenceId,
  source,
  target,
  targetType,
}) {
  const rank = MATCH_MODE_RANK[matchMode];
  if (!rank) {
    throw new Error(`unsupported match mode: ${matchMode}`);
  }

  return {
    matchMode,
    pattern,
    rank,
    rawPattern,
    reason,
    referenceId,
    regex: matchMode === "regex" ? new RegExp(rawPattern, "u") : null,
    source,
    target,
    targetType,
  };
}

function findBestMatch(matchers, rawValue, normalizedValue) {
  return matchers
    .filter((matcher) => matchesValue(matcher, rawValue, normalizedValue))
    .sort(compareMatchers)[0];
}

function findTopValueMatches(matchers, rawValue, normalizedValue) {
  const matches = matchers
    .filter((matcher) => matchesValue(matcher, rawValue, normalizedValue))
    .sort(compareMatchers);
  const highestRank = matches[0]?.rank;
  if (!highestRank) {
    return [];
  }

  const uniqueTargets = new Map();
  for (const match of matches) {
    if (match.rank !== highestRank) {
      break;
    }
    const key = `${match.targetType}:${entityId(match.targetType, match.target)}`;
    if (!uniqueTargets.has(key)) {
      uniqueTargets.set(key, match);
    }
  }
  return [...uniqueTargets.values()];
}

function matchesValue(matcher, rawValue, normalizedValue) {
  switch (matcher.matchMode) {
    case "exact":
    case "normalize":
      return normalizedValue === matcher.pattern;
    case "prefix":
      return normalizedValue.startsWith(matcher.pattern);
    case "contains":
      return normalizedValue.includes(matcher.pattern);
    case "regex":
      return matcher.regex.test(rawValue) || matcher.regex.test(normalizedValue);
    default:
      return false;
  }
}

function compareMatchers(left, right) {
  return (
    right.rank - left.rank ||
    right.pattern.length - left.pattern.length ||
    compareStrings(left.referenceId, right.referenceId)
  );
}

function addEntityMatch(index, entity, { inputIndex, rawValue, source }) {
  const id = entity.tag_id ?? entity.category_id;
  const existing = index.get(id) ?? {
    entity,
    matchedInputIndexes: [],
    matchedRawValues: [],
    matchSources: [],
  };

  addUnique(existing.matchedInputIndexes, inputIndex);
  addUnique(existing.matchedRawValues, rawValue);
  addUnique(existing.matchSources, source);
  index.set(id, existing);
}

function formatTag({
  entity,
  matchedInputIndexes,
  matchedRawValues,
  matchSources,
}) {
  return {
    tag_id: entity.tag_id,
    display_name: entity.display_name,
    slug: entity.slug,
    tag_group: entity.category,
    weight: entity.weight,
    display_enabled: entity.display_enabled,
    search_enabled: entity.search_enabled,
    matched_raw_values: matchedRawValues,
    matched_input_indexes: matchedInputIndexes,
    match_sources: matchSources,
  };
}

function formatCategory({
  entity,
  matchedInputIndexes,
  matchedRawValues,
  matchSources,
}) {
  return {
    category_id: entity.category_id,
    display_name: entity.display_name,
    slug: entity.slug,
    priority: entity.priority,
    matched_raw_values: matchedRawValues,
    matched_input_indexes: matchedInputIndexes,
    match_sources: matchSources,
  };
}

function addReview(
  reviewIndex,
  reviewRules,
  { normalizedValues, rawValues, subjectType, trigger },
) {
  const definition = reviewRules.get(trigger);
  if (!definition) {
    throw new Error(`no enabled review rule for trigger: ${trigger}`);
  }

  const normalizedKey = [...new Set(normalizedValues)].sort().join("\0");
  const key = `${definition.type}:${subjectType}:${normalizedKey}`;
  const existing = reviewIndex.get(key) ?? {
    review_type: definition.type,
    status: definition.default_status,
    trigger,
    subject_type: subjectType,
    raw_values: [],
    normalized_values: [],
    allow_ai_suggestion: definition.allow_ai_suggestion,
    allow_auto_approve: definition.allow_auto_approve,
    required_reviewer_role: definition.required_reviewer_role,
  };

  for (const rawValue of rawValues) {
    addUnique(existing.raw_values, rawValue);
  }
  for (const normalizedValue of normalizedValues) {
    addUnique(existing.normalized_values, normalizedValue);
  }
  reviewIndex.set(key, existing);
  return existing;
}

function indexReviewRules(reviewRulesConfig) {
  return new Map(
    reviewRulesConfig.review_types
      .filter((rule) => rule.enabled)
      .map((rule) => [rule.auto_create_when, rule]),
  );
}

function indexApprovedEntities(items, idField) {
  return new Map(
    items
      .filter((item) => item.status === APPROVED_STATUS)
      .map((item) => [item[idField], item]),
  );
}

function buildTagComparator(sortBy) {
  const comparators = sortBy.map((rule) => {
    if (rule === "weight_desc") {
      return (left, right) => right.weight - left.weight;
    }
    if (rule === "display_name_asc") {
      return (left, right) =>
        compareStrings(left.display_name, right.display_name);
    }
    throw new Error(`unsupported tag sort rule: ${rule}`);
  });

  return (left, right) => {
    for (const comparator of comparators) {
      const result = comparator(left, right);
      if (result !== 0) {
        return result;
      }
    }
    return compareStrings(left.tag_id, right.tag_id);
  };
}

function compareCategories(left, right) {
  return (
    right.priority - left.priority ||
    compareStrings(left.display_name, right.display_name) ||
    compareStrings(left.category_id, right.category_id)
  );
}

function compareCategoryMatches(left, right) {
  return (
    right.target.priority - left.target.priority ||
    compareStrings(left.target.display_name, right.target.display_name) ||
    compareStrings(left.target.category_id, right.target.category_id)
  );
}

function createDecision({
  displayName,
  inputIndex,
  normalizedValue,
  outcome,
  rawValue,
  referenceId,
  reviewType,
  source,
}) {
  return {
    input_index: inputIndex,
    raw_value: rawValue,
    normalized_value: normalizedValue,
    outcome,
    reference_id: referenceId,
    display_name: displayName,
    source,
    review_type: reviewType,
  };
}

function entityId(targetType, target) {
  return targetType === "category" ? target.category_id : target.tag_id;
}

function assertConfig(config, name) {
  if (!config || typeof config !== "object") {
    throw new TypeError(`${name} is required`);
  }
}

function assertRawTags(rawTags) {
  if (!Array.isArray(rawTags)) {
    throw new TypeError("rawTags must be an array");
  }
  if (rawTags.length === 0) {
    throw new TypeError("rawTags must contain at least one tag");
  }
  for (const [index, value] of rawTags.entries()) {
    if (typeof value !== "string") {
      throw new TypeError(`rawTags[${index}] must be a string`);
    }
  }
}

function assertRuntimeRules(categoryConfig, tagDictionaryConfig) {
  const categoryRules = categoryConfig.classification_rules;
  if (categoryRules.allow_multiple_categories) {
    throw new Error("tag normalizer requires one selected category");
  }
  if (categoryRules.fallback_category !== null) {
    throw new Error("tag normalizer does not support fallback categories");
  }
  if (categoryRules.on_no_match !== "review") {
    throw new Error("tag normalizer requires category review on no match");
  }
  if (categoryRules.on_multiple_match !== "use_highest_priority") {
    throw new Error("unsupported category multiple-match rule");
  }
  if (categoryRules.store_all_candidates !== true) {
    throw new Error("tag normalizer requires all category candidates");
  }
  if (tagDictionaryConfig.rules.allow_ai_create_tag !== false) {
    throw new Error("tag normalizer requires allow_ai_create_tag=false");
  }
  if (tagDictionaryConfig.rules.unknown_tag_action !== "review") {
    throw new Error("tag normalizer requires unknown tag review");
  }
}

function addUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
