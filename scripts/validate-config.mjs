import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CONFIG_DIR,
  SCHEMA_DIR,
  formatAjvErrors,
  loadJsonDirectory,
  normalizeAlias,
  printFailures,
  relativePath,
} from "./lib/config-utils.mjs";

const failures = [];

let configs;
let schemas;

try {
  [configs, schemas] = await Promise.all([
    loadJsonDirectory(CONFIG_DIR),
    loadJsonDirectory(SCHEMA_DIR),
  ]);
} catch (error) {
  printFailures("Configuration validation failed", [error.message]);
  process.exit();
}

const configNames = [...configs.keys()].sort();
const schemaNames = [...schemas.keys()].sort();

for (const name of configNames) {
  if (!schemas.has(name)) {
    failures.push(`config/${name}.json has no matching schema`);
  }
}

for (const name of schemaNames) {
  if (!configs.has(name)) {
    failures.push(`schema/${name}.schema.json has no matching config`);
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  validateFormats: true,
});
addFormats(ajv);

for (const name of configNames) {
  if (!schemas.has(name)) {
    continue;
  }

  const config = configs.get(name);
  const schema = schemas.get(name);

  try {
    const validate = ajv.compile(schema.data);
    if (!validate(config.data)) {
      failures.push(...formatAjvErrors(config.filePath, validate.errors));
    }
  } catch (error) {
    failures.push(`${relativePath(schema.filePath)}: invalid schema (${error.message})`);
  }
}

checkUniqueItemIds();
checkNormalizedValues();
checkVersionConsistency();
checkCrossConfigLimits();
checkRegularExpressions();

if (failures.length > 0) {
  printFailures("Configuration validation failed", failures);
} else {
  console.log(
    `Validated ${configNames.length} configuration files against ${schemaNames.length} schemas.`,
  );
}

function checkUniqueItemIds() {
  const idFields = {
    actor_dictionary: "actor_id",
    alias: "alias_id",
    category: "category_id",
    ignored: "ignore_id",
    tag_dictionary: "tag_id",
  };

  for (const [configName, idField] of Object.entries(idFields)) {
    const seen = new Set();
    for (const [index, item] of (configs.get(configName)?.data.items ?? []).entries()) {
      const id = item[idField];
      if (seen.has(id)) {
        failures.push(`config/${configName}.json/items/${index}: duplicate ${idField} "${id}"`);
      }
      seen.add(id);
    }
  }

  const reviewTypes = configs.get("review_rules")?.data.review_types ?? [];
  const seenReviewTypes = new Set();
  for (const [index, item] of reviewTypes.entries()) {
    if (seenReviewTypes.has(item.type)) {
      failures.push(`config/review_rules.json/review_types/${index}: duplicate type "${item.type}"`);
    }
    seenReviewTypes.add(item.type);
  }
}

function checkNormalizedValues() {
  for (const configName of ["category", "tag_dictionary"]) {
    for (const [itemIndex, item] of (
      configs.get(configName)?.data.items ?? []
    ).entries()) {
      if (item.aliases.length !== item.normalized_aliases.length) {
        failures.push(
          `config/${configName}.json/items/${itemIndex}: aliases and normalized_aliases must have equal length`,
        );
        continue;
      }

      for (const [aliasIndex, alias] of item.aliases.entries()) {
        const expected = normalizeAlias(alias);
        const actual = item.normalized_aliases[aliasIndex];
        if (actual !== expected) {
          failures.push(
            `config/${configName}.json/items/${itemIndex}/normalized_aliases/${aliasIndex}: expected "${expected}", got "${actual}"`,
          );
        }
      }
    }
  }

  for (const [itemIndex, actor] of (
    configs.get("actor_dictionary")?.data.items ?? []
  ).entries()) {
    for (const [aliasIndex, alias] of actor.aliases.entries()) {
      const expected = normalizeAlias(alias.value);
      if (alias.normalized_value !== expected) {
        failures.push(
          `config/actor_dictionary.json/items/${itemIndex}/aliases/${aliasIndex}/normalized_value: expected "${expected}", got "${alias.normalized_value}"`,
        );
      }
    }
  }

  for (const configName of ["alias", "ignored"]) {
    for (const [itemIndex, item] of (
      configs.get(configName)?.data.items ?? []
    ).entries()) {
      const sourceField = configName === "alias" ? "raw_value" : "value";
      const expected = normalizeAlias(item[sourceField]);
      if (item.normalized_value !== expected) {
        failures.push(
          `config/${configName}.json/items/${itemIndex}/normalized_value: expected "${expected}", got "${item.normalized_value}"`,
        );
      }
    }
  }
}

function checkVersionConsistency() {
  const versionConfig = configs.get("version")?.data;
  if (!versionConfig) {
    return;
  }

  if (versionConfig.release.version !== versionConfig.config_version) {
    failures.push(
      "config/version.json/release/version must equal config/version.json/config_version",
    );
  }

  const expectedVersionedFiles = configNames.filter((name) => name !== "version");
  const declaredVersionedFiles = Object.keys(versionConfig.files).sort();

  if (expectedVersionedFiles.join("\0") !== declaredVersionedFiles.join("\0")) {
    failures.push(
      `config/version.json/files must list exactly: ${expectedVersionedFiles.join(", ")}`,
    );
  }

  for (const name of expectedVersionedFiles) {
    const declaredVersion = versionConfig.files[name];
    const actualVersion = configs.get(name)?.data.config_version;
    if (declaredVersion !== actualVersion) {
      failures.push(
        `config/version.json/files/${name}: expected "${actualVersion}", got "${declaredVersion}"`,
      );
    }
  }

  const schemaVersions = new Set(
    configNames.map((name) => configs.get(name).data.schema_version),
  );
  if (schemaVersions.size !== 1) {
    failures.push("all config files must use the same schema_version");
  }
}

function checkCrossConfigLimits() {
  const actorRules = configs.get("actor_dictionary")?.data.rules;
  const tagRules = configs.get("tag_dictionary")?.data.rules;
  const display = configs.get("display")?.data;
  const search = configs.get("search")?.data.search;

  if (actorRules && display) {
    for (const [path, value] of [
      ["channel_index/max_actors", display.channel_index.max_actors],
      ["bot_result/max_actors", display.bot_result.max_actors],
    ]) {
      if (value > actorRules.max_display_actors_per_video) {
        failures.push(
          `config/display.json/${path} exceeds actor_dictionary.rules.max_display_actors_per_video`,
        );
      }
    }
  }

  if (tagRules && display) {
    for (const [path, value] of [
      ["channel_index/max_tags", display.channel_index.max_tags],
      ["bot_result/max_tags", display.bot_result.max_tags],
    ]) {
      if (value > tagRules.max_display_tags_per_video) {
        failures.push(
          `config/display.json/${path} exceeds tag_dictionary.rules.max_display_tags_per_video`,
        );
      }
    }
  }

  if (search && search.default_page_size > search.max_page_size) {
    failures.push(
      "config/search.json/search/default_page_size must not exceed max_page_size",
    );
  }
}

function checkRegularExpressions() {
  const patterns = [
    [
      "config/search.json/code_search/normalization/pattern",
      configs.get("search")?.data.code_search.normalization.pattern,
    ],
  ];

  for (const [index, alias] of (
    configs.get("alias")?.data.items ?? []
  ).entries()) {
    if (alias.match_mode === "regex") {
      patterns.push([
        `config/alias.json/items/${index}/raw_value`,
        alias.raw_value,
      ]);
    }
  }

  for (const [path, pattern] of patterns) {
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      failures.push(`${path}: invalid regular expression (${error.message})`);
    }
  }
}
