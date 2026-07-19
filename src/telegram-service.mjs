import { normalizeValue } from "./value-normalizer.mjs";

const TELEGRAM_API = "https://api.telegram.org";

export function createTelegramService({
  displayConfig,
  searchConfig,
  searchService,
  versionConfig,
  fetchImpl = fetch,
}) {
  for (const [name, value] of Object.entries({
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

    async publishToChannel(db, media, env) {
      if (!channelIndex.enabled) {
        return { published: false, reason: "channel_index_disabled" };
      }
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }

      const text = this.renderChannelPost(media);
      const existing = await db
        .prepare("SELECT tg_message_id FROM channel_posts WHERE media_id = ?")
        .bind(media.id)
        .first();
      const timestamp = new Date().toISOString();

      if (existing) {
        try {
          await this.callTelegram(env, "editMessageText", {
            chat_id: channelId,
            message_id: existing.tg_message_id,
            text,
          });
        } catch (error) {
          // Telegram rejects edits that leave the message unchanged; that
          // still counts as the channel being up to date.
          if (!String(error.message).includes("message is not modified")) {
            throw error;
          }
        }
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

      const sent = await this.callTelegram(env, "sendMessage", {
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
      return { published: true, outcome: "created", tg_message_id: sent.message_id };
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
