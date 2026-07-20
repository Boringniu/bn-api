import { normalizeValue } from "./value-normalizer.mjs";

const TELEGRAM_API = "https://api.telegram.org";
// Telegram hard limit is 4096 chars per message; leave headroom.
const PAGE_CHAR_LIMIT = 3800;
const TAGS_PER_LINE = 5;

export function createTelegramService({
  categoryConfig,
  displayConfig,
  ingestService = null,
  searchConfig,
  searchService,
  versionConfig,
  fetchImpl = fetch,
}) {
  for (const [name, value] of Object.entries({
    categoryConfig,
    displayConfig,
    searchConfig,
    searchService,
    versionConfig,
  })) {
    if (!value || typeof value !== "object") {
      throw new TypeError(`${name} is required`);
    }
  }

  const channelIndex = displayConfig.channel_index;
  const botResult = displayConfig.bot_result;
  const hashtagRules = displayConfig.hashtag_rules;
  const categoryDisplayNames = new Map(
    categoryConfig.items.map((item) => [item.category_id, item.display_name]),
  );

  return Object.freeze({
    renderChannelPost(media) {
      const categoryTags = media.category
        ? [hashtag(media.category.display_name, channelIndex.category_prefix)]
        : [];
      const actorTags = media.actors
        .slice(0, channelIndex.max_actors)
        .map((actor) => hashtag(actor.display_name, channelIndex.actor_prefix));
      const typeTags = media.tags
        .slice(0, channelIndex.max_tags)
        .map((tag) => hashtag(tag.display_name, channelIndex.tag_prefix));

      let text = channelIndex.template
        .replaceAll("{{category_tags}}", categoryTags.filter(Boolean).join(" "))
        .replaceAll("{{actor_tags}}", actorTags.filter(Boolean).join(" "))
        .replaceAll("{{type_tags}}", typeTags.filter(Boolean).join(" "));

      if (channelIndex.hide_empty_actor_block && actorTags.length === 0) {
        text = text.replace(`\n\n${channelIndex.actors_label}\n`, "\n");
      }
      if (channelIndex.hide_empty_tag_block && typeTags.length === 0) {
        text = text.replace(`\n\n${channelIndex.tags_label}\n`, "\n");
      }
      return text.replace(/\n{3,}/gu, "\n\n").trim();
    },

    renderBotResults({ query, page, page_size, total, results }, { isAuthorized = false } = {}) {
      if (results.length === 0) {
        return "没有找到匹配的内容。";
      }
      const lines = [];
      if (botResult.show_video_count) {
        lines.push(`共 ${total} 条结果`);
      }
      const start = (page - 1) * page_size;
      for (const [index, media] of results.entries()) {
        const parts = [];
        if (botResult.show_result_number) {
          parts.push(`${start + index + 1}.`);
        }
        if (botResult.show_code && media.code) {
          parts.push(media.code);
        }
        if (botResult.show_actors && media.actors.length > 0) {
          parts.push(
            media.actors
              .slice(0, botResult.max_actors)
              .map((actor) => actor.display_name)
              .join(" "),
          );
        }
        if (botResult.show_category && media.category) {
          parts.push(`[${media.category.display_name}]`);
        }
        if (botResult.show_tags && media.tags.length > 0) {
          parts.push(
            media.tags
              .slice(0, botResult.max_tags)
              .map((tag) => `#${tag.display_name}`)
              .join(" "),
          );
        }
        lines.push(parts.join(" "));
        if (botResult.show_source_link && isAuthorized && media.source_url) {
          lines.push(media.source_url);
        }
      }
      const totalPages = Math.max(1, Math.ceil(total / page_size));
      if (totalPages > 1) {
        lines.push(`第 ${page}/${totalPages} 页，发送 /page ${page + 1} 查看下一页`);
      }
      return lines.join("\n");
    },

    async handleUpdate(db, update, env) {
      if (update?.channel_post) {
        return this.handleChannelPost(db, update.channel_post, env);
      }
      const message = update?.message;
      const text = message?.text?.trim();
      if (!message || !text) {
        return null;
      }
      const chatId = message.chat.id;
      const userId = String(message.from?.id ?? "");

      let reply;
      if (text === "/start" || text === "/help") {
        reply =
          "发送演员、标签、分类或番号即可搜索。\n" +
          "示例：希岛爱理 / 人妻 / ABP-123 / 中字";
      } else {
        const query = text.replace(/^\/search\s+/u, "");
        const { resolution } = searchService.resolveQuery(query);
        const searchResult = resolution
          ? await searchService.findMedia(db, {
              filters: resolutionFilters(resolution),
              page: 1,
              pageSize: botResult.page_size,
            })
          : { page: 1, page_size: botResult.page_size, total: 0, results: [] };

        await logSearch(db, {
          userId,
          query,
          resolution,
          resultCount: searchResult.total,
        });

        reply = this.renderBotResults(
          { query, ...searchResult },
          { isAuthorized: isAdmin(userId, env) },
        );
      }

      await this.callTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: reply,
      });
      return { chat_id: chatId, replied: true };
    },

    // A video posted (or forwarded) into the channel becomes the source of
    // truth: ingest it through the normal pipeline, remember its file_id and
    // message id, and append the hashtag line to its caption so the pinned
    // index can reach it.
    async handleChannelPost(db, post, env) {
      const channelId = String(env.TELEGRAM_CHANNEL_ID ?? "");
      if (String(post.chat?.id ?? "") !== channelId) {
        return null;
      }
      const video = post.video ?? post.document;
      if (!video || !ingestService) {
        return null;
      }

      // A copy the bot just made of an existing video arrives here as a
      // fresh channel_post; remap the tracked message instead of ingesting
      // a duplicate media row.
      const known = await db
        .prepare(
          `SELECT media_id FROM media_files
           WHERE tg_file_unique_id = ?1 OR tg_file_id = ?2
           LIMIT 1`,
        )
        .bind(video.file_unique_id ?? "", video.file_id)
        .first();
      if (known) {
        await db
          .prepare(
            `UPDATE channel_posts SET tg_message_id = ?, updated_at = ?
             WHERE media_id = ?`,
          )
          .bind(post.message_id, new Date().toISOString(), known.media_id)
          .run();
        return { remapped: known.media_id };
      }

      const rawText = (post.caption ?? "").trim();
      const fileName = (video.file_name ?? "").replace(
        /\.(mp4|mkv|avi|wmv|ts)$/iu,
        "",
      );
      const parsed = parseChannelTitle(
        rawText || fileName || `视频 ${post.message_id}`,
      );
      // Sentence fragments survive the syntactic filter. When the first
      // line reads like a name list (no sentence punctuation), keep Han
      // tokens for pending_actor review; when it reads like a sentence,
      // keep only dictionary hits and kana tokens.
      const sentenceLike = /[，。！？!?,；;～~…]/u.test(
        (rawText || fileName).split(/\n/u)[0] ?? "",
      );
      const actors = parsed.actors.filter((token) => {
        const { resolution } = searchService.resolveQuery(token);
        if (resolution?.type === "actor") {
          return true;
        }
        if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) {
          return true;
        }
        return !sentenceLike && token.length <= 8;
      });

      // The channel owner declares default tags for everything posted here
      // (usually the category word); parsed hashtags take precedence.
      const defaultTags = (env.TELEGRAM_CHANNEL_DEFAULT_TAGS ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const rawTags = [...new Set([...parsed.raw_tags, ...defaultTags])];

      const payload = {
        source: {
          provider: "channel",
          external_id: `${channelId}:${post.message_id}`,
        },
        title: parsed.title,
        raw_tags: rawTags.length > 0 ? rawTags : ["未分类"],
        metadata: {
          tg_file_id: video.file_id,
          tg_message_id: String(post.message_id),
        },
      };
      if (actors.length > 0) {
        payload.actors = actors;
      }
      if (parsed.description) {
        payload.description = parsed.description;
      }
      if (parsed.code) {
        payload.code = parsed.code;
      }

      const result = await ingestService.ingest(db, payload);
      const timestamp = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO media_files (
             media_id, tg_file_id, tg_file_unique_id, source_chat_id,
             source_message_id, imported_from, created_at
           ) VALUES (?, ?, ?, ?, ?, 'channel', ?)
           ON CONFLICT (media_id) DO UPDATE SET
             tg_file_id = excluded.tg_file_id,
             tg_file_unique_id = excluded.tg_file_unique_id,
             source_chat_id = excluded.source_chat_id,
             source_message_id = excluded.source_message_id`,
        )
        .bind(
          result.id,
          video.file_id,
          video.file_unique_id ?? null,
          channelId,
          String(post.message_id),
          timestamp,
        )
        .run();
      await db
        .prepare(
          `INSERT INTO channel_posts (
             media_id, tg_chat_id, tg_message_id, template_version,
             posted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (media_id) DO UPDATE SET
             tg_message_id = excluded.tg_message_id,
             updated_at = excluded.updated_at`,
        )
        .bind(
          result.id,
          channelId,
          post.message_id,
          versionConfig.release.version,
          timestamp,
          timestamp,
        )
        .run();

      // Rewrite the caption with the standard hashtag block when the media
      // is approved; leave the original caption alone otherwise.
      if (result.status === "approved") {
        const media = {
          id: result.id,
          category: result.category
            ? {
                category_id: result.category.category_id,
                display_name: result.category.display_name,
              }
            : null,
          actors: result.actors ?? [],
          tags: result.tags ?? [],
        };
        const hashtagBlock = this.renderChannelPost(media);
        const firstLine = rawText.split(/\n/u)[0] ?? "";
        const caption = (firstLine
          ? `${firstLine}\n\n${hashtagBlock}`
          : hashtagBlock
        ).slice(0, 1024);
        try {
          await this.callTelegram(env, "editMessageCaption", {
            chat_id: channelId,
            message_id: post.message_id,
            caption,
          });
        } catch (error) {
          if (String(error.message).includes("message can't be edited")) {
            // Forwarded messages cannot be edited by anyone. The owner has
            // opted to leave forwarded videos untouched; replacing them with
            // a captioned bot copy is available behind an explicit flag.
            if (env.TELEGRAM_REPLACE_FORWARDS === "1") {
              await this.replaceWithCopy(db, env, {
                caption,
                channelId,
                mediaId: result.id,
                messageId: post.message_id,
              });
            }
          } else if (!String(error.message).includes("message is not modified")) {
            console.warn("caption update failed", {
              message: error.message,
              messageId: post.message_id,
            });
          }
        }
        // Keep the pinned index live: every approved channel video refreshes
        // it immediately. Failures must not break the ingest ack to Telegram.
        try {
          await this.refreshPinnedIndex(db, env);
        } catch (error) {
          console.warn("pinned index refresh failed", {
            message: error.message,
          });
        }
      }

      return { ingested: result.id, status: result.status };
    },

    async replaceWithCopy(db, env, { caption, channelId, mediaId, messageId }) {
      try {
        const copied = await this.callTelegram(env, "copyMessage", {
          chat_id: channelId,
          from_chat_id: channelId,
          message_id: messageId,
          caption,
          disable_notification: true,
        });
        await this.callTelegram(env, "deleteMessage", {
          chat_id: channelId,
          message_id: messageId,
        });
        await db
          .prepare(
            `UPDATE channel_posts SET tg_message_id = ?, updated_at = ?
             WHERE media_id = ?`,
          )
          .bind(copied.message_id, new Date().toISOString(), mediaId)
          .run();
        return copied.message_id;
      } catch (error) {
        console.warn("copy replacement failed", {
          mediaId,
          message: error.message,
        });
        return null;
      }
    },

    // Compare channel_posts against the live channel and drop rows whose
    // message has been deleted by hand; cascade-remove the media so search
    // and the pinned index stay honest.
    async reconcileChannel(db, env, { deleteMedia = true } = {}) {
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }
      const rows = (
        await db
          .prepare(
            "SELECT media_id, tg_message_id FROM channel_posts ORDER BY tg_message_id",
          )
          .all()
      ).results ?? [];

      const missing = [];
      for (const row of rows) {
        // forwardMessage to the channel itself is the cheapest existence
        // probe Telegram offers; copyMessage avoids the "forwarded from"
        // header and can be deleted immediately.
        try {
          const copied = await this.callTelegram(env, "copyMessage", {
            chat_id: channelId,
            from_chat_id: channelId,
            message_id: row.tg_message_id,
            disable_notification: true,
          });
          await this.callTelegram(env, "deleteMessage", {
            chat_id: channelId,
            message_id: copied.message_id,
          });
        } catch (error) {
          if (/message to copy not found|MESSAGE_ID_INVALID/iu.test(error.message)) {
            missing.push(row);
          } else {
            throw error;
          }
        }
      }

      for (const row of missing) {
        if (deleteMedia) {
          await db
            .prepare("DELETE FROM media WHERE id = ?")
            .bind(row.media_id)
            .run();
        } else {
          await db
            .prepare("DELETE FROM channel_posts WHERE media_id = ?")
            .bind(row.media_id)
            .run();
        }
      }

      return {
        checked: rows.length,
        removed: missing.map((row) => ({
          media_id: row.media_id,
          tg_message_id: row.tg_message_id,
        })),
      };
    },

    async publishToChannel(db, media, env) {
      if (!channelIndex.enabled) {
        return { published: false, reason: "channel_index_disabled" };
      }
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }

      const text = this.renderChannelPost(media);
      const file = await db
        .prepare("SELECT tg_file_id FROM media_files WHERE media_id = ?")
        .bind(media.id)
        .first();
      const existing = await db
        .prepare("SELECT tg_message_id FROM channel_posts WHERE media_id = ?")
        .bind(media.id)
        .first();
      const timestamp = new Date().toISOString();

      if (existing) {
        const method = file ? "editMessageCaption" : "editMessageText";
        const payload = file
          ? { chat_id: channelId, message_id: existing.tg_message_id, caption: text }
          : { chat_id: channelId, message_id: existing.tg_message_id, text };
        let vanished = false;
        try {
          await this.callTelegram(env, method, payload);
        } catch (error) {
          if (String(error.message).includes("message is not modified")) {
            // Telegram rejects edits that leave the message unchanged; that
            // still counts as the channel being up to date.
          } else if (
            /message to edit not found|MESSAGE_ID_INVALID/iu.test(error.message)
          ) {
            // The message was deleted by hand; fall through and repost.
            vanished = true;
          } else {
            throw error;
          }
        }
        if (!vanished) {
          await db
            .prepare(
              "UPDATE channel_posts SET template_version = ?, updated_at = ? WHERE media_id = ?",
            )
            .bind(versionConfig.release.version, timestamp, media.id)
            .run();
          return {
            published: true,
            outcome: "edited",
            tg_message_id: existing.tg_message_id,
          };
        }
        await db
          .prepare("DELETE FROM channel_posts WHERE media_id = ?")
          .bind(media.id)
          .run();
      }

      const sent = file
        ? await this.callTelegram(env, "sendVideo", {
            chat_id: channelId,
            video: file.tg_file_id,
            caption: text,
          })
        : await this.callTelegram(env, "sendMessage", {
            chat_id: channelId,
            text,
          });
      await db
        .prepare(
          `INSERT INTO channel_posts (
             media_id, tg_chat_id, tg_message_id, template_version,
             posted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          media.id,
          String(channelId),
          sent.message_id,
          versionConfig.release.version,
          timestamp,
          timestamp,
        )
        .run();
      return {
        published: true,
        outcome: "created",
        kind: file ? "video" : "text",
        tg_message_id: sent.message_id,
      };
    },

    async refreshPinnedIndex(db, env) {
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }

      const [categoryRows, actorRows, tagRows] = await db.batch([
        db.prepare(`
          SELECT m.category_id, COUNT(*) AS media_count
          FROM media m
          JOIN channel_posts c ON c.media_id = m.id
          WHERE m.status = 'approved' AND m.category_id IS NOT NULL
          GROUP BY m.category_id
        `),
        db.prepare(`
          SELECT DISTINCT a.display_name_snapshot AS display_name
          FROM media_actors a
          JOIN channel_posts c ON c.media_id = a.media_id
          JOIN media m ON m.id = a.media_id
          WHERE m.status = 'approved' AND a.display_enabled = 1
          ORDER BY a.display_name_snapshot
        `),
        db.prepare(`
          SELECT a.display_name_snapshot AS display_name, MAX(a.weight) AS weight
          FROM media_tags a
          JOIN channel_posts c ON c.media_id = a.media_id
          JOIN media m ON m.id = a.media_id
          WHERE m.status = 'approved' AND a.display_enabled = 1
          GROUP BY a.display_name_snapshot
          ORDER BY weight DESC, a.display_name_snapshot
        `),
      ]);

      const pages = this.renderIndexPages({
        categories: categoryRows.results ?? [],
        actors: actorRows.results ?? [],
        tags: tagRows.results ?? [],
      });

      const stored = await readIndexMessageIds(db);
      const messageIds = [];
      let pinnedNew = false;

      for (const [pageIndex, text] of pages.entries()) {
        const existingId = stored[pageIndex];
        if (existingId) {
          try {
            await this.callTelegram(env, "editMessageText", {
              chat_id: channelId,
              message_id: existingId,
              text,
            });
            messageIds.push(existingId);
            continue;
          } catch (error) {
            if (String(error.message).includes("message is not modified")) {
              messageIds.push(existingId);
              continue;
            }
            if (!/message to edit not found|MESSAGE_ID_INVALID/iu.test(error.message)) {
              throw error;
            }
            // Deleted by hand: fall through and send a replacement page.
          }
        }
        const sent = await this.callTelegram(env, "sendMessage", {
          chat_id: channelId,
          text,
        });
        messageIds.push(sent.message_id);
        if (pageIndex === 0) {
          await this.callTelegram(env, "pinChatMessage", {
            chat_id: channelId,
            message_id: sent.message_id,
            disable_notification: true,
          });
          pinnedNew = true;
        }
      }

      for (const surplusId of stored.slice(pages.length)) {
        try {
          await this.callTelegram(env, "deleteMessage", {
            chat_id: channelId,
            message_id: surplusId,
          });
        } catch {
          // Already gone is fine.
        }
      }

      await db
        .prepare(
          `INSERT INTO database_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(
          "channel_index_message_ids",
          JSON.stringify(messageIds),
          new Date().toISOString(),
        )
        .run();

      return {
        outcome: pinnedNew ? "pinned" : "edited",
        pages: pages.length,
        message_ids: messageIds,
      };
    },

    renderIndexPages({ categories, actors, tags }) {
      const categoryTags = categories
        .map((row) => {
          const display = categoryDisplayNames.get(row.category_id);
          if (!display) {
            return null;
          }
          const tag = hashtag(display, channelIndex.category_prefix);
          return tag ? `${tag} (${row.media_count})` : null;
        })
        .filter(Boolean);
      const actorTags = actors
        .map((row) => hashtag(row.display_name, channelIndex.actor_prefix))
        .filter(Boolean);
      const typeTags = tags
        .map((row) => hashtag(row.display_name, channelIndex.tag_prefix))
        .filter(Boolean);

      const blocks = [
        { label: channelIndex.category_label, lines: chunkTags(categoryTags) },
        { label: channelIndex.actors_label, lines: chunkTags(actorTags) },
        { label: channelIndex.tags_label, lines: chunkTags(typeTags) },
      ];

      const pages = [];
      let current = channelIndex.title;
      const pushPage = () => {
        pages.push(current.trim());
        current = `${channelIndex.title}（续）`;
      };

      for (const block of blocks) {
        let blockHeader = `\n\n${block.label}`;
        if (current.length + blockHeader.length > PAGE_CHAR_LIMIT) {
          pushPage();
        }
        current += blockHeader;
        let continued = false;
        for (const line of block.lines) {
          if (current.length + line.length + 1 > PAGE_CHAR_LIMIT) {
            pushPage();
            current += `\n\n${block.label}（续）`;
            continued = true;
          }
          current += `\n${line}`;
        }
      }
      pushPage();
      return pages;
    },

    async callTelegram(env, method, payload) {
      if (!env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not configured");
      }
      const response = await fetchImpl(
        `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json();
      if (!body.ok) {
        throw new Error(`telegram ${method} failed: ${body.description}`);
      }
      return body.result;
    },
  });

  function hashtag(displayName, prefix) {
    if (!hashtagRules.enabled) {
      return `${prefix}${displayName}`;
    }
    let value = displayName;
    for (const [from, to] of Object.entries(hashtagRules.replace_characters)) {
      value = value.replaceAll(from, to);
    }
    if (hashtagRules.remove_spaces) {
      value = value.replace(/\s+/gu, "");
    }
    if (value.length === 0 || value.length > hashtagRules.max_length) {
      // on_invalid_hashtag: skip_and_log
      console.warn("skipped invalid hashtag", { displayName });
      return null;
    }
    return `${prefix}${value}`;
  }

  async function logSearch(db, { userId, query, resolution, resultCount }) {
    await db
      .prepare(
        `INSERT INTO search_logs (
           tg_user_id, query, normalized_query, resolution_type,
           resolution_target, result_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId || null,
        query,
        normalizeValue(query),
        resolution?.type ?? null,
        resolution
          ? (resolution.actor_id ??
            resolution.tag_id ??
            resolution.category_id ??
            resolution.code ??
            resolution.prefix ??
            null)
          : null,
        resultCount,
        new Date().toISOString(),
      )
      .run();
  }
}

// Parse a channel caption or file name into ingest fields. The observed
// format is "CODE #tag #tag 演员名｜演员名" on the first line with free
// description text below. Codes require a real separator or an all-caps
// prefix so runs like "Join_file_034356268" or "Pu229每日更新" never match.
export function parseChannelTitle(rawTitle) {
  const title = rawTitle.trim();
  const [firstLine = "", ...restLines] = title.split(/\n+/u);

  let code = null;
  for (const match of firstLine.matchAll(
    /(?<![A-Za-z0-9_])([A-Za-z]{2,6})[-_ ]?(\d{2,5})(?![0-9])/gu,
  )) {
    if (/[-_ ]/u.test(match[0]) || match[1] === match[1].toUpperCase()) {
      code = `${match[1].toUpperCase()}-${match[2]}`;
      break;
    }
  }

  const raw_tags = [...title.matchAll(/#([^\s#｜|]+)/gu)]
    .map((match) => match[1])
    .slice(0, 20);

  const actors = firstLine
    .replace(/#[^\s#｜|]+/gu, " ")
    .split(/[\s｜|、/,，·]+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        token.length <= 12 &&
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/u.test(token) &&
        !/[\[\]【】()（）:：…。.!？?～~]/u.test(token) &&
        !/^[A-Za-z]{2,6}[-_ ]?\d{2,5}/u.test(token),
    )
    .slice(0, 20);

  const description = restLines.join("\n").trim() || null;

  return { title, code, raw_tags, actors, description };
}

function chunkTags(tags) {
  const lines = [];
  for (let i = 0; i < tags.length; i += TAGS_PER_LINE) {
    lines.push(tags.slice(i, i + TAGS_PER_LINE).join(" "));
  }
  return lines;
}

async function readIndexMessageIds(db) {
  const row = await db
    .prepare("SELECT value FROM database_metadata WHERE key = ?")
    .bind("channel_index_message_ids")
    .first();
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        return parsed.map(Number);
      }
    } catch {
      // fall through to legacy single-id key
    }
  }
  const legacy = await db
    .prepare("SELECT value FROM database_metadata WHERE key = ?")
    .bind("channel_pinned_index_message_id")
    .first();
  return legacy?.value ? [Number(legacy.value)] : [];
}

function resolutionFilters(resolution) {
  switch (resolution.type) {
    case "code":
      return { code: resolution.code };
    case "code_prefix":
      return { code_prefix: resolution.prefix };
    case "actor":
      return { actor_id: resolution.actor_id };
    case "tag":
      return { tag_id: resolution.tag_id };
    case "category":
      return { category_id: resolution.category_id };
    default:
      return {};
  }
}

function isAdmin(userId, env) {
  const admins = (env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return admins.includes(userId);
}
