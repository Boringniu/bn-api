const REVIEW_ROLES = new Map([
  ["editor", 1],
  ["admin", 2],
]);

const ACTION_STATUS = new Map([
  ["approve", "approved"],
  ["reject", "rejected"],
  ["ignore", "ignored"],
  ["merge", "merged"],
  ["deprecate", "approved"],
  ["edit", "approved"],
  ["link_existing", "merged"],
]);

const PAGE_SIZE = 20;

export function createReviewService({ reviewRulesConfig, versionConfig }) {
  if (!reviewRulesConfig || typeof reviewRulesConfig !== "object") {
    throw new TypeError("reviewRulesConfig is required");
  }
  if (!versionConfig || typeof versionConfig !== "object") {
    throw new TypeError("versionConfig is required");
  }

  const allowedActions = new Set(reviewRulesConfig.review_actions);

  return Object.freeze({
    async listQueue(db, { status = "pending", type, role, page = 1 } = {}) {
      assertDatabase(db);
      const conditions = ["status = ?"];
      const values = [status];
      if (type) {
        conditions.push("review_type = ?");
        values.push(type);
      }
      if (role) {
        conditions.push("required_reviewer_role = ?");
        values.push(role);
      }
      const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
      const whereSql = `WHERE ${conditions.join(" AND ")}`;

      const [listResult, countResult] = await db.batch([
        db
          .prepare(
            `SELECT
               id, media_id, review_type, status, trigger, subject_type,
               raw_values_json, normalized_values_json,
               required_reviewer_role, allow_ai_suggestion, origin,
               created_at, updated_at
             FROM review_items
             ${whereSql}
             ORDER BY created_at, id
             LIMIT ? OFFSET ?`,
          )
          .bind(...values, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE),
        db
          .prepare(`SELECT COUNT(*) AS total FROM review_items ${whereSql}`)
          .bind(...values),
      ]);

      return {
        page: currentPage,
        page_size: PAGE_SIZE,
        total: countResult.results?.[0]?.total ?? 0,
        results: (listResult.results ?? []).map(formatReviewItem),
      };
    },

    async applyAction(
      db,
      reviewId,
      { action, reviewerRole, reviewerId, notes, target, edited_values } = {},
    ) {
      assertDatabase(db);
      if (!allowedActions.has(action)) {
        throw new ReviewActionError(
          400,
          `action must be one of: ${[...allowedActions].join(", ")}`,
          "invalid_review_action",
        );
      }
      if (!REVIEW_ROLES.has(reviewerRole)) {
        throw new ReviewActionError(403, "unknown reviewer role", "forbidden");
      }

      const item = await db
        .prepare("SELECT * FROM review_items WHERE id = ? LIMIT 1")
        .bind(reviewId)
        .first();
      if (!item) {
        throw new ReviewActionError(404, "review item not found", "review_not_found");
      }
      if (item.status !== "pending") {
        throw new ReviewActionError(
          409,
          `review item is already ${item.status}`,
          "review_already_resolved",
        );
      }

      const requiredLevel = REVIEW_ROLES.get(item.required_reviewer_role) ?? 2;
      if (REVIEW_ROLES.get(reviewerRole) < requiredLevel) {
        throw new ReviewActionError(
          403,
          `review item requires role ${item.required_reviewer_role}`,
          "insufficient_role",
        );
      }
      if (["merge", "link_existing"].includes(action) && !target) {
        throw new ReviewActionError(
          400,
          `action ${action} requires a target object id`,
          "target_required",
        );
      }

      const nextStatus = ACTION_STATUS.get(action);
      const timestamp = new Date().toISOString();
      const proposal = buildConfigProposal({
        action,
        edited_values,
        item,
        target,
        versionConfig,
      });
      const resolution = {
        action,
        reviewer_role: reviewerRole,
        notes: notes ?? null,
        target: target ?? null,
        edited_values: edited_values ?? null,
        config_proposal: proposal,
        resolved_ruleset_version: versionConfig.release.version,
      };

      await db
        .prepare(
          `UPDATE review_items
           SET status = ?, reviewer_id = ?, resolution_json = ?,
               updated_at = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(
          nextStatus,
          reviewerId ?? null,
          JSON.stringify(resolution),
          timestamp,
          timestamp,
          reviewId,
        )
        .run();

      return {
        id: reviewId,
        status: nextStatus,
        resolution,
      };
    },
  });
}

export class ReviewActionError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "ReviewActionError";
    this.status = status;
    this.code = code;
  }
}

// Approved review outcomes must still travel through a GitHub pull request
// (standard §15); the proposal is the reviewer's hand-off artifact, never an
// automatic config write.
function buildConfigProposal({ action, edited_values, item, target, versionConfig }) {
  if (!["approve", "merge", "deprecate", "edit", "link_existing"].includes(action)) {
    return null;
  }

  const rawValues = parseJson(item.raw_values_json, []);
  const normalizedValues = parseJson(item.normalized_values_json, []);
  const base = {
    requires_pull_request: true,
    ruleset_version_at_review: versionConfig.release.version,
    review_type: item.review_type,
    raw_values: rawValues,
    normalized_values: normalizedValues,
  };

  switch (item.review_type) {
    case "pending_tag":
      return {
        ...base,
        target_file: "config/tag_dictionary.json",
        suggested_change:
          action === "merge" || action === "link_existing"
            ? `add ${JSON.stringify(rawValues)} to aliases of ${target}`
            : `create a new tag for ${JSON.stringify(rawValues)} (status approved) or route to ignored.json`,
      };
    case "pending_actor":
      return {
        ...base,
        target_file: "config/actor_dictionary.json",
        suggested_change:
          action === "merge" || action === "link_existing"
            ? `add ${JSON.stringify(rawValues)} to aliases of ${target}`
            : `create a new actor entry for ${JSON.stringify(rawValues)}; confirm the zh-CN display name manually`,
      };
    case "pending_alias":
      return {
        ...base,
        target_file: "config/alias.json",
        suggested_change: `map ${JSON.stringify(rawValues)} to ${target ?? "a confirmed target"}`,
      };
    case "pending_category":
      return {
        ...base,
        target_file: "config/category.json",
        suggested_change:
          "categories are fixed at five; add the matched raw value to an existing category's aliases or leave unclassified",
      };
    case "possible_code":
      return {
        ...base,
        target_file: "config/search.json",
        suggested_change: `review code normalization for ${JSON.stringify(rawValues)}; extend the pattern only via PR`,
      };
    default:
      return {
        ...base,
        target_file: null,
        suggested_change: edited_values
          ? `apply edited values ${JSON.stringify(edited_values)}`
          : "manual follow-up",
      };
  }
}

function formatReviewItem(row) {
  return {
    id: row.id,
    media_id: row.media_id,
    review_type: row.review_type,
    status: row.status,
    trigger: row.trigger,
    subject_type: row.subject_type,
    raw_values: parseJson(row.raw_values_json, []),
    normalized_values: parseJson(row.normalized_values_json, []),
    required_reviewer_role: row.required_reviewer_role,
    allow_ai_suggestion: row.allow_ai_suggestion === 1,
    origin: row.origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
