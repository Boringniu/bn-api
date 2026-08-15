import { normalizeValue } from "./value-normalizer.mjs";

const TELEGRAM_API = "https://api.telegram.org";
// Telegram hard limit is 4096 chars per message; leave headroom.
const PAGE_CHAR_LIMIT = 3800;
const TAGS_PER_LINE = 5;
const PENDING_CHANNEL_CONTEXT_PREFIX = "channel_pending_caption_context:";
const PENDING_CHANNEL_CONTEXT_MESSAGE_WINDOW = 6;
const PENDING_FORWARD_GROUP_PREFIX = "channel_pending_forward_group:";
const DEFAULT_MEDIA_GROUP_SETTLE_MS = 2_000;

export function createTelegramService({
  categoryConfig,
  displayConfig,
  ingestService = null,
  searchConfig,
  searchService,
  versionConfig,
  fetchImpl = fetch,
  mediaGroupSettleMs = DEFAULT_MEDIA_GROUP_SETTLE_MS,
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
  if (!Number.isInteger(mediaGroupSettleMs) || mediaGroupSettleMs < 0) {
    throw new TypeError("mediaGroupSettleMs must be a non-negative integer");
  }

  return Object.freeze({
    renderChannelPost(media) {
      const categoryTags = channelIndex.show_category && media.category
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

    renderBotResults({ results, page = 1, page_size = results.length || 1 }) {
      if (results.length === 0) {
        return "没有找到匹配的内容。";
      }
      const offset = (page - 1) * page_size;
      return results
        .map((media, index) => renderDirectoryEntry(media, offset + index + 1))
        .join("\n");
    },

    async handleSearchNavigation(db, callback, env) {
      const chatId = callback?.message?.chat?.id;
      if (!chatId || callback?.message?.chat?.type !== "private") {
        return { ignored: "non_private_callback" };
      }
      const navigation = decodeSearchNavigation(callback.data);
      if (!navigation) {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "导航已失效，请重新搜索。",
        });
        return { ignored: "invalid_search_navigation" };
      }

      const search = await resolveDirectorySearch(db, navigation.query, navigation.page);
      const reply = renderSearchReply({
        query: navigation.query,
        resolution: search.resolution,
        searchResult: search.result,
      });
      const replyMarkup = buildSearchNavigationMarkup(
        navigation.query,
        search.result,
      );

      await this.callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
      });
      try {
        await this.callTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: reply,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (error) {
        if (!String(error.message).includes("message is not modified")) {
          throw error;
        }
      }
      return { chat_id: chatId, replied: true, page: navigation.page };
    },

    async handleUpdate(db, update, env) {
      if (update?.channel_post) {
        return this.handleChannelPost(db, update.channel_post, env);
      }
      if (update?.edited_channel_post) {
        return this.handleEditedChannelPost(db, update.edited_channel_post, env);
      }
      if (update?.callback_query) {
        return this.handleSearchNavigation(db, update.callback_query, env);
      }
      const message = update?.message;
      const text = message?.text?.trim();
      // 私聊 Bot 只承担番号查询；群组和频道里的普通消息不响应。
      if (!message || message.chat?.type !== "private" || !text) {
        return null;
      }
      const chatId = message.chat.id;
      const userId = String(message.from?.id ?? "");
      const isUserAdmin = isAdmin(userId, env);

      let reply;
      let replyMarkup = null;
      if (text === "/index") {
        const [indexMessageId] = await readIndexMessageIds(db);
        const indexUrl = channelMessageUrl(
          env.TELEGRAM_CHANNEL_ID,
          indexMessageId,
        );
        reply = indexUrl
          ? `📚 <a href="${escapeHtml(indexUrl)}">跳转频道索引</a>`
          : "频道索引暂未生成。";
      } else if (text === "/about" || text === "/start" || text === "/help") {
        reply =
          "BN·media\n\n" +
          "直接输入番号前缀或女优名即可查询。\n" +
          "例如：ADN、白雪\n\n" +
          "/index - 跳转频道索引\n" +
          "/refresh - 刷新频道索引（管理员）";
      } else if (text === "/refresh") {
        if (!isUserAdmin) {
          reply = "权限不足";
        } else {
          try {
            await this.refreshPinnedIndex(db, env);
            reply = "✅ 置顶索引已刷新";
          } catch (err) {
            console.error("refresh failed", err);
            reply = "❌ 刷新失败：" + err.message;
          }
        }
      } else {
        const query = text.replace(/^\/search\s+/u, "");
        const search = await resolveDirectorySearch(db, query, 1);

        await logSearch(db, {
          userId,
          query,
          resolution: search.resolution,
          resultCount: search.result.total,
        });

        reply = renderSearchReply({
          query,
          resolution: search.resolution,
          searchResult: search.result,
        });
        replyMarkup = buildSearchNavigationMarkup(query, search.result);
      }

      await this.callTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: reply,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return { chat_id: chatId, replied: true };
    },

    // 私人频道只由管理员维护：原生发布直接入库；经授权的转发则复制为
    // 无来源副本并删除原转发，再对副本建立索引。
    async handleChannelPost(db, post, env, { skipIndexRefresh = false } = {}) {
      const channelId = String(env.TELEGRAM_CHANNEL_ID ?? "");
      if (String(post.chat?.id ?? "") !== channelId) {
        return null;
      }
      if (shouldStripForwardSource(post, env) && post.media_group_id) {
        return this.bufferForwardedMediaGroup(db, post, channelId, env);
      }
      const stripped = await this.stripForwardSource(post, channelId, env);
      if (stripped) {
        post = {
          ...post,
          message_id: stripped.message_id,
          forward_origin: null,
          forward_from: null,
        };
      }
      const video = resolveTelegramMedia(post);
      if (!video) {
        const context = await storePendingChannelContext(db, post, channelId);
        return stripped
          ? { ...(context ?? {}), source_stripped: true, copied_message_id: post.message_id }
          : context;
      }
      if (!ingestService) {
        return null;
      }

      // 同一 Telegram 文件再次出现时只更新消息映射，避免重复建档。
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

      const rawText = readPostText(post);
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
      const contentTags = parsed.raw_tags
        .map(cleanTopicValue)
        .filter(Boolean);
      const inheritedContext =
        contentTags.length === 0
          ? await readPendingChannelContext(db, channelId, post.message_id, parsed.code)
          : null;

      // 所有 #话题 都是平级元数据；即便标签恰好是演员名，也必须保留为话题。
      const rawTags = [
        ...new Set([...contentTags, ...(inheritedContext?.raw_tags ?? [])]),
      ];
      const knownTagActors = resolveKnownActorTags(rawTags, searchService);
      const resolvedActors = [...new Set([...actors, ...knownTagActors])];

      const payload = {
        source: {
          provider: "channel",
          external_id: `${channelId}:${post.message_id}`,
        },
        title: parsed.title,
        raw_tags: rawTags,
        metadata: {
          tg_file_id: video.file_id,
          tg_message_id: String(post.message_id),
        },
      };
      if (resolvedActors.length > 0) {
        payload.actors = resolvedActors;
      }
      if (parsed.description) {
        payload.description = parsed.description;
      }
      if (parsed.code ?? inheritedContext?.code) {
        payload.code = parsed.code ?? inheritedContext.code;
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

      if (result.status === "approved" && !skipIndexRefresh) {
        // 审核通过后只刷新置顶索引；刷新失败不能影响本次入库。
        try {
          await this.refreshPinnedIndex(db, env);
        } catch (error) {
          console.warn("pinned index refresh failed", {
            message: error.message,
          });
        }
      }

      const outcome = { ingested: result.id, status: result.status };
      if (stripped) {
        outcome.source_stripped = true;
        outcome.copied_message_id = stripped.message_id;
      }
      return outcome;
    },

    async bufferForwardedMediaGroup(db, post, channelId, env) {
      const groupKey = pendingForwardGroupKey(channelId, post.media_group_id);
      const pending = await appendPendingForwardGroup(db, groupKey, post);
      await delay(mediaGroupSettleMs);

      const posts = sortChannelPosts(await readPendingForwardGroup(db, groupKey));
      const lastMessageId = posts.at(-1)?.message_id;
      if (Number(post.message_id) !== lastMessageId) {
        return {
          buffered: true,
          media_group_id: post.media_group_id,
          collected: pending.length,
        };
      }
      if (!(await claimPendingForwardGroup(db, groupKey))) {
        return { buffered: true, media_group_id: post.media_group_id };
      }

      const copiedMessageIds = await this.stripForwardMediaGroup(
        posts,
        channelId,
        env,
      );

      await writePendingForwardGroupState(db, groupKey, "processed");
      const outcomes = [];
      for (const [index, source] of posts.entries()) {
        const copiedPost = copiedChannelPost(source, copiedMessageIds[index]);
        // 相册的 caption 只会出现在其中一条消息上。复制后先保存它，
        // 让同组后续视频也能继承人工填写的番号与原生话题。
        await storePendingChannelContext(db, copiedPost, channelId);
        outcomes.push(
          await this.handleChannelPost(
            db,
            copiedPost,
            env,
            { skipIndexRefresh: true },
          ),
        );
      }
      if (outcomes.some((outcome) => outcome?.status === "approved")) {
        try {
          await this.refreshPinnedIndex(db, env);
        } catch (error) {
          console.warn("pinned index refresh failed after media group copy", {
            message: error.message,
          });
        }
      }
      return {
        source_stripped: true,
        media_group_id: post.media_group_id,
        copied_message_ids: copiedMessageIds,
        processed: outcomes.filter(Boolean).length,
      };
    },

    async stripForwardMediaGroup(posts, channelId, env) {
      if (!Array.isArray(posts) || posts.length === 0) {
        throw new TypeError("posts must contain at least one media-group message");
      }
      const copied = await this.callTelegram(env, "copyMessages", {
        chat_id: channelId,
        from_chat_id: channelId,
        message_ids: posts.map((post) => post.message_id),
      });
      const copiedMessageIds = Array.isArray(copied)
        ? copied.map((entry) => Number(entry?.message_id)).filter(Number.isInteger)
        : [];
      if (copiedMessageIds.length !== posts.length) {
        throw new Error("copyMessages returned an incomplete media group");
      }
      try {
        for (const source of posts) {
          await this.callTelegram(env, "deleteMessage", {
            chat_id: channelId,
            message_id: source.message_id,
          });
        }
      } catch (error) {
        for (const messageId of copiedMessageIds) {
          try {
            await this.callTelegram(env, "deleteMessage", {
              chat_id: channelId,
              message_id: messageId,
            });
          } catch {
            // Keep the original Telegram error; cleanup is best-effort only.
          }
        }
        throw error;
      }
      return copiedMessageIds;
    },

    async stripForwardSource(post, channelId, env) {
      if (!shouldStripForwardSource(post, env)) {
        return null;
      }
      const copied = await this.callTelegram(env, "copyMessage", {
        chat_id: channelId,
        from_chat_id: channelId,
        message_id: post.message_id,
      });
      try {
        await this.callTelegram(env, "deleteMessage", {
          chat_id: channelId,
          message_id: post.message_id,
        });
      } catch (error) {
        // 删除原转发失败时撤回副本，宁可保留带来源的原消息，也不制造重复内容。
        try {
          await this.callTelegram(env, "deleteMessage", {
            chat_id: channelId,
            message_id: copied.message_id,
          });
        } catch {
          // 保留原始错误供 webhook 审计，回滚失败只记录在 Worker 日志中。
        }
        throw error;
      }
      return copied;
    },

    // 用户直接在频道编辑已重新发布的媒体说明时，Telegram 会发送
    // edited_channel_post。这里绝不重发或改写频道消息，只同步索引数据。
    async handleEditedChannelPost(db, post, env) {
      const channelId = String(env.TELEGRAM_CHANNEL_ID ?? "");
      if (String(post.chat?.id ?? "") !== channelId) {
        return null;
      }
      const video = post.video ?? post.document;
      if (!video || !ingestService) {
        return null;
      }

      const stored = await db
        .prepare(
          `SELECT m.raw_payload_json
           FROM channel_posts c
           JOIN media m ON m.id = c.media_id
           WHERE c.tg_chat_id = ?1 AND c.tg_message_id = ?2
           LIMIT 1`,
        )
        .bind(channelId, post.message_id)
        .first();
      if (!stored?.raw_payload_json) {
        // Worker 上线前已存在的私人频道媒体不会补发 channel_post，只会在
        // 用户编辑时产生 edited_channel_post。私人频道由管理员独占维护，
        // 因此可安全地把这次编辑作为首次入库入口；仍不复制、删除或改写。
        return this.handleChannelPost(db, post, env);
      }

      let previousPayload;
      try {
        previousPayload = JSON.parse(stored.raw_payload_json);
      } catch {
        console.warn("stored channel payload is invalid", {
          message_id: post.message_id,
        });
        return { ignored: "invalid_stored_payload" };
      }

      const payload = buildEditedChannelPayload({
        previousPayload,
        post,
        channelId,
        env,
        searchService,
      });
      const result = await ingestService.ingest(db, payload);

      if (result.status === "approved") {
        try {
          await this.refreshPinnedIndex(db, env);
        } catch (error) {
          console.warn("pinned index refresh failed after channel edit", {
            message: error.message,
          });
        }
      }
      return {
        synchronized: post.message_id,
        ingested: result.id,
        status: result.status,
      };
    },

    async configureWebhook(env, webhookUrl) {
      if (!webhookUrl || !/^https:\/\//u.test(webhookUrl)) {
        throw new Error("webhook URL must use https");
      }
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
      }
      await this.callTelegram(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [
          "message",
          "callback_query",
          "channel_post",
          "edited_channel_post",
        ],
      });
      await this.callTelegram(env, "setMyCommands", {
        commands: [
          { command: "index", description: "跳转频道索引" },
          { command: "refresh", description: "刷新频道索引（管理员）" },
          { command: "about", description: "简介说明" },
        ],
      });
      const info = await this.callTelegram(env, "getWebhookInfo", {});
      let channelMember = null;
      if (env.TELEGRAM_CHANNEL_ID) {
        const self = await this.callTelegram(env, "getMe", {});
        const member = await this.callTelegram(env, "getChatMember", {
          chat_id: env.TELEGRAM_CHANNEL_ID,
          user_id: self.id,
        });
        channelMember = {
          status: member.status ?? null,
          can_post_messages: member.can_post_messages ?? false,
          can_edit_messages: member.can_edit_messages ?? false,
          can_delete_messages: member.can_delete_messages ?? false,
        };
      }
      return {
        url: info.url,
        allowed_updates: info.allowed_updates ?? [],
        pending_update_count: info.pending_update_count ?? 0,
        channel_member: channelMember,
      };
    },

    async refreshPinnedIndex(db, env) {
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }

      const pages = this.renderIndexPages();

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

    renderIndexPages() {
      return [channelIndex.title];
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

  async function resolveDirectorySearch(db, query, page) {
    const { resolution } = searchService.resolveQuery(query);
    const isDirectoryQuery = ["code", "code_prefix", "actor"].includes(
      resolution?.type,
    );
    const result = isDirectoryQuery
      ? await searchService.findMedia(db, {
          filters: resolutionFilters(resolution),
          page,
          pageSize: botResult.page_size,
          includeChannelLinks: true,
        })
      : { page, page_size: botResult.page_size, total: 0, results: [] };
    return { resolution, result };
  }

  function renderSearchReply({ query, resolution, searchResult }) {
    if (!["code", "code_prefix", "actor"].includes(resolution?.type)) {
      return `未识别“${escapeHtml(query)}”。请输入番号前缀（如 ADN）或女优名。`;
    }
    if (searchResult.total === 0) {
      const subject =
        resolution.type === "actor"
          ? `#${resolution.display_name}`
          : `#${resolution.code ?? resolution.prefix ?? query}`;
      return `暂未收录 ${escapeHtml(subject)}。`;
    }
    const offset = (searchResult.page - 1) * searchResult.page_size;
    return searchResult.results
      .map((media, index) => renderDirectoryEntry(media, offset + index + 1))
      .join("\n");
  }

  function buildSearchNavigationMarkup(query, searchResult) {
    const totalPages = Math.ceil(searchResult.total / searchResult.page_size);
    if (totalPages <= 1) {
      return null;
    }
    const buttons = [];
    if (searchResult.page > 1) {
      const data = encodeSearchNavigation(query, searchResult.page - 1);
      if (data) {
        buttons.push({ text: "‹ 上一页", callback_data: data });
      }
    }
    if (searchResult.page < totalPages) {
      const data = encodeSearchNavigation(query, searchResult.page + 1);
      if (data) {
        buttons.push({ text: "下一页 ›", callback_data: data });
      }
    }
    return buttons.length > 0 ? { inline_keyboard: [buttons] } : null;
  }

  function encodeSearchNavigation(query, page) {
    const data = `search:${page}:${encodeURIComponent(query)}`;
    return data.length <= 64 ? data : null;
  }

  function decodeSearchNavigation(data) {
    if (typeof data !== "string") {
      return null;
    }
    const match = /^search:(\d{1,4}):(.+)$/u.exec(data);
    if (!match) {
      return null;
    }
    try {
      const query = decodeURIComponent(match[2]);
      const page = Number(match[1]);
      return query && Number.isInteger(page) && page > 0 ? { query, page } : null;
    } catch {
      return null;
    }
  }

  function renderDirectoryEntry(media, index) {
  const code = media.code ? `#${media.code}` : "#未知编号";
  const channelUrl = channelMessageUrl(
    media.channel_chat_id,
    media.channel_message_id,
  );
  const codeEntry = channelUrl
    ? `<a href="${escapeHtml(channelUrl)}">${escapeHtml(code)}</a>`
    : escapeHtml(code);
  const actress = media.actors?.[0]?.display_name;
  const entry = actress ? `${codeEntry}  #${escapeHtml(actress)}` : codeEntry;
  return `${index} • ${entry}`;
}

function channelMessageUrl(chatId, messageId) {
  const chat = String(chatId ?? "");
  const message = Number(messageId);
  if (!/^-100\d+$/u.test(chat) || !Number.isInteger(message) || message < 1) {
    return null;
  }
  return `https://t.me/c/${chat.slice(4)}/${message}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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
    .map((match) => cleanTopicValue(match[1]))
    .filter(Boolean)
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

function cleanTopicValue(value) {
  return value.trim().replace(/[，,。.!！?？；;：:、]+$/gu, "");
}

function resolveKnownActorTags(rawTags, searchService) {
  return rawTags.flatMap((tag) => {
    const { resolution } = searchService.resolveQuery(tag);
    return resolution?.type === "actor" ? [resolution.display_name] : [];
  });
}

function chunkTags(tags) {
  const lines = [];
  for (let i = 0; i < tags.length; i += TAGS_PER_LINE) {
    lines.push(tags.slice(i, i + TAGS_PER_LINE).join(" "));
  }
  return lines;
}

function resolveTelegramMedia(post) {
  return post.video ?? post.document ?? post.animation ?? post.video_note ?? null;
}

function shouldStripForwardSource(post, env) {
  return (
    String(env?.TELEGRAM_STRIP_FORWARD_SOURCE ?? "").toLowerCase() === "true" &&
    Boolean(post?.forward_origin ?? post?.forward_from)
  );
}

function readPostText(post) {
  if (typeof post.caption === "string") {
    return post.caption.trim();
  }
  return typeof post.text === "string" ? post.text.trim() : "";
}

function pendingChannelContextKey(channelId) {
  return `${PENDING_CHANNEL_CONTEXT_PREFIX}${channelId}`;
}

function pendingForwardGroupKey(channelId, mediaGroupId) {
  return `${PENDING_FORWARD_GROUP_PREFIX}${channelId}:${mediaGroupId}`;
}

function pendingForwardMessageKey(groupKey, messageId) {
  return `${groupKey}:message:${messageId}`;
}

function pendingForwardGroupStateKey(groupKey) {
  return `${groupKey}:state`;
}

function snapshotChannelPost(post) {
  return {
    chat: post.chat,
    message_id: post.message_id,
    media_group_id: post.media_group_id,
    caption: post.caption,
    text: post.text,
    video: post.video,
    document: post.document,
    animation: post.animation,
    video_note: post.video_note,
    forward_origin: post.forward_origin,
    forward_from: post.forward_from,
  };
}

function copiedChannelPost(source, messageId) {
  return {
    ...source,
    message_id: messageId,
    forward_origin: null,
    forward_from: null,
  };
}

function sortChannelPosts(posts) {
  return [...posts].sort((left, right) => Number(left.message_id) - Number(right.message_id));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readPendingForwardGroup(db, key) {
  const result = await db
    .prepare("SELECT value FROM database_metadata WHERE key LIKE ? ORDER BY key")
    .bind(`${key}:message:%`)
    .all();
  return (result.results ?? []).flatMap((row) => {
    try {
      const post = JSON.parse(row.value);
      return Number.isInteger(Number(post?.message_id)) ? [post] : [];
    } catch {
      return [];
    }
  });
}

async function writePendingForwardGroupState(db, key, status) {
  await db
    .prepare(
      `INSERT INTO database_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(pendingForwardGroupStateKey(key), status, new Date().toISOString())
    .run();
}

async function claimPendingForwardGroup(db, key) {
  const result = await db
    .prepare(
      `INSERT INTO database_metadata (key, value, updated_at)
       VALUES (?, 'processing', ?)
       ON CONFLICT (key) DO NOTHING`,
    )
    .bind(pendingForwardGroupStateKey(key), new Date().toISOString())
    .run();
  const changes = result?.meta?.changes ?? result?.changes;
  return changes == null ? true : changes > 0;
}

async function appendPendingForwardGroup(db, key, post) {
  await db
    .prepare(
      `INSERT INTO database_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
    )
    .bind(
      pendingForwardMessageKey(key, post.message_id),
      JSON.stringify(snapshotChannelPost(post)),
      new Date().toISOString(),
    )
    .run();
  return readPendingForwardGroup(db, key);
}

async function storePendingChannelContext(db, post, channelId) {
  const rawText = readPostText(post);
  if (!rawText) {
    return null;
  }
  const parsed = parseChannelTitle(rawText);
  if (!parsed.code && parsed.raw_tags.length === 0) {
    return null;
  }
  const context = {
    message_id: post.message_id,
    code: parsed.code,
    raw_tags: parsed.raw_tags,
    recorded_at: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO database_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(
      pendingChannelContextKey(channelId),
      JSON.stringify(context),
      context.recorded_at,
    )
    .run();
  return { context_stored: true };
}

async function readPendingChannelContext(db, channelId, messageId, code) {
  const key = pendingChannelContextKey(channelId);
  const row = await db
    .prepare("SELECT value FROM database_metadata WHERE key = ?")
    .bind(key)
    .first();
  if (!row?.value) {
    return null;
  }
  try {
    const context = JSON.parse(row.value);
    const messageDistance = Number(messageId) - Number(context.message_id);
    const isNear =
      Number.isInteger(messageDistance) &&
      messageDistance > 0 &&
      messageDistance <= PENDING_CHANNEL_CONTEXT_MESSAGE_WINDOW;
    const codeMatches = Boolean(context.code && (!code || code === context.code));
    if (!isNear || !codeMatches || !Array.isArray(context.raw_tags)) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
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

function buildEditedChannelPayload({
  previousPayload,
  post,
  channelId,
  env,
  searchService,
}) {
  const video = post.video ?? post.document;
  const rawText = readPostText(post);
  const fileName = (video?.file_name ?? "").replace(
    /\.(mp4|mkv|avi|wmv|ts)$/iu,
    "",
  );
  const parsed = parseChannelTitle(rawText || fileName || `视频 ${post.message_id}`);
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
  const contentTags = parsed.raw_tags
    .map(cleanTopicValue)
    .filter(Boolean);
  const rawTags = [...new Set(contentTags)];
  const knownTagActors = resolveKnownActorTags(rawTags, searchService);
  const resolvedActors = [...new Set([...actors, ...knownTagActors])];
  const payload = {
    ...previousPayload,
    source: {
      ...(previousPayload.source ?? {}),
      provider: "channel",
      external_id: `${channelId}:${post.message_id}`,
    },
    title: parsed.title,
    raw_tags: rawTags.length > 0 ? rawTags : ["未分类"],
    metadata: {
      ...(previousPayload.metadata ?? {}),
      tg_file_id: video?.file_id ?? previousPayload.metadata?.tg_file_id,
      tg_message_id: String(post.message_id),
    },
  };
  if (resolvedActors.length > 0) {
    payload.actors = resolvedActors;
  } else {
    delete payload.actors;
  }
  if (parsed.description) {
    payload.description = parsed.description;
  } else {
    delete payload.description;
  }
  if (parsed.code) {
    payload.code = parsed.code;
  } else {
    delete payload.code;
  }
  return payload;
}

function isAdmin(userId, env) {
  const admins = (env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return admins.includes(userId);
}
