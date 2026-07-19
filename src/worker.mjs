import actorDictionaryConfig from "../config/actor_dictionary.json" with {
  type: "json",
};
import aliasConfig from "../config/alias.json" with { type: "json" };
import categoryConfig from "../config/category.json" with { type: "json" };
import displayConfig from "../config/display.json" with { type: "json" };
import ignoredConfig from "../config/ignored.json" with { type: "json" };
import reviewRulesConfig from "../config/review_rules.json" with {
  type: "json",
};
import searchConfig from "../config/search.json" with { type: "json" };
import tagDictionaryConfig from "../config/tag_dictionary.json" with {
  type: "json",
};
import versionConfig from "../config/version.json" with { type: "json" };

import { createActorNormalizer } from "./actor-normalizer.mjs";
import { createIngestService } from "./ingest-service.mjs";
import { createMediaInputParser } from "./media-input.mjs";
import { createReviewService } from "./review-service.mjs";
import { createSearchService } from "./search-service.mjs";
import { createTagNormalizer } from "./tag-normalizer.mjs";
import { createTelegramService } from "./telegram-service.mjs";
import { createWorkerApp } from "./worker-app.mjs";

const actorNormalizer = createActorNormalizer({
  actorDictionaryConfig,
  aliasConfig,
  reviewRulesConfig,
  versionConfig,
});
const tagNormalizer = createTagNormalizer({
  aliasConfig,
  categoryConfig,
  ignoredConfig,
  reviewRulesConfig,
  tagDictionaryConfig,
  versionConfig,
});
const ingestService = createIngestService({
  actorNormalizer,
  mediaInputParser: createMediaInputParser(),
  reviewRulesConfig,
  searchConfig,
  tagNormalizer,
  versionConfig,
});
const searchService = createSearchService({
  actorDictionaryConfig,
  aliasConfig,
  categoryConfig,
  ignoredConfig,
  searchConfig,
  tagDictionaryConfig,
  versionConfig,
});
const app = createWorkerApp({
  ingestService,
  reviewService: createReviewService({
    reviewRulesConfig,
    versionConfig,
  }),
  searchService,
  telegramService: createTelegramService({
    categoryConfig,
    displayConfig,
    ingestService,
    searchConfig,
    searchService,
    versionConfig,
  }),
  versionConfig,
});

export default {
  fetch(request, env) {
    return app.fetch(request, env);
  },
};
