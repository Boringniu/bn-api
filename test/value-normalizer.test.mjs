import assert from "node:assert/strict";
import test from "node:test";

import { normalizeValue } from "../src/value-normalizer.mjs";

test("applies NFKC normalization and full-width conversion", () => {
  assert.equal(normalizeValue("ＡＢＰ１２３"), "abp123");
  assert.equal(normalizeValue("希島あいり"), "希島あいり");
});

test("trims and collapses whitespace", () => {
  assert.equal(normalizeValue("  office   lady  "), "office lady");
  assert.equal(normalizeValue("\tschool　girl\n"), "school girl");
});

test("lowercases latin characters for matching", () => {
  assert.equal(normalizeValue("Airi Kijima"), "airi kijima");
  assert.equal(normalizeValue("NTR"), "ntr");
});

test("unifies separator characters into single spaces", () => {
  assert.equal(normalizeValue("office-lady"), "office lady");
  assert.equal(normalizeValue("office_lady"), "office lady");
  assert.equal(normalizeValue("office.lady"), "office lady");
  assert.equal(normalizeValue("office/lady"), "office lady");
  assert.equal(normalizeValue("office - _ lady"), "office lady");
});

test("drops leading and trailing separators", () => {
  assert.equal(normalizeValue("-剧情-"), "剧情");
  assert.equal(normalizeValue("_中文字幕_"), "中文字幕");
});

test("rejects non-string input", () => {
  assert.throws(() => normalizeValue(null), TypeError);
  assert.throws(() => normalizeValue(123), TypeError);
});
