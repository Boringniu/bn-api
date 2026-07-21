import { normalizeCode } from "./code-normalizer.mjs";
import { normalizeValue } from "./value-normalizer.mjs";

const APPROVED_STATUS = "approved";

const PUBLIC_MEDIA_COLUMNS = `
  m.id,
  m.normalized_code,
  m.title,
  m.release_date,
  m.year,
  m.subtitle,
  m.category_id,
  m.updated_at
`;

export function createSearchService({
  actorDictionaryConfig,
  aliasConfig,
  categoryConfig,
  ignoredConfig,
  searchConfig,
  tagDictionaryConfig,
  versionConfig,
}) {
  for (const [name, config] of Object.entries({
    actorDictionaryConfig,
    aliasConfig,
    categoryConfig,
    ignoredConfig,
    searchConfig,
    tagDictionaryConfig,
    versionConfig,
  })) {
    if (!config || typeof config !== "object") {
      throw new TypeError(`${name} is required`);
    }
  }

  const search = searchConfig.search;
  const indexes = buildEntityIndexes({
    actorDictionaryConfig,
    aliasConfig,
    categoryConfig,
    tagDictionaryConfig,
  });
  const ignoredValues = new Set(
    ignoredConfig.items
      .filter(
        (item) =>
          item.status === APPROVED_STATUS &&
          item.match_mode !== "regex",
      )
      .map((item) => item.normalized_value)
      // “演员名误作标签”只能在标签处理中忽略，不能覆盖合法实体别名。
      .filter(
        (value) =>
          !indexes.actorValues.has(value) &&
          !indexes.tagValues.has(value) &&
          !indexes.categoryValues.has(value),
      ),
  );

  return Object.freeze({
    resolveQuery(rawQuery) {
      const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
      if (query.length < search.query_min_length) {
        return { query, resolution: null };
      }
      if (ignoredValues.has(normalizeValue(query))) {
        return { query, resolution: null };
      }

      for (const step of search.search_order) {
        const resolution = resolveStep(step, query, {
          indexes,
          searchConfig,
        });
        if (resolution) {
          return { query, resolution };
        }
      }

      return { query, resolution: null };
    },

    async findMedia(db, { filters = {}, page = 1, pageSize } = {}) {
      assertDatabase(db);
      const size = clampPageSize(pageSize, search);
      const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
      const offset = (currentPage - 1) * size;
      if (offset >= search.max_result_count) {
        return emptyPage(currentPage, size);
      }

      const { joins, conditions, values } = buildFilterSql(filters);
      const whereSql = conditions.length
        ? `WHERE ${conditions.join(" AND ")}`
        : "";
      const limit = Math.min(size, search.max_result_count - offset);

      const listSql = `
        SELECT DISTINCT ${PUBLIC_MEDIA_COLUMNS}
        FROM media m
        ${joins.join("\n")}
        ${whereSql}
        ORDER BY m.updated_at DESC, m.id
        LIMIT ? OFFSET ?
      `;
      const countSql = `
        SELECT COUNT(DISTINCT m.id) AS total
        FROM media m
        ${joins.join("\n")}
        ${whereSql}
      `;

      const [listResult, countResult] = await db.batch([
        db.prepare(listSql).bind(...values, limit, offset),
        db.prepare(countSql).bind(...values),
      ]);

      const total = Math.min(
        countResult.results?.[0]?.total ?? 0,
        search.max_result_count,
      );
      const rows = listResult.results ?? [];
      const mediaIds = rows.map((row) => row.id);
      const associations = await loadAssociations(db, mediaIds);

      return {
        page: currentPage,
        page_size: size,
        total,
        results: rows.map((row) => formatMedia(row, associations)),
      };
    },

    async getMedia(db, mediaId) {
      assertDatabase(db);
      const row = await db
        .prepare(
          `SELECT ${PUBLIC_MEDIA_COLUMNS}
           FROM media m
           WHERE m.id = ? AND m.status = 'approved'
           LIMIT 1`,
        )
        .bind(mediaId)
        .first();
      if (!row) {
        return null;
      }
      const associations = await loadAssociations(db, [row.id]);
      return formatMedia(row, associations);
    },

    async listCodePrefixes(db) {
      assertDatabase(db);
      const grouping = searchConfig.code_search.alphabetical_grouping;
      if (!grouping.enabled) {
        return [];
      }
      const result = await db
        .prepare(
          `SELECT
             substr(normalized_code, 1, instr(normalized_code, '-') - 1)
               AS prefix,
             COUNT(*) AS media_count
           FROM media
           WHERE status = 'approved'
             AND normalized_code IS NOT NULL
             AND instr(normalized_code, '-') > 1
           GROUP BY prefix
           ORDER BY prefix ${grouping.sort === "desc" ? "DESC" : "ASC"}`,
        )
        .all();
      return result.results ?? [];
    },
  });

  async function loadAssociations(db, mediaIds) {
    if (mediaIds.length === 0) {
      return { actors: new Map(), categories: new Map(), tags: new Map() };
    }

    const placeholders = mediaIds.map(() => "?").join(", ");
    const [actorRows, tagRows] = await db.batch([
      db
        .prepare(
          `SELECT media_id, actor_id, display_name_snapshot, position
           FROM media_actors
           WHERE media_id IN (${placeholders}) AND display_enabled = 1
           ORDER BY media_id, position`,
        )
        .bind(...mediaIds),
      db
        .prepare(
          `SELECT media_id, tag_id, display_name_snapshot, weight
           FROM media_tags
           WHERE media_id IN (${placeholders}) AND display_enabled = 1
           ORDER BY media_id, weight DESC, display_name_snapshot`,
        )
        .bind(...mediaIds),
    ]);

    const actors = groupBy(actorRows.results ?? [], "media_id");
    const tags = groupBy(tagRows.results ?? [], "media_id");
    return { actors, tags };
  }

  function formatMedia(row, associations) {
    const category = indexes.categoriesById.get(row.category_id);
    return {
      id: row.id,
      title: row.title,
      code: row.normalized_code,
      release_date: row.release_date,
      year: row.year,
      subtitle: row.subtitle === 1,
      category: category
        ? {
            category_id: category.category_id,
            display_name: category.display_name,
          }
        : null,
      actors: (associations.actors.get(row.id) ?? []).map((actor) => ({
        actor_id: actor.actor_id,
        display_name: actor.display_name_snapshot,
      })),
      tags: (associations.tags.get(row.id) ?? []).map((tag) => ({
        tag_id: tag.tag_id,
        display_name: tag.display_name_snapshot,
      })),
    };
  }
}

function resolveStep(step, query, { indexes, searchConfig }) {
  switch (step) {
    case "exact_code": {
      if (!searchConfig.code_search.enabled) {
        return null;
      }
      const result = normalizeCode(query, searchConfig);
      if (result?.is_valid) {
        return {
          type: "code",
          match: "exact_code",
          code: result.normalized_code,
        };
      }
      return null;
    }
    case "exact_actor_alias":
      return resolveEntity(indexes.actorValues, query, "actor", "exact_alias");
    case "exact_tag_alias":
      return resolveEntity(indexes.tagValues, query, "tag", "exact_alias");
    case "exact_category_alias":
      return resolveEntity(
        indexes.categoryValues,
        query,
        "category",
        "exact_alias",
      );
    case "normalized_match": {
      const normalized = normalizeValue(query);
      return (
        resolveEntity(indexes.actorValues, normalized, "actor", "normalized") ??
        resolveEntity(indexes.tagValues, normalized, "tag", "normalized") ??
        resolveEntity(
          indexes.categoryValues,
          normalized,
          "category",
          "normalized",
        )
      );
    }
    case "prefix_match": {
      if (!searchConfig.code_search.allow_prefix_search) {
        return null;
      }
      const candidate = normalizeValue(query).replace(/\s+/gu, "");
      if (/^[a-z]{2,10}$/u.test(candidate)) {
        return {
          type: "code_prefix",
          match: "prefix",
          prefix: candidate.toUpperCase(),
        };
      }
      return null;
    }
    case "fuzzy_match": {
      const fuzzy = searchConfig.search;
      if (
        !fuzzy.enable_fuzzy_search ||
        query.length < fuzzy.fuzzy_search_min_length
      ) {
        return null;
      }
      const normalized = normalizeValue(query);
      for (const [values, type] of [
        [indexes.actorValues, "actor"],
        [indexes.tagValues, "tag"],
      ]) {
        const best = findFuzzyMatch(
          values,
          normalized,
          fuzzy.fuzzy_search_max_distance,
        );
        if (best) {
          return { ...best, type, match: "fuzzy" };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function resolveEntity(valueIndex, value, type, match) {
  const normalized = normalizeValue(value ?? "");
  const target = valueIndex.get(normalized);
  if (!target) {
    return null;
  }
  return { type, match, ...target };
}

function findFuzzyMatch(valueIndex, normalized, maxDistance) {
  let best = null;
  for (const [value, target] of valueIndex) {
    if (Math.abs(value.length - normalized.length) > maxDistance) {
      continue;
    }
    const distance = levenshtein(value, normalized, maxDistance);
    if (distance !== null && (best === null || distance < best.distance)) {
      best = { ...target, distance };
    }
  }
  return best;
}

function levenshtein(left, right, maxDistance) {
  if (left === right) {
    return 0;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitution =
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    if (rowMinimum > maxDistance) {
      return null;
    }
    previous = current;
  }
  return previous[right.length] <= maxDistance
    ? previous[right.length]
    : null;
}

function buildEntityIndexes({
  actorDictionaryConfig,
  aliasConfig,
  categoryConfig,
  tagDictionaryConfig,
}) {
  const actorValues = new Map();
  const tagValues = new Map();
  const categoryValues = new Map();
  const categoriesById = new Map();

  for (const actor of actorDictionaryConfig.items) {
    if (actor.status !== APPROVED_STATUS || !actor.search_enabled) {
      continue;
    }
    const names = [
      actor.display_name_zh_cn,
      actor.name_ja,
      actor.name_en,
      actor.romanized_name,
      ...actor.aliases
        .filter((alias) => alias.status === APPROVED_STATUS)
        .map((alias) => alias.value),
    ].filter(Boolean);
    for (const name of names) {
      setValue(actorValues, name, {
        actor_id: actor.actor_id,
        display_name: actor.display_name_zh_cn,
      });
    }
  }

  for (const tag of tagDictionaryConfig.items) {
    if (tag.status !== APPROVED_STATUS || !tag.search_enabled) {
      continue;
    }
    for (const name of [tag.display_name, ...tag.aliases]) {
      setValue(tagValues, name, {
        tag_id: tag.tag_id,
        display_name: tag.display_name,
      });
    }
  }

  for (const category of categoryConfig.items) {
    if (category.status !== APPROVED_STATUS) {
      continue;
    }
    categoriesById.set(category.category_id, category);
    for (const name of [category.display_name, ...category.aliases]) {
      setValue(categoryValues, name, {
        category_id: category.category_id,
        display_name: category.display_name,
      });
    }
  }

  for (const alias of aliasConfig.items) {
    if (alias.status !== APPROVED_STATUS) {
      continue;
    }
    if (alias.alias_type === "actor") {
      const target = [...actorValues.values()].find(
        (entry) => entry.actor_id === alias.target_id,
      );
      if (target) {
        setValue(actorValues, alias.raw_value, target);
      }
    } else if (alias.alias_type === "tag") {
      const target = [...tagValues.values()].find(
        (entry) => entry.tag_id === alias.target_id,
      );
      if (target) {
        setValue(tagValues, alias.raw_value, target);
      }
    } else if (alias.alias_type === "category") {
      const target = categoriesById.get(alias.target_id);
      if (target) {
        setValue(categoryValues, alias.raw_value, {
          category_id: target.category_id,
          display_name: target.display_name,
        });
      }
    }
  }

  return { actorValues, tagValues, categoryValues, categoriesById };
}

function setValue(valueIndex, value, target) {
  const normalized = normalizeValue(value);
  if (normalized && !valueIndex.has(normalized)) {
    valueIndex.set(normalized, target);
  }
}

function buildFilterSql(filters) {
  const joins = [];
  const conditions = ["m.status = 'approved'"];
  const values = [];

  if (filters.category_id) {
    conditions.push("m.category_id = ?");
    values.push(filters.category_id);
  }
  if (filters.actor_id) {
    joins.push("JOIN media_actors fa ON fa.media_id = m.id");
    conditions.push("fa.actor_id = ? AND fa.search_enabled = 1");
    values.push(filters.actor_id);
  }
  if (filters.tag_id) {
    joins.push("JOIN media_tags ft ON ft.media_id = m.id");
    conditions.push("ft.tag_id = ? AND ft.search_enabled = 1");
    values.push(filters.tag_id);
  }
  if (filters.code) {
    conditions.push("m.normalized_code = ?");
    values.push(filters.code);
  }
  if (filters.code_prefix) {
    conditions.push("m.normalized_code LIKE ?");
    values.push(`${filters.code_prefix}-%`);
  }
  if (filters.subtitle !== undefined) {
    conditions.push("m.subtitle = ?");
    values.push(filters.subtitle ? 1 : 0);
  }
  if (filters.year !== undefined) {
    conditions.push("m.year = ?");
    values.push(filters.year);
  }

  return { joins, conditions, values };
}

function clampPageSize(pageSize, search) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return search.default_page_size;
  }
  return Math.min(pageSize, search.max_page_size);
}

function emptyPage(page, pageSize) {
  return { page, page_size: pageSize, total: 0, results: [] };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const entries = groups.get(row[key]) ?? [];
    entries.push(row);
    groups.set(row[key], entries);
  }
  return groups;
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
