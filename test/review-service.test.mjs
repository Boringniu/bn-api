import assert from "node:assert/strict";
import test from "node:test";

import { createReviewService, ReviewActionError } from "../src/review-service.mjs";
import {
  CONFIG_DIR,
  loadJsonDirectory,
} from "../scripts/lib/config-utils.mjs";

const configs = await loadJsonDirectory(CONFIG_DIR);
const service = createReviewService({
  reviewRulesConfig: configs.get("review_rules").data,
  versionConfig: configs.get("version").data,
});

test("lists the pending queue with filters", async () => {
  const db = new FakeD1({ rows: [pendingRow()] });
  const result = await service.listQueue(db, {
    type: "pending_actor",
    role: "editor",
  });

  assert.equal(result.total, 1);
  assert.equal(result.results[0].review_type, "pending_actor");
  assert.deepEqual(result.results[0].raw_values, ["未知演员"]);
  const sql = db.statements[0].sql;
  assert.match(sql, /status = \?/);
  assert.match(sql, /review_type = \?/);
  assert.match(sql, /required_reviewer_role = \?/);
});

test("rejects unknown actions and roles", async () => {
  const db = new FakeD1({ existing: pendingRow() });
  await assert.rejects(
    service.applyAction(db, "review_1", { action: "delete", reviewerRole: "admin" }),
    (error) =>
      error instanceof ReviewActionError && error.code === "invalid_review_action",
  );
  await assert.rejects(
    service.applyAction(db, "review_1", { action: "approve", reviewerRole: "viewer" }),
    (error) => error instanceof ReviewActionError && error.status === 403,
  );
});

test("enforces the required reviewer role hierarchy", async () => {
  const db = new FakeD1({
    existing: pendingRow({ required_reviewer_role: "admin" }),
  });
  await assert.rejects(
    service.applyAction(db, "review_1", { action: "approve", reviewerRole: "editor" }),
    (error) => error instanceof ReviewActionError && error.code === "insufficient_role",
  );

  const adminDb = new FakeD1({
    existing: pendingRow({ required_reviewer_role: "admin" }),
  });
  const result = await service.applyAction(adminDb, "review_1", {
    action: "approve",
    reviewerRole: "admin",
  });
  assert.equal(result.status, "approved");
});

test("refuses to re-resolve a completed review", async () => {
  const db = new FakeD1({ existing: pendingRow({ status: "approved" }) });
  await assert.rejects(
    service.applyAction(db, "review_1", { action: "reject", reviewerRole: "admin" }),
    (error) =>
      error instanceof ReviewActionError && error.code === "review_already_resolved",
  );
});

test("merge and link_existing require a target", async () => {
  const db = new FakeD1({ existing: pendingRow() });
  await assert.rejects(
    service.applyAction(db, "review_1", { action: "merge", reviewerRole: "editor" }),
    (error) => error instanceof ReviewActionError && error.code === "target_required",
  );
});

test("approve emits a PR-bound config proposal, never a direct write", async () => {
  const db = new FakeD1({ existing: pendingRow() });
  const result = await service.applyAction(db, "review_1", {
    action: "approve",
    reviewerRole: "editor",
    reviewerId: "alice",
  });

  const proposal = result.resolution.config_proposal;
  assert.equal(proposal.requires_pull_request, true);
  assert.equal(proposal.target_file, "config/actor_dictionary.json");
  assert.match(proposal.suggested_change, /confirm the zh-CN display name manually/);

  const update = db.statements.find((s) => s.sql.includes("UPDATE review_items"));
  assert.ok(update);
  assert.match(update.sql, /status = 'pending'/);
  assert.equal(
    db.statements.filter((s) => /INSERT INTO|config\//.test(s.sql)).length,
    0,
  );
});

test("merge proposal references the target alias owner", async () => {
  const db = new FakeD1({
    existing: pendingRow({ review_type: "pending_tag" }),
  });
  const result = await service.applyAction(db, "review_1", {
    action: "merge",
    reviewerRole: "editor",
    target: "tag_office",
  });

  assert.equal(result.status, "merged");
  assert.match(result.resolution.config_proposal.suggested_change, /tag_office/);
});

test("reject and ignore do not produce config proposals", async () => {
  for (const action of ["reject", "ignore"]) {
    const db = new FakeD1({ existing: pendingRow() });
    const result = await service.applyAction(db, "review_1", {
      action,
      reviewerRole: "editor",
    });
    assert.equal(result.resolution.config_proposal, null, action);
  }
});

function pendingRow(overrides = {}) {
  return {
    id: "review_1",
    media_id: "media_1",
    review_type: "pending_actor",
    status: "pending",
    trigger: "actor_not_found_in_dictionary",
    subject_type: "actor",
    raw_values_json: JSON.stringify(["未知演员"]),
    normalized_values_json: JSON.stringify(["未知演员"]),
    required_reviewer_role: "editor",
    allow_ai_suggestion: 1,
    origin: "ingest",
    created_at: "2026-07-19T00:00:00Z",
    updated_at: "2026-07-19T00:00:00Z",
    ...overrides,
  };
}

class FakeD1 {
  constructor({ rows = [], existing = null } = {}) {
    this.rows = rows;
    this.existing = existing;
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
        return db.existing;
      },
      async run() {
        db.statements.push(this);
        return { success: true };
      },
      async all() {
        db.statements.push(this);
        return { results: db.rows };
      },
    };
  }

  async batch(statements) {
    this.statements.push(...statements);
    return statements.map((statement, index) =>
      index === 0
        ? { results: this.rows }
        : { results: [{ total: this.rows.length }] },
    );
  }
}
