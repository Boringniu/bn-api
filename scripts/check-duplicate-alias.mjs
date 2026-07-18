import {
  CONFIG_DIR,
  loadJsonDirectory,
  normalizeAlias,
  printFailures,
} from "./lib/config-utils.mjs";

const failures = [];
const configs = await loadJsonDirectory(CONFIG_DIR);
const claims = new Map();
const activeStatuses = new Set(["approved", "pending"]);

const entityIndexes = {
  actor: indexEntities("actor_dictionary", "actor_id", "display_name_zh_cn"),
  category: indexEntities("category", "category_id", "display_name"),
  tag: indexEntities("tag_dictionary", "tag_id", "display_name"),
};

collectDictionaryAliases();
collectGlobalAliases();
checkAliasCollisions();
checkIgnoredCollisions();

if (failures.length > 0) {
  printFailures("Alias validation failed", failures);
} else {
  const claimCount = [...claims.values()].reduce(
    (total, entries) => total + entries.length,
    0,
  );
  console.log(`Checked ${claimCount} active aliases; no conflicts found.`);
}

function indexEntities(configName, idField, displayField) {
  return new Map(
    (configs.get(configName)?.data.items ?? []).map((item) => [
      item[idField],
      item[displayField],
    ]),
  );
}

function addClaim(rawValue, normalizedValue, type, targetId, source) {
  const key = normalizedValue || normalizeAlias(rawValue);
  const entries = claims.get(key) ?? [];
  entries.push({
    rawValue,
    source,
    targetId,
    type,
  });
  claims.set(key, entries);
}

function collectDictionaryAliases() {
  for (const [index, category] of (
    configs.get("category")?.data.items ?? []
  ).entries()) {
    if (!activeStatuses.has(category.status)) {
      continue;
    }
    for (const [aliasIndex, alias] of category.aliases.entries()) {
      addClaim(
        alias,
        category.normalized_aliases[aliasIndex],
        "category",
        category.category_id,
        `config/category.json/items/${index}/aliases/${aliasIndex}`,
      );
    }
  }

  for (const [index, tag] of (
    configs.get("tag_dictionary")?.data.items ?? []
  ).entries()) {
    if (!activeStatuses.has(tag.status)) {
      continue;
    }
    for (const [aliasIndex, alias] of tag.aliases.entries()) {
      addClaim(
        alias,
        tag.normalized_aliases[aliasIndex],
        "tag",
        tag.tag_id,
        `config/tag_dictionary.json/items/${index}/aliases/${aliasIndex}`,
      );
    }
  }

  for (const [index, actor] of (
    configs.get("actor_dictionary")?.data.items ?? []
  ).entries()) {
    if (!activeStatuses.has(actor.status)) {
      continue;
    }
    for (const [aliasIndex, alias] of actor.aliases.entries()) {
      if (!activeStatuses.has(alias.status)) {
        continue;
      }
      addClaim(
        alias.value,
        alias.normalized_value,
        "actor",
        actor.actor_id,
        `config/actor_dictionary.json/items/${index}/aliases/${aliasIndex}`,
      );
    }
  }
}
function collectGlobalAliases() {
  const expectedTargetTypes = {
    actor: "actor",
    category: "category",
    code_format: "code_pattern",
    search_correction: "search_correction",
    tag: "tag",
  };

  for (const [index, alias] of (
    configs.get("alias")?.data.items ?? []
  ).entries()) {
    if (!activeStatuses.has(alias.status)) {
      continue;
    }

    const source = `config/alias.json/items/${index}`;
    const expectedTargetType = expectedTargetTypes[alias.alias_type];
    if (alias.target_type !== expectedTargetType) {
      failures.push(
        `${source}: alias_type "${alias.alias_type}" requires target_type "${expectedTargetType}"`,
      );
    }

    const entityIndex = entityIndexes[alias.alias_type];
    if (entityIndex) {
      if (!entityIndex.has(alias.target_id)) {
        failures.push(
          `${source}: target "${alias.target_id}" does not exist in the ${alias.alias_type} dictionary`,
        );
      } else if (entityIndex.get(alias.target_id) !== alias.target_display_name) {
        failures.push(
          `${source}: target_display_name must be "${entityIndex.get(alias.target_id)}"`,
        );
      }
    }

    addClaim(
      alias.raw_value,
      alias.normalized_value,
      alias.alias_type,
      alias.target_id,
      source,
    );
  }
}

function checkAliasCollisions() {
  for (const [normalizedValue, entries] of claims) {
    if (entries.length < 2) {
      continue;
    }

    const targets = new Set(
      entries.map((entry) => `${entry.type}:${entry.targetId}`),
    );
    const details = entries
      .map(
        (entry) =>
          `${entry.source} -> ${entry.type}:${entry.targetId} ("${entry.rawValue}")`,
      )
      .join("; ");

    if (targets.size > 1) {
      failures.push(
        `normalized alias "${normalizedValue}" points to multiple targets: ${details}`,
      );
    } else {
      failures.push(
        `normalized alias "${normalizedValue}" is duplicated for the same target: ${details}`,
      );
    }
  }
}

function checkIgnoredCollisions() {
  for (const [index, ignored] of (
    configs.get("ignored")?.data.items ?? []
  ).entries()) {
    if (!activeStatuses.has(ignored.status)) {
      continue;
    }

    const entries = claims.get(ignored.normalized_value) ?? [];
    const relevantEntries = entries.filter((entry) => {
      return (
        ignored.scope.includes(entry.type) ||
        ignored.scope.includes("search_query")
      );
    });

    if (relevantEntries.length > 0) {
      failures.push(
        `config/ignored.json/items/${index}: ignored value "${ignored.value}" conflicts with ${relevantEntries
          .map((entry) => entry.source)
          .join(", ")}`,
      );
    }
  }
}
