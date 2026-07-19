import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import mediaIngestSchema from "../contracts/media-ingest.schema.json" with {
  type: "json",
};
import { normalizeValue } from "./value-normalizer.mjs";

export class MediaInputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "MediaInputError";
    this.details = details;
  }
}

export function createMediaInputParser() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(mediaIngestSchema);

  return Object.freeze({
    parse(input) {
      if (!validate(input)) {
        throw new MediaInputError(
          "media payload does not match the ingest contract",
          formatErrors(validate.errors),
        );
      }

      assertYearMatchesReleaseDate(input);

      return {
        ...input,
        source: {
          ...input.source,
          provider: normalizeValue(input.source.provider),
          external_id: input.source.external_id.trim(),
        },
        title: input.title.trim(),
        description: input.description?.trim() || null,
        code: input.code?.trim() || null,
        release_date: input.release_date ?? null,
        year: input.year ?? deriveYear(input.release_date),
        duration_seconds: input.duration_seconds ?? null,
        cover_url: input.cover_url ?? null,
        subtitle: input.subtitle ?? null,
        actors: input.actors ?? [],
        raw_tags: input.raw_tags,
        metadata: input.metadata ?? {},
      };
    },
  });
}

function assertYearMatchesReleaseDate(input) {
  if (!input.release_date || input.year === undefined || input.year === null) {
    return;
  }

  const releaseYear = deriveYear(input.release_date);
  if (input.year !== releaseYear) {
    throw new MediaInputError(
      "year must match the year in release_date",
      [
        {
          path: "/year",
          message: `must equal ${releaseYear} when release_date is provided`,
        },
      ],
    );
  }
}

function deriveYear(releaseDate) {
  if (!releaseDate) {
    return null;
  }
  return Number(releaseDate.slice(0, 4));
}

function formatErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message,
    ...(error.params?.additionalProperty
      ? { property: error.params.additionalProperty }
      : {}),
  }));
}
