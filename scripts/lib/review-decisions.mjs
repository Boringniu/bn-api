import { normalizeValue } from "../../src/value-normalizer.mjs";

const DECISION_APPROVE = "1";
const DECISION_REJECT = "2";
const SUPPORTED_APPROVAL_TYPES = new Set(["pending_actor", "pending_tag"]);

export function validateDecisionRows(rows) {
  const failures = [];
  if (!Array.isArray(rows)) {
    return ["review-decisions.json must contain a JSON array"];
  }

  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (
      !Array.isArray(row) ||
      ![2, 3].includes(row.length) ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "string" ||
      (row.length === 3 && typeof row[2] !== "string")
    ) {
      failures.push(
        `row ${index + 1} must be ["term", "1"], ["term", "1", "target"] or ["term", "2"]`,
      );
      continue;
    }
    const term = row[0].trim();
    if (!term) {
      failures.push(`row ${index + 1} has an empty term`);
      continue;
    }
    if (![DECISION_APPROVE, DECISION_REJECT].includes(row[1])) {
      failures.push(`row ${index + 1} decision must be "1" or "2"`);
    }
    if (row.length === 3) {
      if (row[1] !== DECISION_APPROVE) {
        failures.push(`row ${index + 1} can only use a target with decision "1"`);
      }
      if (!row[2].trim()) {
        failures.push(`row ${index + 1} has an empty target`);
      }
    }
    const normalized = normalizeValue(term);
    if (seen.has(normalized)) {
      failures.push(`row ${index + 1} duplicates term "${term}"`);
    }
    seen.add(normalized);
  }
  return failures;
}

export function applyReviewDecisions({
  actorConfig,
  decisions,
  ignoredConfig,
  reviewItems,
  tagConfig,
  timestamp,
  versionConfig,
}) {
  const failures = validateDecisionRows(decisions);
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  const changed = new Set();
  const applied = [];
  for (const [term, decision, target] of decisions) {
    const normalized = normalizeValue(term);
    const matching = reviewItems.filter((item) =>
      (item.raw_values ?? []).some(
        (value) => normalizeValue(value) === normalized,
      ),
    );
    if (matching.length === 0) {
      throw new Error(`"${term}" was not found in the production pending queue`);
    }

    if (decision === DECISION_REJECT) {
      const scopes = ignoredScopes(matching);
      addIgnoredValue(ignoredConfig, {
        scopes,
        term,
        timestamp,
      });
      changed.add("ignored");
      applied.push({ decision, term, outcome: `ignored:${scopes.join("+")}` });
      continue;
    }

    const approvalTypes = unique(
      matching
        .map((item) => item.review_type)
        .filter((type) => SUPPORTED_APPROVAL_TYPES.has(type)),
    );
    if (approvalTypes.length !== 1) {
      throw new Error(
        `"${term}" cannot be safely approved: expected one actor/tag type, got ${approvalTypes.join(", ") || "none"}`,
      );
    }

    if (approvalTypes[0] === "pending_actor") {
      const outcome = approveActor(actorConfig, term, timestamp, target);
      changed.add("actor_dictionary");
      applied.push({ decision, term, outcome });
    } else {
      const outcome = approveTag(tagConfig, term, timestamp, target);
      changed.add("tag_dictionary");
      applied.push({ decision, term, outcome });
    }
  }

  if (changed.size === 0) {
    return { applied, changed: [], version: versionConfig.release.version };
  }

  const nextVersion = bumpPatch(versionConfig.release.version);
  for (const name of changed) {
    const config =
      name === "actor_dictionary"
        ? actorConfig
        : name === "tag_dictionary"
          ? tagConfig
          : ignoredConfig;
    config.config_version = nextVersion;
    config.updated_at = timestamp;
    config.updated_by = "github-actions";
    versionConfig.files[name] = nextVersion;
  }
  versionConfig.config_version = nextVersion;
  versionConfig.updated_at = timestamp;
  versionConfig.updated_by = "github-actions";
  versionConfig.release = {
    version: nextVersion,
    release_date: timestamp.slice(0, 10),
    description: `应用 ${decisions.length} 条人工审核决定`,
  };

  return { applied, changed: [...changed], version: nextVersion };
}

function approveActor(config, term, timestamp, targetTerm = null) {
  const normalized = normalizeValue(term);
  const candidates = targetTerm
    ? findExactActors(config, targetTerm)
    : config.items.filter((actor) =>
        actor.aliases.some((alias) => {
          const value = alias.normalized_value;
          return value.startsWith(normalized) || normalized.startsWith(value);
        }),
      );
  if (candidates.length > 1) {
    throw new Error(
      `"${targetTerm ?? term}" matches multiple actors: ${candidates.map((item) => item.display_name_zh_cn).join(", ")}`,
    );
  }
  if (targetTerm && candidates.length === 0) {
    throw new Error(`actor target "${targetTerm}" does not exist`);
  }
  if (candidates.length === 1) {
    const actor = candidates[0];
    if (!actor.aliases.some((alias) => alias.normalized_value === normalized)) {
      actor.aliases.push({
        value: term,
        normalized_value: normalized,
        language: "unknown",
        status: "approved",
        source: "review-decisions",
      });
      actor.updated_at = timestamp;
    }
    return `actor_alias:${actor.actor_id}`;
  }

  const actorId = nextNumericId(config.items, "actor_id", "actor");
  config.items.push({
    actor_id: actorId,
    display_name_zh_cn: term,
    name_ja: null,
    name_en: null,
    romanized_name: null,
    status: "approved",
    display_enabled: true,
    search_enabled: true,
    aliases: [
      {
        value: term,
        normalized_value: normalized,
        language: "unknown",
        status: "approved",
        source: "review-decisions",
      },
    ],
    notes: "由 review-decisions.json 人工批准",
    created_at: timestamp,
    updated_at: timestamp,
  });
  return `actor_created:${actorId}`;
}

function approveTag(config, term, timestamp, targetTerm = null) {
  const normalized = normalizeValue(term);
  const candidates = targetTerm
    ? findExactTags(config, targetTerm)
    : config.items.filter(
        (tag) =>
          tag.status === "approved" &&
          tag.normalized_aliases.some(
            (value) =>
              value.startsWith(normalized) || normalized.startsWith(value),
          ),
      );
  if (candidates.length > 1) {
    throw new Error(
      `"${targetTerm ?? term}" matches multiple tags: ${candidates.map((item) => item.display_name).join(", ")}`,
    );
  }
  if (targetTerm && candidates.length === 0) {
    throw new Error(`tag target "${targetTerm}" does not exist`);
  }
  if (candidates.length === 1) {
    const tag = candidates[0];
    if (!tag.normalized_aliases.includes(normalized)) {
      tag.aliases.push(term);
      tag.normalized_aliases.push(normalized);
      tag.updated_at = timestamp;
    }
    return `tag_alias:${tag.tag_id}`;
  }

  const tagId = nextManualTagId(config.items);
  const suffix = tagId.slice("tag_manual_".length);
  config.items.push({
    tag_id: tagId,
    display_name: term,
    slug: `manual-${suffix}`,
    status: "approved",
    display_enabled: true,
    search_enabled: true,
    weight: 50,
    category: "other",
    aliases: [term],
    normalized_aliases: [normalized],
    description: "由 review-decisions.json 人工批准",
    created_at: timestamp,
    updated_at: timestamp,
  });
  return `tag_created:${tagId}`;
}

function addIgnoredValue(config, { scopes, term, timestamp }) {
  const normalized = normalizeValue(term);
  const existing = config.items.find(
    (item) => item.normalized_value === normalized,
  );
  if (existing) {
    existing.scope = unique([...existing.scope, ...scopes]);
    existing.status = "approved";
    return;
  }
  config.items.push({
    ignore_id: nextNumericId(config.items, "ignore_id", "ignore"),
    value: term,
    normalized_value: normalized,
    scope: scopes,
    match_mode: "exact",
    reason: "由 review-decisions.json 人工否定",
    status: "approved",
    created_at: timestamp,
  });
}

function ignoredScopes(reviewItems) {
  const scopes = new Set();
  const supported = new Set([
    "pending_actor",
    "pending_category",
    "pending_tag",
  ]);
  const types = unique(reviewItems.map((item) => item.review_type));
  if (!types.some((type) => supported.has(type))) {
    throw new Error(
      `cannot reject unsupported review types: ${types.join(", ")}`,
    );
  }
  for (const item of reviewItems) {
    if (item.review_type === "pending_actor") {
      scopes.add("actor");
    } else if (item.review_type === "pending_category") {
      scopes.add("category");
      scopes.add("tag");
    } else if (item.review_type === "pending_tag") {
      scopes.add("tag");
    }
  }
  return [...scopes].sort();
}

function nextNumericId(items, field, prefix) {
  const maximum = items.reduce((max, item) => {
    const match = String(item[field] ?? "").match(/(\d+)$/u);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return `${prefix}_${String(maximum + 1).padStart(6, "0")}`;
}

function nextManualTagId(items) {
  const maximum = items.reduce((max, item) => {
    const match = item.tag_id.match(/^tag_manual_(\d+)$/u);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return `tag_manual_${String(maximum + 1).padStart(6, "0")}`;
}

function findExactActors(config, targetTerm) {
  const normalized = normalizeValue(targetTerm);
  return config.items.filter(
    (actor) =>
      actor.status === "approved" &&
      (normalizeValue(actor.display_name_zh_cn) === normalized ||
        actor.aliases.some((alias) => alias.normalized_value === normalized)),
  );
}

function findExactTags(config, targetTerm) {
  const normalized = normalizeValue(targetTerm);
  return config.items.filter(
    (tag) =>
      tag.status === "approved" &&
      (normalizeValue(tag.display_name) === normalized ||
        tag.normalized_aliases.includes(normalized)),
  );
}

function bumpPatch(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function unique(values) {
  return [...new Set(values)];
}
