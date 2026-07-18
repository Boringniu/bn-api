import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(
  new URL("../scripts/normalize-tags.mjs", import.meta.url),
);

test("normalizes tags passed as command-line arguments", () => {
  const result = runCli(["日本", "NTR"]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.selected_category.category_id, "cat_japan");
  assert.deepEqual(
    output.standard_tags.map((tag) => tag.tag_id),
    ["tag_ntr"],
  );
});

test("normalizes a raw_tags object read from stdin", () => {
  const result = runCli([], {
    input: JSON.stringify({
      raw_tags: ["日本成人", "CHS", "电影"],
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.raw_tags.length, 3);
  assert.equal(output.standard_tags[0].tag_id, "tag_chinese_subtitle");
  assert.equal(output.ignored_tags[0].ignore_id, "ignore_000001");
});

test("rejects unsupported or empty stdin input", () => {
  const unsupported = runCli([], {
    input: JSON.stringify({ tags: ["NTR"] }),
  });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /must be an array/);

  const empty = runCli([], {
    input: "[]",
  });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /must contain at least one tag/);
});

function runCli(argumentsList, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...argumentsList], {
    encoding: "utf8",
    ...options,
  });
}
