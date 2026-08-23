import { normalizeValue } from "./value-normalizer.mjs";

const TELEGRAM_API = "https://api.telegram.org";
// Telegram hard limit is 4096 chars per message; leave headroom.
const PAGE_CHAR_LIMIT = 3800;
const TAGS_PER_LINE = 5;
const INDEX_ITEMS_PER_BLOCK = 24;
const PENDING_CHANNEL_CONTEXT_PREFIX = "channel_pending_caption_context:";
const PENDING_CHANNEL_CONTEXT_MESSAGE_WINDOW = 6;
const PENDING_FORWARD_GROUP_PREFIX = "channel_pending_forward_group:";
const PENDING_PRIVATE_FORWARD_GROUP_PREFIX = "private_forward_group:";
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

  const service = Object.freeze({
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
        const duplicateAction = decodeDuplicateDeletionCallback(update.callback_query.data);
        if (duplicateAction) {
          return this.handleDuplicateDeletionCallback(
            db,
            update.callback_query,
            env,
            duplicateAction,
          );
        }
        return this.handleSearchNavigation(db, update.callback_query, env);
      }
      const message = update?.message;
      // 私聊只接受配置管理员从当前旧频道逐条转发的历史媒体；其他
      // 媒体始终不处理，普通文字仍按原有方式用于搜索。
      if (!message || message.chat?.type !== "private") {
        return null;
      }
      const chatId = message.chat.id;
      const userId = String(message.from?.id ?? "");
      if (isLegacyChannelForward(message, env)) {
        const isUserAdmin = await this.isAuthorizedAdmin(userId, env);
        return this.ingestLegacyPrivateForward(db, message, env, isUserAdmin);
      }
      const text = message.text?.trim();
      if (!text) {
        return null;
      }

      const command = text.split(/\s+/u)[0].toLowerCase();
      const needsAdminCheck = ["/stats", "/duplicates", "/delete", "/refresh"].includes(command);
      const isUserAdmin = needsAdminCheck
        ? await this.isAuthorizedAdmin(userId, env)
        : false;
      let reply;
      let replyMarkup = null;
      if (text === "/stats") {
        const stats = await this.getCatalogStats(db, { includeAdmin: isUserAdmin });
        reply = formatCatalogStats(stats, { includeAdmin: isUserAdmin });
      } else if (text === "/index") {
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
          "可直接输入：番号、番号前缀、演员名或 #话题。\n" +
          "例如：ADN-100、ADN、白雪、#剧情\n\n" +
          "/stats - 查看收录统计\n" +
          "/index - 浏览频道索引\n" +
          "/duplicates - 查看重复候选（管理员）\n" +
          "/delete - 打开删除候选（管理员）\n" +
          "/refresh - 刷新频道索引（管理员）";
      } else if (text === "/duplicates" || command === "/delete") {
        if (!isUserAdmin) {
          reply = "权限不足";
        } else {
          const candidates = await this.listDuplicateCandidates(db);
          reply = formatDuplicateCandidates(candidates, {
            currentChannelId: env.TELEGRAM_CHANNEL_ID,
          });
          replyMarkup = buildDuplicateCandidateMarkup(candidates);
        }
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

    // 管理员将旧频道历史资源逐条转发到 Bot 私聊时，只建立指向旧频道
    // 原消息的搜索映射。相册先聚合同组消息，再只建一条索引并删除全部私聊副本。
    // 频道原消息绝不改动。
    async ingestLegacyPrivateForward(db, message, env, isUserAdmin) {
      if (!isUserAdmin) {
        return { ignored: "private_forward_not_admin" };
      }
      if (!legacyForwardOrigin(message, env) || !ingestService) {
        return { ignored: "private_forward_invalid" };
      }
      if (message.media_group_id) {
        return this.bufferLegacyPrivateForwardGroup(db, message, env);
      }
      return ingestLegacyPrivateForwardRecord(db, message, env, {
        rawText: readPostText(message),
        privateMessageIds: [message.message_id],
      });
    },

    async bufferLegacyPrivateForwardGroup(db, message, env) {
      const groupKey = pendingPrivateForwardGroupKey(
        message.chat.id,
        message.media_group_id,
      );
      await appendPendingForwardGroup(db, groupKey, message);
      // 每个成员都等待同组消息收齐。最后一条可能是图片或其他非收录
      // 成员；仍由它统一触发“从同组选择第一个可收录视频”的既有路径。
      await delay(mediaGroupSettleMs);

      const posts = sortChannelPosts(await readPendingForwardGroup(db, groupKey));
      const lastMessageId = posts.at(-1)?.message_id;
      if (Number(message.message_id) !== Number(lastMessageId)) {
        return {
          buffered: true,
          media_group_id: message.media_group_id,
          collected: posts.length,
        };
      }
      const mediaPost = posts.find((post) => resolveTelegramMedia(post));
      if (!mediaPost) {
        return { buffered: true, media_group_id: message.media_group_id };
      }
      if (!(await claimPendingForwardGroup(db, groupKey))) {
        return { buffered: true, media_group_id: message.media_group_id };
      }
      try {
        const rawText = posts.map(readPostText).find(Boolean) ?? "";
        const privateMessageIds = posts.map((post) => post.message_id);
        const result = await ingestLegacyPrivateForwardRecord(db, mediaPost, env, {
          rawText,
          privateMessageIds,
        });
        await deletePendingPrivateForwardGroup(db, groupKey);
        return { ...result, media_group_id: message.media_group_id };
      } catch (error) {
        await deletePendingPrivateForwardGroup(db, groupKey);
        throw error;
      }
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
          { command: "stats", description: "查看收录统计" },
          { command: "index", description: "跳转频道索引" },
          { command: "duplicates", description: "查看重复候选（管理员）" },
          { command: "delete", description: "删除重复候选（管理员）" },
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

    async isAuthorizedAdmin(userId, env) {
      if (isConfiguredAdmin(userId, env)) {
        return true;
      }
      const channelId = String(env.TELEGRAM_CHANNEL_ID ?? "");
      if (!userId || !channelId) {
        return false;
      }
      try {
        const member = await this.callTelegram(env, "getChatMember", {
          chat_id: channelId,
          user_id: userId,
        });
        return ["creator", "owner", "administrator"].includes(member?.status);
      } catch (error) {
        console.warn("channel administrator lookup failed", {
          user_id: userId,
          message: error.message,
        });
        return false;
      }
    },

    async handleDuplicateDeletionCallback(db, callback, env, action) {
      const chatId = callback?.message?.chat?.id;
      const userId = String(callback?.from?.id ?? "");
      if (!chatId || callback?.message?.chat?.type !== "private") {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "仅支持在与 Bot 的私聊中操作。",
          show_alert: true,
        });
        return { ignored: "non_private_duplicate_deletion_callback" };
      }
      if (!(await this.isAuthorizedAdmin(userId, env))) {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "权限不足",
          show_alert: true,
        });
        return { ignored: "duplicate_deletion_callback_not_admin" };
      }

      if (action.action === "cancel") {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "已取消，不会删除。",
        });
        await this.callTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: "已取消删除；该候选仍保留。",
        });
        return { chat_id: chatId, cancelled: true };
      }

      if (action.action === "delete") {
        const candidate = await this.getDuplicateCandidate(db, action.mediaId);
        if (!candidate) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该候选已失效，请重新执行 /duplicates。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "duplicate_candidate_not_found" };
        }
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "请在新消息中确认删除。",
        });
        await this.callTelegram(env, "sendMessage", {
          chat_id: chatId,
          text: formatDuplicateDeletionConfirmation(candidate, env),
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              {
                text: "确认删除此条",
                callback_data: encodeDuplicateDeletionCallback("confirm", candidate.media_id),
              },
              {
                text: "取消",
                callback_data: encodeDuplicateDeletionCallback("cancel", candidate.media_id),
              },
            ]],
          },
        });
        return { chat_id: chatId, confirmation_requested: candidate.media_id };
      }

      const result = await this.deleteDuplicateCandidate(db, env, {
        mediaId: action.mediaId,
        deletedByUserId: userId,
      });
      await this.callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.outcome === "not_duplicate_candidate" ? "候选已失效" : "删除处理完成",
      });
      await this.callTelegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text: formatDuplicateDeletionResult(result),
        parse_mode: "HTML",
      });
      return { chat_id: chatId, outcome: result.outcome };
    },

    async getCatalogStats(db, { includeAdmin = false } = {}) {
      const statements = [
        db.prepare(`
          SELECT
            COUNT(*) AS media_count,
            COUNT(DISTINCT normalized_code) AS code_count,
            MAX(updated_at) AS latest_updated_at
          FROM media
          WHERE status = 'approved'
        `),
        db.prepare(`
          SELECT COUNT(DISTINCT mf.tg_file_unique_id) AS file_count
          FROM media_files mf
          JOIN media m ON m.id = mf.media_id
          WHERE m.status = 'approved'
            AND mf.tg_file_unique_id IS NOT NULL
            AND mf.tg_file_unique_id <> ''
        `),
      ];
      if (includeAdmin) {
        statements.push(
          db.prepare(`
            SELECT COUNT(*) AS pending_review_count
            FROM review_items
            WHERE status = 'pending'
          `),
          db.prepare(`
            SELECT
              COUNT(*) AS duplicate_file_group_count,
              COALESCE(SUM(media_count), 0) AS duplicate_media_count
            FROM (
              SELECT mf.tg_file_unique_id, COUNT(DISTINCT mf.media_id) AS media_count
              FROM media_files mf
              JOIN media m ON m.id = mf.media_id
              WHERE m.status = 'approved'
                AND mf.tg_file_unique_id IS NOT NULL
                AND mf.tg_file_unique_id <> ''
              GROUP BY mf.tg_file_unique_id
              HAVING COUNT(DISTINCT mf.media_id) > 1
            )
          `),
        );
      }
      const results = await db.batch(statements);
      const catalog = results[0]?.results?.[0] ?? {};
      const files = results[1]?.results?.[0] ?? {};
      const pending = results[2]?.results?.[0] ?? {};
      const duplicates = results[3]?.results?.[0] ?? {};
      return {
        media_count: Number(catalog.media_count ?? 0),
        code_count: Number(catalog.code_count ?? 0),
        file_count: Number(files.file_count ?? 0),
        latest_updated_at: catalog.latest_updated_at ?? null,
        pending_review_count: Number(pending.pending_review_count ?? 0),
        duplicate_file_group_count: Number(duplicates.duplicate_file_group_count ?? 0),
        duplicate_media_count: Number(duplicates.duplicate_media_count ?? 0),
      };
    },

    async listDuplicateCandidates(db) {
      const result = await db
        .prepare(`
          WITH duplicate_files AS (
            SELECT tg_file_unique_id
            FROM media_files
            WHERE tg_file_unique_id IS NOT NULL AND tg_file_unique_id <> ''
            GROUP BY tg_file_unique_id
            HAVING COUNT(DISTINCT media_id) > 1
          )
          SELECT
            m.id AS media_id,
            m.normalized_code,
            m.title,
            m.updated_at,
            cp.tg_chat_id,
            cp.tg_message_id,
            mf.tg_file_unique_id
          FROM duplicate_files df
          JOIN media_files mf ON mf.tg_file_unique_id = df.tg_file_unique_id
          JOIN media m ON m.id = mf.media_id
          LEFT JOIN channel_posts cp ON cp.media_id = m.id
          WHERE m.status = 'approved'
          ORDER BY mf.tg_file_unique_id, m.updated_at DESC
        `)
        .all();
      return groupRowsBy(result.results ?? [], "tg_file_unique_id");
    },

    async getDuplicateCandidate(db, mediaId) {
      return db
        .prepare(`
          SELECT
            m.id AS media_id,
            m.normalized_code,
            m.title,
            m.updated_at,
            cp.tg_chat_id,
            cp.tg_message_id,
            mf.tg_file_unique_id
          FROM media m
          JOIN channel_posts cp ON cp.media_id = m.id
          JOIN media_files mf ON mf.media_id = m.id
          WHERE m.id = ?
            AND m.status = 'approved'
            AND mf.tg_file_unique_id IS NOT NULL
            AND mf.tg_file_unique_id <> ''
            AND EXISTS (
              SELECT 1
              FROM media_files sibling_file
              JOIN media sibling_media ON sibling_media.id = sibling_file.media_id
              WHERE sibling_file.tg_file_unique_id = mf.tg_file_unique_id
                AND sibling_media.id <> m.id
                AND sibling_media.status = 'approved'
            )
          LIMIT 1
        `)
        .bind(mediaId)
        .first();
    },

    async deleteDuplicateCandidate(db, env, { mediaId, deletedByUserId }) {
      const candidate = await this.getDuplicateCandidate(db, mediaId);
      if (!candidate) {
        return { outcome: "not_duplicate_candidate" };
      }

      const requestedAt = new Date().toISOString();
      const auditToken = crypto.randomUUID();
      const snapshot = JSON.stringify({
        media_id: candidate.media_id,
        normalized_code: candidate.normalized_code,
        title: candidate.title,
        updated_at: candidate.updated_at,
        tg_chat_id: candidate.tg_chat_id,
        tg_message_id: candidate.tg_message_id,
        tg_file_unique_id: candidate.tg_file_unique_id,
      });
      await db
        .prepare(`
          INSERT INTO duplicate_deletion_audit (
            audit_token, media_id, tg_chat_id, tg_message_id, tg_file_unique_id,
            deleted_by_tg_user_id, snapshot_json, outcome, requested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `)
        .bind(
          auditToken,
          candidate.media_id,
          candidate.tg_chat_id,
          candidate.tg_message_id,
          candidate.tg_file_unique_id,
          deletedByUserId,
          snapshot,
          requestedAt,
        )
        .run();

      const currentChannelId = String(env.TELEGRAM_CHANNEL_ID ?? "");
      const isLegacyChannelCandidate =
        Boolean(currentChannelId) &&
        String(candidate.tg_chat_id) !== currentChannelId;

      // 历史频道遗留记录不能由当前频道的 Bot 安全删除。管理员已显式确认后，
      // 只删除本目录中的残留媒体记录；绝不对旧频道消息发起删除请求。
      if (isLegacyChannelCandidate) {
        const completedAt = new Date().toISOString();
        await db.batch([
          db.prepare("DELETE FROM media WHERE id = ?").bind(candidate.media_id),
          db
            .prepare(`
              UPDATE duplicate_deletion_audit
              SET outcome = 'completed', deletion_scope = 'legacy_catalog_only',
                  catalog_deleted_at = ?, error_message = ?
              WHERE audit_token = ?
            `)
            .bind(
              completedAt,
              "Legacy-channel message was intentionally not deleted; catalog record removed.",
              auditToken,
            ),
        ]);
        return { outcome: "legacy_catalog_only_completed", candidate };
      }

      try {
        await this.callTelegram(env, "deleteMessage", {
          chat_id: candidate.tg_chat_id,
          message_id: candidate.tg_message_id,
        });
      } catch (error) {
        await db
          .prepare(`
            UPDATE duplicate_deletion_audit
            SET outcome = 'telegram_delete_failed', error_message = ?
            WHERE audit_token = ?
          `)
          .bind(String(error.message), auditToken)
          .run();
        return { outcome: "telegram_delete_failed", candidate };
      }

      const completedAt = new Date().toISOString();
      await db.batch([
        db.prepare("DELETE FROM media WHERE id = ?").bind(candidate.media_id),
        db
          .prepare(`
            UPDATE duplicate_deletion_audit
            SET outcome = 'completed', telegram_deleted_at = ?, catalog_deleted_at = ?
            WHERE audit_token = ?
          `)
          .bind(completedAt, completedAt, auditToken),
      ]);
      return { outcome: "completed", candidate };
    },

    async refreshPinnedIndex(db, env) {
      const channelId = env.TELEGRAM_CHANNEL_ID;
      if (!channelId) {
        throw new Error("TELEGRAM_CHANNEL_ID is not configured");
      }

      const [actorRows, tagRows] = await db.batch([
        db.prepare(`
          SELECT DISTINCT a.display_name_snapshot AS display_name
          FROM media_actors a
          JOIN channel_posts c ON c.media_id = a.media_id
          JOIN media m ON m.id = a.media_id
          WHERE m.status = 'approved' AND a.display_enabled = 1
          ORDER BY a.display_name_snapshot
        `),
        db.prepare(`
          SELECT t.display_name_snapshot AS display_name, MAX(t.weight) AS weight
          FROM media_tags t
          JOIN channel_posts c ON c.media_id = t.media_id
          JOIN media m ON m.id = t.media_id
          WHERE m.status = 'approved'
            AND t.display_enabled = 1
            AND t.tag_id NOT LIKE 'tag_topic_%'
          GROUP BY t.display_name_snapshot
          ORDER BY weight DESC, t.display_name_snapshot
        `),
      ]);
      const pages = this.renderIndexPages({
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

    renderIndexPages({ actors = [], tags = [] } = {}) {
      const actorNames = actors
        .map((row) => row.display_name)
        .filter(Boolean);
      const actorValues = new Set(actorNames.map(normalizeValue));
      const actorTags = uniqueHashtags(
        actorNames.map((name) => hashtag(name, channelIndex.actor_prefix)),
      );
      const typeTags = uniqueHashtags(
        tags
          .map((row) => row.display_name)
          .filter((name) => isIndexTopic(name, actorValues, searchService))
          .map((name) => hashtag(name, channelIndex.tag_prefix)),
      );
      const blocks = [
        ...(channelIndex.show_actors
          ? buildIndexBlocks(channelIndex.actors_label, actorTags)
          : []),
        ...(channelIndex.show_tags
          ? buildIndexBlocks(channelIndex.tags_label, typeTags)
          : []),
      ];
      if (blocks.length === 0) {
        return [channelIndex.title];
      }

      const pages = [];
      let current = channelIndex.title;
      const pushPage = () => {
        pages.push(current.trim());
        current = `${channelIndex.title}（续）`;
      };
      for (const block of blocks) {
        const blockHeader = `\n\n${block.label}`;
        if (current.length + blockHeader.length > PAGE_CHAR_LIMIT) {
          pushPage();
        }
        current += blockHeader;
        for (const line of block.lines) {
          if (current.length + line.length + 1 > PAGE_CHAR_LIMIT) {
            pushPage();
            current += `\n\n${block.label}（续）`;
          }
          current += `\n${line}`;
        }
      }
      pushPage();

      const summary = [
        actorTags.length > 0 ? `演员 ${actorTags.length} 位` : null,
        typeTags.length > 0 ? `话题 ${typeTags.length} 项` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return pages.map((page, index) => {
        const oldHeader = index === 0 ? channelIndex.title : `${channelIndex.title}（续）`;
        const pageTitle = pages.length > 1
          ? `${channelIndex.title} · ${index + 1}/${pages.length}`
          : channelIndex.title;
        const header = index === 0 && summary ? `${pageTitle}\n${summary}` : pageTitle;
        return `${header}${page.slice(oldHeader.length)}`;
      });
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

  return service;

  async function ingestLegacyPrivateForwardRecord(
    db,
    message,
    env,
    { rawText, privateMessageIds },
  ) {
    const origin = legacyForwardOrigin(message, env);
    const media = resolveTelegramMedia(message);
    if (!origin || !media) {
      return { ignored: "private_forward_without_media" };
    }
    const fileName = (media.file_name ?? "").replace(
      /\.(mp4|mkv|avi|wmv|ts)$/iu,
      "",
    );
    const parsed = parseChannelTitle(
      rawText || fileName || `视频 ${origin.messageId}`,
    );
    const rawTags = parsed.raw_tags.map(cleanTopicValue).filter(Boolean);
    const payload = {
      source: {
        provider: "channel",
        external_id: `${origin.channelId}:${origin.messageId}`,
      },
      title: parsed.title,
      raw_tags: rawTags,
      metadata: {
        tg_file_id: media.file_id,
        tg_message_id: String(origin.messageId),
      },
    };
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
        `INSERT INTO channel_posts (
           media_id, tg_chat_id, tg_message_id, template_version,
           posted_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (media_id) DO UPDATE SET
           tg_chat_id = excluded.tg_chat_id,
           tg_message_id = excluded.tg_message_id,
           updated_at = excluded.updated_at`,
      )
      .bind(
        result.id,
        origin.channelId,
        origin.messageId,
        versionConfig.release.version,
        timestamp,
        timestamp,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO media_files (
           media_id, tg_file_id, tg_file_unique_id, source_chat_id,
           source_message_id, imported_from, created_at
         ) VALUES (?, ?, ?, ?, ?, 'private_forward', ?)
         ON CONFLICT (media_id) DO UPDATE SET
           tg_file_id = excluded.tg_file_id,
           tg_file_unique_id = excluded.tg_file_unique_id,
           source_chat_id = excluded.source_chat_id,
           source_message_id = excluded.source_message_id`,
      )
      .bind(
        result.id,
        media.file_id,
        media.file_unique_id ?? null,
        origin.channelId,
        String(origin.messageId),
        timestamp,
      )
      .run();

    const messageIds = [...new Set(privateMessageIds.map(Number).filter(Number.isInteger))];
    for (const privateMessageId of messageIds) {
      await service.callTelegram(env, "deleteMessage", {
        chat_id: message.chat.id,
        message_id: privateMessageId,
      });
    }
    const exists = result.outcome === "updated";
    await service.callTelegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: exists
        ? `ℹ️ 已存在并更新 #${escapeHtml(parsed.code ?? "历史资源")}`
        : `✅ 已收录 #${escapeHtml(parsed.code ?? "历史资源")}`,
      parse_mode: "HTML",
    });
    return {
      ingested: result.id,
      status: result.status,
      source_channel_message_id: origin.messageId,
      private_copy_deleted: true,
      existing: exists,
    };
  }

  async function resolveDirectorySearch(db, query, page) {
    const rawTag = parseRawTagQuery(query);
    if (rawTag) {
      const resolution = { type: "raw_tag", raw_tag: rawTag, display_name: rawTag };
      return {
        resolution,
        result: await findDirectoryMedia(db, resolution, page),
      };
    }

    // 频道不再区分“演员标签”和“话题标签”。因此普通人名输入先按
    // 已收录的原生标签精确匹配；只有没有这条原生标签时，才回退到旧演员词典。
    // 这避免了“本庄铃”被模糊词典错误改判为“本乡爱”。
    const plainRawTag = parsePlainRawTagQuery(query);
    if (plainRawTag) {
      const resolution = {
        type: "raw_tag",
        raw_tag: plainRawTag,
        display_name: plainRawTag,
      };
      const result = await findDirectoryMedia(db, resolution, page);
      if (result.total > 0) {
        return { resolution, result };
      }
    }

    const { resolution } = searchService.resolveQuery(query);
    const isDirectoryQuery = ["code", "code_prefix", "actor", "tag"].includes(
      resolution?.type,
    );
    const result = isDirectoryQuery
      ? await findDirectoryMedia(db, resolution, page)
      : { page, page_size: botResult.page_size, total: 0, results: [] };
    return { resolution, result };
  }

  async function findDirectoryMedia(db, resolution, page) {
    return searchService.findMedia(db, {
      filters: resolutionFilters(resolution),
      page,
      pageSize: botResult.page_size,
      includeChannelLinks: true,
    });
  }

  function renderSearchReply({ query, resolution, searchResult }) {
    if (!["code", "code_prefix", "actor", "tag", "raw_tag"].includes(resolution?.type)) {
      return (
        `未识别“${escapeHtml(query)}”。\n\n` +
        "可以这样查询：\n" +
        "• 番号或前缀：ADN-100、ADN\n" +
        "• 演员或别名：白雪\n" +
        "• 话题：#剧情\n\n" +
        "也可发送 /index 浏览已收录索引。"
      );
    }
    if (searchResult.total === 0) {
      const subject = ["actor", "tag", "raw_tag"].includes(resolution.type)
        ? `#${resolution.display_name ?? resolution.raw_tag ?? query.replace(/^#/u, "")}`
        : `#${resolution.code ?? resolution.prefix ?? query}`;
      const hint = ["code", "code_prefix"].includes(resolution.type)
        ? "请检查番号格式，或只输入前缀后重试。"
        : "可发送 /index 浏览已收录演员和话题，或尝试别名。";
      return `暂未收录 ${escapeHtml(subject)}。\n${hint}`;
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
  const linkEntry = (label) =>
    channelUrl
      ? `<a href="${escapeHtml(channelUrl)}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
  const rawTags = media.raw_tags?.length
    ? media.raw_tags
    : (media.tags ?? []).map((tag) => tag.display_name);
  const tagEntries = [...new Set(rawTags)]
    .filter(Boolean)
    .map((tag) => linkEntry(`#${tag}`));
  return `${index} • ${[linkEntry(code), ...tagEntries].join("  ")}`;
}

function groupRowsBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    const entries = groups.get(value) ?? [];
    entries.push(row);
    groups.set(value, entries);
  }
  return groups;
}

function formatDuplicateCandidates(groups, { currentChannelId = "" } = {}) {
  if (groups.size === 0) {
    return "✅ 未发现重复 Telegram 文件候选。";
  }
  const lines = [
    "🔎 <b>重复候选</b>",
    "以下记录复用了同一 Telegram 文件；仅供核对，未执行合并或删除。",
  ];
  for (const [index, rows] of [...groups.values()].entries()) {
    lines.push("", `<b>候选 ${index + 1}</b> · ${rows.length} 条`);
    for (const row of rows) {
      const code = row.normalized_code ? `#${row.normalized_code}` : "#未知编号";
      const channelUrl = channelMessageUrl(row.tg_chat_id, row.tg_message_id);
      const heading = channelUrl
        ? `<a href="${escapeHtml(channelUrl)}">${escapeHtml(code)}</a>`
        : escapeHtml(code);
      const title = row.title ? ` · ${escapeHtml(row.title)}` : "";
      const legacyNotice =
        currentChannelId && String(row.tg_chat_id) !== String(currentChannelId)
          ? " · <i>旧频道遗留：仅删除目录</i>"
          : " · <i>当前频道：删除消息与目录</i>";
      lines.push(`• ${heading}${title}${legacyNotice}`);
    }
  }
  return lines.join("\n");
}

function buildDuplicateCandidateMarkup(groups) {
  const rows = [];
  for (const candidates of groups.values()) {
    for (const candidate of candidates) {
      const callbackData = encodeDuplicateDeletionCallback("delete", candidate.media_id);
      if (!callbackData) {
        continue;
      }
      const code = candidate.normalized_code
        ? `#${candidate.normalized_code}`
        : "未标号候选";
      const title = String(candidate.title ?? "").trim();
      const label = title ? `删除 ${code} · ${title}` : `删除 ${code}`;
      rows.push([{
        text: label.length > 60 ? `${label.slice(0, 59)}…` : label,
        callback_data: callbackData,
      }]);
    }
  }
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

function encodeDuplicateDeletionCallback(action, mediaId) {
  const actionCode = { delete: "d", confirm: "c", cancel: "x" }[action];
  if (!actionCode || !/^media_[a-f0-9]{32}$/iu.test(mediaId ?? "")) {
    return null;
  }
  const callbackData = `dupdel:${actionCode}:${mediaId.toLowerCase()}`;
  return callbackData.length <= 64 ? callbackData : null;
}

function decodeDuplicateDeletionCallback(data) {
  if (typeof data !== "string") {
    return null;
  }
  const match = /^dupdel:([dcx]):(media_[a-f0-9]{32})$/iu.exec(data);
  if (!match) {
    return null;
  }
  const action = { d: "delete", c: "confirm", x: "cancel" }[match[1].toLowerCase()];
  return action ? { action, mediaId: match[2].toLowerCase() } : null;
}

function formatDuplicateDeletionConfirmation(candidate, env) {
  const code = candidate.normalized_code
    ? `#${escapeHtml(candidate.normalized_code)}`
    : "该媒体";
  const title = candidate.title ? ` · ${escapeHtml(candidate.title)}` : "";
  const isLegacy =
    env.TELEGRAM_CHANNEL_ID &&
    String(candidate.tg_chat_id) !== String(env.TELEGRAM_CHANNEL_ID);
  const scope = isLegacy
    ? "将只删除旧频道遗留的目录记录；不会操作已注销旧频道的原消息。"
    : "将删除当前频道消息及其目录记录。";
  return `<b>确认删除 ${code}${title}？</b>\n${scope}\n\n点击“确认删除此条”后才会执行。`;
}

function formatDuplicateDeletionResult(result) {
  if (result.outcome === "not_duplicate_candidate") {
    return "未删除：该媒体已不属于重复候选，或已被处理。";
  }
  const code = result.candidate?.normalized_code
    ? `#${escapeHtml(result.candidate.normalized_code)}`
    : "该媒体";
  if (result.outcome === "telegram_delete_failed") {
    return `未删除 ${code}：频道消息删除失败，索引记录已保留。`;
  }
  if (result.outcome === "legacy_catalog_only_completed") {
    return `✅ 已删除 ${code} 的旧频道遗留目录记录；旧频道原消息未操作，并已写入删除审计。`;
  }
  return `✅ 已删除 ${code} 的频道消息与索引记录，并已写入删除审计。`;
}

function formatCatalogStats(stats, { includeAdmin }) {
  const lines = [
    "📊 <b>收录统计</b>",
    "",
    `已审核媒体：${stats.media_count} 条`,
    `不同编号：${stats.code_count} 个`,
    `不同文件：${stats.file_count} 个`,
  ];
  if (stats.latest_updated_at) {
    lines.push(`最近更新：${formatShanghaiTime(stats.latest_updated_at)}`);
  }
  if (includeAdmin) {
    lines.push("", "<b>管理员数据质量</b>");
    lines.push(`待审核：${stats.pending_review_count} 条`);
    lines.push(
      `重复候选：${stats.duplicate_file_group_count} 组 / ${stats.duplicate_media_count} 条`,
    );
  }
  return lines.join("\n");
}

function formatShanghaiTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function parseRawTagQuery(query) {
  const raw = typeof query === "string" ? query.trim() : "";
  if (!raw.startsWith("#")) {
    return null;
  }
  const tag = raw.replace(/^#+/u, "").trim();
  return tag && !/\s/u.test(tag) ? tag : null;
}

function parsePlainRawTagQuery(query) {
  const raw = typeof query === "string" ? query.trim() : "";
  if (!raw || raw.startsWith("#") || /\s/u.test(raw)) {
    return null;
  }
  return raw;
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
            resolution.raw_tag ??
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

function uniqueHashtags(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value) {
      return false;
    }
    const normalized = normalizeValue(value.replace(/^#/u, ""));
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function isIndexTopic(value, actorValues, searchService) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const normalized = normalizeValue(value);
  if (!normalized || actorValues.has(normalized)) {
    return false;
  }
  const { resolution } = searchService.resolveQuery(value);
  return !["actor", "category"].includes(resolution?.type);
}

function buildIndexBlocks(label, tags) {
  if (tags.length === 0) {
    return [];
  }
  const totalBlocks = Math.ceil(tags.length / INDEX_ITEMS_PER_BLOCK);
  const blocks = [];
  for (let offset = 0; offset < tags.length; offset += INDEX_ITEMS_PER_BLOCK) {
    const blockIndex = Math.floor(offset / INDEX_ITEMS_PER_BLOCK);
    const suffix = totalBlocks > 1 ? `（${blockIndex + 1}/${totalBlocks}）` : "";
    blocks.push({
      label: `${label} · ${tags.length}${suffix}`,
      lines: chunkTags(tags.slice(offset, offset + INDEX_ITEMS_PER_BLOCK)),
    });
  }
  return blocks;
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

function isLegacyChannelForward(message, env) {
  return Boolean(legacyForwardOrigin(message, env));
}

function legacyForwardOrigin(message, env) {
  const channelId = String(env?.TELEGRAM_CHANNEL_ID ?? "");
  const origin = message?.forward_origin;
  if (
    origin?.type === "channel" &&
    String(origin.chat?.id ?? "") === channelId &&
    Number.isInteger(Number(origin.message_id)) &&
    Number(origin.message_id) > 0
  ) {
    return { channelId, messageId: Number(origin.message_id) };
  }
  if (
    String(message?.forward_from_chat?.id ?? "") === channelId &&
    Number.isInteger(Number(message?.forward_from_message_id)) &&
    Number(message.forward_from_message_id) > 0
  ) {
    return { channelId, messageId: Number(message.forward_from_message_id) };
  }
  return null;
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

function pendingPrivateForwardGroupKey(chatId, mediaGroupId) {
  if (!chatId || !mediaGroupId) {
    throw new TypeError("private forwarded media group requires chat and group IDs");
  }
  return `${PENDING_PRIVATE_FORWARD_GROUP_PREFIX}${chatId}:${mediaGroupId}`;
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

async function deletePendingPrivateForwardGroup(db, key) {
  const messagePrefix = `${key}:message:`;
  await db
    .prepare(
      "DELETE FROM database_metadata WHERE key = ? OR substr(key, 1, length(?)) = ?",
    )
    .bind(pendingForwardGroupStateKey(key), messagePrefix, messagePrefix)
    .run();
}

async function readPendingForwardGroup(db, key) {
  const messagePrefix = `${key}:message:`;
  const result = await db
    .prepare(
      "SELECT value FROM database_metadata WHERE substr(key, 1, length(?)) = ? ORDER BY key",
    )
    .bind(messagePrefix, messagePrefix)
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
    case "raw_tag":
      return { raw_tag: resolution.raw_tag };
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

function isConfiguredAdmin(userId, env) {
  const admins = (env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return admins.includes(userId);
}
