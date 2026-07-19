import assert from "node:assert/strict";
import test from "node:test";

import {
  createMediaInputParser,
  MediaInputError,
} from "../src/media-input.mjs";

const parser = createMediaInputParser();

test("parses and normalizes a media ingest payload", () => {
  const result = parser.parse({
    source: {
      provider: "Example",
      external_id: " video-001 ",
    },
    title: "  Sample title  ",
    release_date: "2026-07-19",
    raw_tags: ["日本"],
  });

  assert.equal(result.source.provider, "example");
  assert.equal(result.source.external_id, "video-001");
  assert.equal(result.title, "Sample title");
  assert.equal(result.year, 2026);
  assert.deepEqual(result.actors, []);
  assert.deepEqual(result.metadata, {});
});

test("rejects unknown fields and incomplete source identity", () => {
  assert.throws(
    () =>
      parser.parse({
        source: { provider: "example" },
        title: "Sample",
        raw_tags: ["日本"],
        unexpected: true,
      }),
    MediaInputError,
  );
});

test("rejects a year that contradicts the release date", () => {
  assert.throws(
    () =>
      parser.parse({
        source: {
          provider: "example",
          external_id: "video-001",
        },
        title: "Sample",
        release_date: "2026-07-19",
        year: 2025,
        raw_tags: ["日本"],
      }),
    (error) =>
      error instanceof MediaInputError &&
      error.details[0]?.path === "/year",
  );
});
