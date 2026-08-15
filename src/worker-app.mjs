import { MediaInputError } from "./media-input.mjs";
import { ReviewActionError } from "./review-service.mjs";

const MAX_BODY_BYTES = 1_048_576;

export function createWorkerApp({
  ingestService,
  reviewService,
  searchService,
  telegramService,
  versionConfig,
}) {
  return Object.freeze({
    async fetch(request, env) {
      const requestId =
        request.headers.get("x-request-id") ?? crypto.randomUUID();

      try {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
          return jsonResponse(
            {
              ok: true,
              service: "bn-api",
              ruleset_version: versionConfig.release.version,
            },
            200,
            requestId,
          );
        }

        if (request.method === "GET" && url.pathname === "/v1/search") {
          assertDb(env);
          const result = await handleSearch(searchService, env.DB, url);
          return jsonResponse({ data: result }, 200, requestId);
        }

        const mediaMatch = url.pathname.match(/^\/v1\/media\/([a-z0-9_]+)$/);
        if (request.method === "GET" && mediaMatch) {
          assertDb(env);
          const media = await searchService.getMedia(env.DB, mediaMatch[1]);
          if (!media) {
            throw new HttpError(404, "media not found", "media_not_found");
          }
          return jsonResponse({ data: media }, 200, requestId);
        }

        if (request.method === "GET" && url.pathname === "/v1/codes") {
          assertDb(env);
          const prefixes = await searchService.listCodePrefixes(env.DB);
          return jsonResponse({ data: { prefixes } }, 200, requestId);
        }

        if (request.method === "GET" && url.pathname === "/v1/review") {
          const reviewer = assertReviewer(request, env);
          assertDb(env);
          const result = await reviewService.listQueue(env.DB, {
            status: url.searchParams.get("status") ?? "pending",
            type: url.searchParams.get("type") ?? undefined,
            role: url.searchParams.get("role") ?? undefined,
            page: Number(url.searchParams.get("page") ?? "1"),
          });
          return jsonResponse(
            { data: { reviewer_role: reviewer.role, ...result } },
            200,
            requestId,
          );
        }

        const reviewMatch = url.pathname.match(
          /^\/v1\/review\/([A-Za-z0-9_-]+)\/action$/,
        );
        if (request.method === "POST" && reviewMatch) {
          const reviewer = assertReviewer(request, env);
          assertJsonRequest(request);
          assertBodySize(request);
          assertDb(env);
          const payload = await readJson(request);
          const result = await reviewService.applyAction(env.DB, reviewMatch[1], {
            action: payload.action,
            reviewerRole: reviewer.role,
            reviewerId: payload.reviewer_id ?? reviewer.role,
            notes: payload.notes,
            target: payload.target,
            edited_values: payload.edited_values,
          });
          return jsonResponse({ data: result }, 200, requestId);
        }

        if (
          request.method === "POST" &&
          (url.pathname === "/telegram/webhook" || url.pathname === "/")
        ) {
          assertTelegramWebhook(request, env);
          assertBodySize(request);
          assertDb(env);
          const update = await readJson(request);
          console.log("telegram webhook received", {
            requestId,
            updateId: update?.update_id ?? null,
            path: url.pathname,
            hasMessage: Boolean(update?.message),
            hasChannelPost: Boolean(update?.channel_post),
            hasEditedChannelPost: Boolean(update?.edited_channel_post),
          });
          // Always ack to Telegram: a thrown error would make it retry the
          // same update forever and block every later update in the queue.
          await recordTelegramUpdateAudit(env.DB, update, "received");
          try {
            const result = await telegramService.handleUpdate(env.DB, update, env);
            await recordTelegramUpdateAudit(env.DB, update, "handled", result);
            console.log("telegram webhook handled", {
              requestId,
              updateId: update?.update_id ?? null,
              replied: Boolean(result?.replied),
              handled: Boolean(result),
            });
          } catch (error) {
            await recordTelegramUpdateAudit(env.DB, update, "failed", {
              error: error?.message ?? "unknown error",
            });
            console.error("telegram update failed", {
              message: error?.message,
              requestId,
              updateId: update?.update_id,
            });
          }
          return jsonResponse({ ok: true }, 200, requestId);
        }

        if (request.method === "POST" && url.pathname === "/v1/telegram/webhook") {
          assertAuthorized(request, env);
          if (!telegramService?.configureWebhook) {
            throw new HttpError(
              503,
              "telegram webhook configuration is not available",
              "service_not_configured",
            );
          }
          const webhookUrl = `${url.origin}/`;
          const result = await telegramService.configureWebhook(env, webhookUrl);
          return jsonResponse({ data: result }, 200, requestId);
        }

        if (request.method === "POST" && url.pathname === "/v1/channel/index") {
          assertAuthorized(request, env);
          assertDb(env);
          const result = await telegramService.refreshPinnedIndex(env.DB, env);
          return jsonResponse({ data: result }, 200, requestId);
        }

        if (request.method === "POST" && url.pathname === "/v1/catalog/reindex") {
          assertAuthorized(request, env);
          assertDb(env);
          const result = await reindexCatalog({
            db: env.DB,
            ingestService,
            searchService,
            telegramService,
            versionConfig,
            env,
          });
          return jsonResponse({ data: result }, 200, requestId);
        }

        if (request.method === "POST" && url.pathname === "/v1/media") {
          assertAuthorized(request, env);
          assertJsonRequest(request);
          assertBodySize(request);
          assertDb(env);

          const payload = await readJson(request);
          const result = await ingestService.ingest(env.DB, payload);
          return jsonResponse(
            { data: result },
            result.outcome === "created" ? 201 : 200,
            requestId,
          );
        }

        return jsonResponse(
          { error: { code: "not_found", message: "route not found" } },
          404,
          requestId,
        );
      } catch (error) {
        if (error instanceof MediaInputError) {
          return jsonResponse(
            {
              error: {
                code: "invalid_media_payload",
                message: error.message,
                details: error.details,
              },
            },
            400,
            requestId,
          );
        }
        if (error instanceof ReviewActionError) {
          return jsonResponse(
            {
              error: {
                code: error.code,
                message: error.message,
              },
            },
            error.status,
            requestId,
          );
        }
        if (error instanceof HttpError) {
          return jsonResponse(
            {
              error: {
                code: error.code,
                message: error.message,
              },
            },
            error.status,
            requestId,
          );
        }

        console.error("unhandled worker error", {
          message: error?.message,
          requestId,
          stack: error?.stack,
        });
        return jsonResponse(
          {
            error: {
              code: "internal_error",
              message: "internal server error",
            },
          },
          500,
          requestId,
        );
      }
    },
  });
}

class HttpError extends Error {
  constructor(status, message, code = statusCode(status)) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const SEARCH_FILTER_KEYS = new Set([
  "category_id",
  "actor_id",
  "tag_id",
  "code",
  "subtitle",
  "year",
]);

async function handleSearch(searchService, db, url) {
  const params = url.searchParams;
  const filters = {};
  let appliedFilters = 0;

  for (const key of SEARCH_FILTER_KEYS) {
    const value = params.get(key);
    if (value === null) {
      continue;
    }
    appliedFilters += 1;
    if (key === "subtitle") {
      filters.subtitle = value === "1" || value === "true";
    } else if (key === "year") {
      const year = Number(value);
      if (!Number.isInteger(year)) {
        throw new HttpError(400, "year must be an integer", "invalid_filter");
      }
      filters.year = year;
    } else {
      filters[key] = value;
    }
  }
  if (appliedFilters > 5) {
    throw new HttpError(400, "too many filters (max 5)", "invalid_filter");
  }

  let resolution = null;
  const query = params.get("q");
  if (query !== null) {
    const resolved = searchService.resolveQuery(query);
    resolution = resolved.resolution;
    if (!resolution) {
      return {
        query,
        resolution: null,
        page: 1,
        page_size: 0,
        total: 0,
        results: [],
      };
    }
    if (resolution.type === "code") {
      filters.code = resolution.code;
    } else if (resolution.type === "code_prefix") {
      filters.code_prefix = resolution.prefix;
    } else if (resolution.type === "actor") {
      filters.actor_id = resolution.actor_id;
    } else if (resolution.type === "tag") {
      filters.tag_id = resolution.tag_id;
    } else if (resolution.type === "category") {
      filters.category_id = resolution.category_id;
    }
  }

  const page = Number(params.get("page") ?? "1");
  const pageSize = params.get("page_size")
    ? Number(params.get("page_size"))
    : undefined;

  const result = await searchService.findMedia(db, {
    filters,
    page: Number.isInteger(page) ? page : 1,
    pageSize,
  });
  return { query, resolution, ...result };
}

async function reindexCatalog({
  db,
  env,
  ingestService,
  searchService,
  telegramService,
  versionConfig,
}) {
  const rows = (
    await db
      .prepare(
        `SELECT id, raw_payload_json
         FROM media
         WHERE ruleset_version <> ?
           AND status NOT IN ('rejected', 'disabled')
         ORDER BY id
         LIMIT 50`,
      )
      .bind(versionConfig.release.version)
      .all()
  ).results ?? [];

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.raw_payload_json);
    } catch {
      throw new HttpError(
        409,
        `media ${row.id} has invalid raw payload`,
        "invalid_stored_payload",
      );
    }
    await ingestService.ingest(
      db,
      normalizeCatalogPayload(payload, searchService),
    );
  }

  const remainingRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM media
       WHERE ruleset_version <> ?
         AND status NOT IN ('rejected', 'disabled')`,
    )
    .bind(versionConfig.release.version)
    .first();
  const remaining = Number(remainingRow?.total ?? 0);
  const canRefreshTelegramIndex = Boolean(
    env.TELEGRAM_CHANNEL_ID && env.TELEGRAM_BOT_TOKEN,
  );
  const index =
    remaining === 0 && canRefreshTelegramIndex
      ? await telegramService.refreshPinnedIndex(db, env)
      : remaining === 0
        ? { outcome: "skipped", reason: "telegram_not_configured" }
        : null;

  return {
    processed: rows.length,
    remaining,
    ruleset_version: versionConfig.release.version,
    index,
  };
}

function normalizeCatalogPayload(payload, searchService) {
  const tags = (payload.raw_tags ?? [])
    .map((rawTag) => rawTag.trim().replace(/[，,。.!！?？；;：:、]+$/gu, ""))
    .filter(Boolean);
  const tagActors = tags.flatMap((tag) => {
    const { resolution } = searchService.resolveQuery(tag);
    return resolution?.type === "actor" ? [resolution.display_name] : [];
  });
  return {
    ...payload,
    actors: [...new Set([...(payload.actors ?? []), ...tagActors])],
    raw_tags: [...new Set(tags)],
  };
}

async function recordTelegramUpdateAudit(db, update, outcome, result = null) {
  // The audit intentionally excludes captions, titles, filenames, sender data,
  // and media identifiers. It only answers whether a Telegram update arrived
  // and whether the record-only handler completed.
  if (!db?.prepare || !Number.isInteger(update?.update_id)) {
    return;
  }
  const post = update.channel_post ?? update.edited_channel_post ?? update.message;
  const updateType = update.edited_channel_post
    ? "edited_channel_post"
    : update.channel_post
      ? "channel_post"
      : update.message
        ? "message"
        : "other";
  const safeDetail = JSON.stringify({
    media_kind: telegramMediaKind(post),
    has_caption: Boolean(post?.caption),
    has_text: Boolean(post?.text),
    caption_hashtag_count: countHashtags(post?.caption ?? post?.text),
    has_media_group: Boolean(post?.media_group_id),
    is_forwarded: Boolean(post?.forward_origin ?? post?.forward_from),
    handled: Boolean(result),
    ingested: Boolean(result?.ingested),
    synchronized: Boolean(result?.synchronized),
    remapped: Boolean(result?.remapped),
    ignored: result?.ignored ?? null,
    error: result?.error ?? null,
  });
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO telegram_update_audit (
           update_id, update_type, chat_id, message_id, outcome, detail, received_at, handled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(update_id) DO UPDATE SET
           outcome = excluded.outcome,
           detail = excluded.detail,
           handled_at = excluded.handled_at`,
      )
      .bind(
        update.update_id,
        updateType,
        post?.chat?.id ? String(post.chat.id) : null,
        post?.message_id ?? null,
        outcome,
        safeDetail,
        now,
        outcome === "received" ? null : now,
      )
      .run();
  } catch (error) {
    // Auditing can never disrupt Telegram acknowledgement or media indexing.
    console.warn("telegram update audit failed", { message: error?.message });
  }
}

function telegramMediaKind(post) {
  if (!post) {
    return null;
  }
  for (const type of ["video", "document", "animation", "video_note"]) {
    if (post[type]) {
      return type;
    }
  }
  return null;
}

function countHashtags(value) {
  if (typeof value !== "string") {
    return 0;
  }
  return [...value.matchAll(/#[^\s#｜|]+/gu)].length;
}

function assertReviewer(request, env) {
  if (!env.REVIEW_TOKEN_EDITOR && !env.REVIEW_TOKEN_ADMIN) {
    throw new HttpError(
      503,
      "review tokens are not configured",
      "service_not_configured",
    );
  }
  const authorization = request.headers.get("authorization");
  if (env.REVIEW_TOKEN_ADMIN && authorization === `Bearer ${env.REVIEW_TOKEN_ADMIN}`) {
    return { role: "admin" };
  }
  if (env.REVIEW_TOKEN_EDITOR && authorization === `Bearer ${env.REVIEW_TOKEN_EDITOR}`) {
    return { role: "editor" };
  }
  throw new HttpError(401, "invalid bearer token", "unauthorized");
}

function assertTelegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new HttpError(
      503,
      "TELEGRAM_WEBHOOK_SECRET is not configured",
      "service_not_configured",
    );
  }
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    throw new HttpError(401, "invalid webhook secret", "unauthorized");
  }
}

function assertDb(env) {
  if (!env.DB) {
    throw new HttpError(503, "database binding DB is not configured");
  }
}

function assertAuthorized(request, env) {
  if (!env.INGEST_TOKEN) {
    throw new HttpError(
      503,
      "INGEST_TOKEN is not configured",
      "service_not_configured",
    );
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${env.INGEST_TOKEN}`) {
    throw new HttpError(401, "invalid bearer token", "unauthorized");
  }
}

function assertJsonRequest(request) {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      415,
      "content-type must be application/json",
      "unsupported_media_type",
    );
  }
}

function assertBodySize(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body is too large", "payload_too_large");
  }
}

async function readJson(request) {
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body is too large", "payload_too_large");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, "request body must be valid JSON", "invalid_json");
  }
}

function jsonResponse(body, status, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

function statusCode(status) {
  return `http_${status}`;
}
