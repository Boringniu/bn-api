import assert from "node:assert/strict";
import test from "node:test";

import searchConfig from "../config/search.json" with { type: "json" };
import { normalizeCode } from "../src/code-normalizer.mjs";

test("normalizes configured media codes", () => {
  assert.deepEqual(normalizeCode(" abp_123 ", searchConfig), {
    raw_code: " abp_123 ",
    normalized_code: "ABP-123",
    is_valid: true,
  });
  assert.deepEqual(normalizeCode("SSIS—001", searchConfig), {
    raw_code: "SSIS—001",
    normalized_code: "SSIS-001",
    is_valid: true,
  });
});

test("retains invalid code candidates for review", () => {
  assert.deepEqual(normalizeCode("not-a-code", searchConfig), {
    raw_code: "not-a-code",
    normalized_code: "NOT-A-CODE",
    is_valid: false,
  });
  assert.equal(normalizeCode(null, searchConfig), null);
});
