import { normalizeCode } from "./code-normalizer.mjs";
import { normalizeValue } from "./value-normalizer.mjs";

const MEDIA_SELECT_SQL = `
  SELECT id, status
  FROM media
  WHERE source_provider = ? AND source_external_id = ?
  LIMIT 1
`;

const MEDIA_UPSERT_SQL = `
  INSERT INTO media (
    id,
    source_provider,
    source_external_id,
    source_url,
    code,
    normalized_code,
    title,
    normalized_title,
    description,
    release_date,
    year,
    duration_seconds,
    cover_url,
    subtitle,
    category_id,
    status,
    ruleset_version,
    raw_payload_json,
    normalization_json,
    metadata_json,
    created_at,
    updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
  ON CONFLICT (source_provider, source_external_id) DO UPDATE SET
    source_url = excluded.source_url,
    code = excluded.code,
    normalized_code = excluded.normalized_code,
    title = excluded.title,
    normalized_title = excluded.normalized_title,
    description = COALESCE(NULLIF(trim(excluded.description), ''), media.description),
    release_date = excluded.release_date,
    year = excluded.year,
    duration_seconds = excluded.duration_seconds,
    cover_url = excluded.cover_url,
    subtitle = excluded.subtitle,
    category_id = excluded.category_id,
    status = CASE
      WHEN media.status IN ('rejected', 'disabled') THEN media.status
      ELSE excluded.status
    END,
    ruleset_version = excluded.ruleset_version,
    raw_payload_json = excluded.raw_payload_json,
    normalization_json = excluded.normalization_json,
    metadata_json = excluded.metadata_json,
    updated_at = excluded.updated_at
`;

export function createIngestService({
  actorNormalizer,
  mediaInputParser,
  reviewRulesConfig,
  searchConfig,
  tagNormalizer,
  versionConfig,
  now = () => new Date(),
}) {
  const reviewRules = new Map(
    reviewRulesConfig.review_types
      .filter((rule) => rule.enabled)
      .map((rule) => [rule.type, rule]),
  );

  return Object.freeze({
    async ingest(db, rawInput) {
      assertDatabase(db);
      const input = mediaInputParser.parse(rawInput);
      const tagResult = tagNormalizer.normalize(input.raw_tags);
      const actorResult = actorNormalizer.normalize(input.actors);
      const codeResult = normalizeCodeWithReview({
        code: input.code,
        reviewRules,
        searchConfig,
      });
      const reviews = [
        ...tagResult.reviews,
        ...actorResult.reviews,
        ...(codeResult?.review ? [codeResult.review] : []),
        ...createViolationReviews([
          ...tagResult.violations,
          ...actorResult.violations,
        ]),
      ];
      const derivedStatus = reviews.length > 0 ? "pending" : "approved";
      const timestamp = now().toISOString();
      const derivedMediaId = await stableId("media", [
        input.source.provider,
        input.source.external_id,
      ]);
      const existing = await db
        .prepare(MEDIA_SELECT_SQL)
        .bind(input.source.provider, input.source.external_id)
        .first();
      const mediaId = existing?.id ?? derivedMediaId;
      const outcome = existing ? "updated" : "created";
      const status = isTerminalMediaStatus(existing?.status)
        ? existing.status
        : derivedStatus;
      const subtitle =
        input.subtitle ??
        tagResult.standard_tags.some(
          (tag) => tag.tag_id === "tag_chinese_subtitle",
        );
      const normalization = {
        actors: actorResult,
        code: codeResult,
        tags: tagResult,
      };
      const payloadHash = await sha256Hex(stableJson(rawInput));
      const statements = [
        db.prepare(MEDIA_UPSERT_SQL).bind(
          mediaId,
          input.source.provider,
          input.source.external_id,
          input.source.url ?? null,
          input.code,
          codeResult?.normalized_code ?? null,
          input.title,
          normalizeValue(input.title),
          input.description,
          input.release_date,
          input.year,
          input.duration_seconds,
          input.cover_url,
          subtitle ? 1 : 0,
          tagResult.selected_category?.category_id ?? null,
          derivedStatus,
          versionConfig.release.version,
          JSON.stringify(rawInput),
          JSON.stringify(normalization),
          JSON.stringify(input.metadata),
          timestamp,
          timestamp,
        ),
        db.prepare("DELETE FROM media_category_candidates WHERE media_id = ?")
          .bind(mediaId),
        db.prepare("DELETE FROM media_actors WHERE media_id = ?").bind(mediaId),
        db.prepare("DELETE FROM media_tags WHERE media_id = ?").bind(mediaId),
        db.prepare(
          "DELETE FROM review_items WHERE media_id = ? AND status = 'pending' AND origin = 'ingest'",
        ).bind(mediaId),
        ...tagResult.category_candidates.map((category) =>
          db.prepare(`
            INSERT INTO media_category_candidates (
              media_id,
              category_id,
              display_name_snapshot,
              priority,
              is_selected,
              matched_raw_values_json,
              match_sources_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mediaId,
            category.category_id,
            category.display_name,
            category.priority,
            category.category_id === tagResult.selected_category?.category_id
              ? 1
              : 0,
            JSON.stringify(category.matched_raw_values),
            JSON.stringify(category.match_sources),
          ),
        ),
        ...actorResult.actors.map((actor, position) =>
          db.prepare(`
            INSERT INTO media_actors (
              media_id,
              actor_id,
              position,
              display_name_snapshot,
              display_enabled,
              search_enabled,
              matched_raw_values_json,
              match_sources_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mediaId,
            actor.actor_id,
            position,
            actor.display_name,
            actor.display_enabled ? 1 : 0,
            actor.search_enabled ? 1 : 0,
            JSON.stringify(actor.matched_raw_values),
            JSON.stringify(actor.match_sources),
          ),
        ),
        ...tagResult.standard_tags.map((tag) =>
          db.prepare(`
            INSERT INTO media_tags (
              media_id,
              tag_id,
              display_name_snapshot,
              tag_group,
              weight,
              display_enabled,
              search_enabled,
              matched_raw_values_json,
              match_sources_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            mediaId,
            tag.tag_id,
            tag.display_name,
            tag.tag_group,
            tag.weight,
            tag.display_enabled ? 1 : 0,
            tag.search_enabled ? 1 : 0,
            JSON.stringify(tag.matched_raw_values),
            JSON.stringify(tag.match_sources),
          ),
        ),
        ...createReviewStatements({
          db,
          mediaId,
          reviews,
          timestamp,
        }),
        db.prepare(`
          INSERT INTO ingest_events (
            media_id,
            source_provider,
            source_external_id,
            outcome,
            media_status,
            payload_hash,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          mediaId,
          input.source.provider,
          input.source.external_id,
          outcome,
          status,
          payloadHash,
          timestamp,
        ),
      ];

      await db.batch(statements);

      return {
        id: mediaId,
        outcome,
        status,
        ruleset_version: versionConfig.release.version,
        code: codeResult,
        category: tagResult.selected_category,
        actors: actorResult.display_actors,
        tags: tagResult.display_tags,
        reviews,
      };
    },
  });
}

function normalizeCodeWithReview({ code, reviewRules, searchConfig }) {
  if (!code) {
    return null;
  }

  const result = normalizeCode(code, searchConfig);
  if (result.is_valid) {
    return result;
  }

  const rule = reviewRules.get("possible_code");
  if (!rule) {
    throw new Error("enabled review rule possible_code is required");
  }

  return {
    ...result,
    review: {
      review_type: rule.type,
      status: rule.default_status,
      trigger: rule.auto_create_when,
      subject_type: "code",
      raw_values: [code],
      normalized_values: [result.normalized_code],
      allow_ai_suggestion: rule.allow_ai_suggestion,
      allow_auto_approve: rule.allow_auto_approve,
      required_reviewer_role: rule.required_reviewer_role,
    },
  };
}

function createViolationReviews(violations) {
  return violations.map((violation) => ({
    review_type: "rule_violation",
    status: "pending",
    trigger: violation.code,
    subject_type: "media",
    raw_values: [],
    normalized_values: [],
    allow_ai_suggestion: false,
    allow_auto_approve: false,
    required_reviewer_role: "editor",
    violation,
  }));
}

function createReviewStatements({ db, mediaId, reviews, timestamp }) {
  return reviews.map((review) =>
    db.prepare(`
        INSERT INTO review_items (
          id,
          media_id,
          review_type,
          status,
          trigger,
          subject_type,
          raw_values_json,
          normalized_values_json,
          payload_json,
          required_reviewer_role,
          allow_ai_suggestion,
          origin,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingest', ?, ?)
      `).bind(
      `review_${crypto.randomUUID()}`,
      mediaId,
      review.review_type,
      review.status,
      review.trigger,
      review.subject_type,
      JSON.stringify(review.raw_values),
      JSON.stringify(review.normalized_values),
      JSON.stringify(review),
      review.required_reviewer_role,
      review.allow_ai_suggestion ? 1 : 0,
      timestamp,
      timestamp,
    ),
  );
}

async function stableId(prefix, parts) {
  const digest = await sha256Hex(parts.join("\u001f"));
  return `${prefix}_${digest.slice(0, 32)}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTerminalMediaStatus(status) {
  return status === "rejected" || status === "disabled";
}

function assertDatabase(db) {
  if (
    !db ||
    typeof db.prepare !== "function" ||
    typeof db.batch !== "function"
  ) {
    throw new TypeError("D1 database binding is required");
  }
}
