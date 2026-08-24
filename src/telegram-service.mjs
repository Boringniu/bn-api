import { normalizeValue } from "./value-normalizer.mjs";

const TELEGRAM_API = "https://api.telegram.org";
const BOT_DESCRIPTION_LIMIT = 240;
const STORY_BATCH_CODE_LIMIT = 20;
const STORY_LIST_COMMANDS = new Set(["/系列剧情", "系列剧情", "/stories"]);
const STORY_CREATE_COMMANDS = new Set(["/新增剧情", "新增剧情", "/newstory"]);
const STORY_BROWSE_KEYBOARD = Object.freeze({
  keyboard: [[{ text: "系列剧情" }, { text: "新增剧情" }]],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "输入番号、演员、话题，或点击剧情按键",
});
const PENDING_CHANNEL_CONTEXT_PREFIX = "channel_pending_caption_context:";
const PENDING_CHANNEL_CONTEXT_MESSAGE_WINDOW = 6;
const PENDING_FORWARD_GROUP_PREFIX = "channel_pending_forward_group:";
const PENDING_PRIVATE_FORWARD_GROUP_PREFIX = "private_forward_group:";
const DEFAULT_MEDIA_GROUP_SETTLE_MS = 2_000;
const PENDING_FORWARD_GROUP_STALE_MS = 5 * 60_000;

export function createTelegramService({
  categoryConfig,
  displayConfig,
  ingestService = null,
  searchConfig,
  searchService,
  storyService = null,
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

    async handleStoryCallback(db, callback, env, action) {
      const chatId = callback?.message?.chat?.id;
      const userId = String(callback?.from?.id ?? "");
      if (!chatId || callback?.message?.chat?.type !== "private") {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "仅支持在与 Bot 的私聊中操作。",
          show_alert: true,
        });
        return { ignored: "non_private_story_callback" };
      }
      if (!storyService) {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "系列剧情功能暂不可用。",
          show_alert: true,
        });
        return { ignored: "story_service_unavailable" };
      }

      if (action.type === "list") {
        const page = await storyService.listStories(db, {
          page: action.page,
          pageSize: botResult.page_size,
        });
        return editStoryMessage(this, env, callback, {
          text: formatStoryList(page),
          replyMarkup: buildStoryListMarkup(page),
        });
      }

      if (action.type === "view") {
        const story = await storyService.getStory(db, action.storyId);
        if (!story) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该剧情条目已不存在。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_not_found" };
        }
        const page = await storyService.findStoryMedia(db, {
          storyId: story.id,
          page: action.page,
          pageSize: botResult.page_size,
        });
        const isUserAdmin = await this.isAuthorizedAdmin(userId, env);
        return editStoryMessage(this, env, callback, {
          text: formatStoryMediaPage(story, page, this.renderBotResults.bind(this)),
          replyMarkup: buildStoryMediaMarkup(story, page, { isUserAdmin }),
        });
      }

      const isUserAdmin = await this.isAuthorizedAdmin(userId, env);
      if (!isUserAdmin) {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "权限不足",
          show_alert: true,
        });
        return { chat_id: chatId, ignored: "story_callback_not_admin" };
      }

      if (action.type === "manage") {
        const story = await storyService.startMediaSelection(db, {
          userId,
          storyId: action.storyId,
        });
        if (!story) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该剧情条目已不存在。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_not_found" };
        }
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "请输入查询词选择视频。",
        });
        await this.callTelegram(env, "sendMessage", {
          chat_id: chatId,
          text: formatStoryManagementPrompt(story),
          parse_mode: "HTML",
          reply_markup: buildStoryManagementMarkup(story),
        });
        return { chat_id: chatId, story_management_started: story.id };
      }

      if (action.type === "delete_story_prompt") {
        const story = await storyService.getStory(db, action.storyId);
        if (!story) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该剧情条目已不存在。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_not_found" };
        }
        return editStoryMessage(this, env, callback, {
          text: formatStoryDeleteConfirmation(story),
          replyMarkup: buildStoryDeleteConfirmationMarkup(story),
        });
      }

      if (action.type === "delete_story_confirm") {
        const result = await storyService.deleteStory(db, { userId, storyId: action.storyId });
        if (result.outcome !== "deleted_story") {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该剧情条目已不存在。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: result.outcome };
        }
        return editStoryMessage(this, env, callback, {
          text: `✅ 已删除剧情“${escapeHtml(result.story.title)}”，已解除 ${result.removed_media_count} 条视频关联。频道视频与媒体目录未删除。`,
          replyMarkup: { inline_keyboard: [[{
            text: "返回剧情目录",
            callback_data: encodeStoryCallback("list", 1),
          }]] },
        });
      }

      if (action.type === "removal_start") {
        const story = await storyService.startMediaRemoval(db, { userId, storyId: action.storyId });
        if (!story) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该剧情条目已不存在。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_not_found" };
        }
        const page = await storyService.findStoryMedia(db, {
          storyId: story.id,
          page: 1,
          pageSize: botResult.page_size,
        });
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
        });
        await this.callTelegram(env, "sendMessage", {
          chat_id: chatId,
          text: formatStoryRemovalPage(story, page, this.renderBotResults.bind(this)),
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: buildStoryRemovalMarkup(page),
        });
        return { chat_id: chatId, story_removal_started: story.id };
      }

      if (action.type === "removal_page") {
        return editStoryRemovalMessage(this, db, callback, env, {
          storyService,
          userId,
          page: action.page,
        });
      }

      if (action.type === "remove_story_media_prompt") {
        const session = await storyService.getMediaRemovalSession(db, userId);
        const story = session?.story_id ? await storyService.getStory(db, session.story_id) : null;
        const media = await searchService.getMedia(db, action.mediaId, { includeChannelLinks: true });
        if (!story || !media) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该移除操作已失效，请重新打开“移除二级视频”。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_removal_expired" };
        }
        return editStoryMessage(this, env, callback, {
          text: formatStoryMediaRemovalConfirmation(story, media),
          replyMarkup: buildStoryMediaRemovalConfirmationMarkup(media),
        });
      }

      if (action.type === "remove_story_media_confirm") {
        const session = await storyService.getMediaRemovalSession(db, userId);
        if (!session?.story_id) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该移除操作已失效，请重新打开“移除二级视频”。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_removal_expired" };
        }
        const result = await storyService.removeMediaFromStory(db, {
          userId,
          storyId: session.story_id,
          mediaId: action.mediaId,
        });
        if (result.outcome !== "removed_story_media") {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "该视频已不在当前剧情中。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: result.outcome };
        }
        return editStoryRemovalMessage(this, db, callback, env, {
          storyService,
          userId,
          page: 1,
          notice: `✅ 已从“${escapeHtml(result.story.title)}”移除该视频；频道视频与媒体目录未删除。`,
        });
      }

      if (action.type === "removal_cancel") {
        await storyService.clearMediaRemovalSession(db, userId);
        return editStoryMessage(this, env, callback, {
          text: "已退出二级视频移除，不会删除任何资源。",
          replyMarkup: null,
        });
      }

      if (action.type === "query_page") {
        const session = await storyService.getSession(db, userId);
        if (!session?.query) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "请先输入番号、演员或话题。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "story_query_missing" };
        }
        await storyService.setMediaQuery(db, {
          userId,
          query: session.query,
          page: action.page,
        });
        return editStorySelectionMessage(this, db, callback, env, {
          storyService,
          userId,
          page: action.page,
        });
      }

      if (action.type === "select") {
        const result = await storyService.toggleMediaSelection(db, {
          userId,
          mediaId: action.mediaId,
        });
        const text = {
          selected: `已选择，当前共 ${result.selected_count} 部。`,
          deselected: `已取消选择，当前共 ${result.selected_count} 部。`,
          media_not_found: "该视频已不存在或未审核。",
          no_active_story: "当前没有正在管理的剧情。",
        }[result.outcome] ?? "操作失败，请重试。";
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text,
          show_alert: result.outcome === "media_not_found" || result.outcome === "no_active_story",
        });
        if (result.outcome !== "selected" && result.outcome !== "deselected") {
          return { chat_id: chatId, story_media_outcome: result.outcome };
        }
        return editStorySelectionMessage(this, db, callback, env, {
          storyService,
          userId,
          page: (await storyService.getSession(db, userId))?.page ?? 1,
          answerCallback: false,
        });
      }

      if (action.type === "commit") {
        const result = await storyService.commitMediaSelection(db, { userId });
        if (result.outcome !== "committed") {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: result.outcome === "no_selection" ? "请先勾选至少一部视频。" : "当前剧情选片已失效。",
            show_alert: true,
          });
          return { chat_id: chatId, story_media_outcome: result.outcome };
        }
        await storyService.clearSession(db, userId);
        return editStoryMessage(this, env, callback, {
          text: `✅ 已向“${escapeHtml(result.story.title)}”加入 ${result.added_count} 部视频；本次勾选 ${result.selected_count} 部，当前共 ${result.story.video_count} 条视频。`,
          replyMarkup: buildStoryCreatedMarkup(result.story),
        });
      }

      if (action.type === "cancel") {
        await storyService.clearSession(db, userId);
        return editStoryMessage(this, env, callback, {
          text: "已取消本次选片，未加入任何本次勾选的视频。",
          replyMarkup: null,
        });
      }

      await this.callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "操作已失效，请重试。",
        show_alert: true,
      });
      return { chat_id: chatId, ignored: "unknown_story_action" };
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
        const storyAction = decodeStoryCallback(update.callback_query.data);
        if (storyAction) {
          return this.handleStoryCallback(db, update.callback_query, env, storyAction);
        }
        const pendingCleanupAction = decodePendingReviewCleanupCallback(update.callback_query.data);
        if (pendingCleanupAction) {
          return this.handlePendingReviewCleanupCallback(
            db,
            update.callback_query,
            env,
            pendingCleanupAction,
          );
        }
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
        const result = await this.ingestLegacyPrivateForward(db, message, env, isUserAdmin);
        const session = isUserAdmin && storyService
          ? await storyService.getSession(db, userId)
          : null;
        if (session?.mode !== "awaiting_media_query" || !result?.ingested) {
          return result;
        }
        const selected = await storyService.selectMediaForActiveStory(db, {
          userId,
          mediaId: result.ingested,
        });
        if (selected.outcome === "selected" || selected.outcome === "already_selected") {
          await this.callTelegram(env, "sendMessage", {
            chat_id: chatId,
            text: `✅ 已从频道加入本次已选视频（当前 ${selected.selected_count} 部）。`,
          });
        } else if (selected.outcome === "media_not_found") {
          await this.callTelegram(env, "sendMessage", {
            chat_id: chatId,
            text: "该频道视频已接收，但尚未处于可关联状态。",
          });
        }
        return { ...result, story_selection: selected.outcome };
      }
      const text = message.text?.trim();
      if (!text) {
        return null;
      }

      const command = text.split(/\s+/u)[0].toLowerCase();
      const isStoryListCommand = STORY_LIST_COMMANDS.has(command);
      const isStoryCreateCommand = STORY_CREATE_COMMANDS.has(command);
      const isReviewListCommand = ["/reviews", "待审核", "/待审核"].includes(command);
      const storySession = storyService
        ? await storyService.getSession(db, userId)
        : null;
      const needsAdminCheck = ["/stats", "/duplicates"].includes(command)
        || isReviewListCommand
        || isStoryCreateCommand
        || Boolean(storySession);
      const isUserAdmin = needsAdminCheck
        ? await this.isAuthorizedAdmin(userId, env)
        : false;
      let reply;
      let replyMarkup = null;
      if (text === "/stats") {
        const stats = await this.getCatalogStats(db, { includeAdmin: isUserAdmin });
        reply = formatCatalogStats(stats, { includeAdmin: isUserAdmin });
      } else if (isReviewListCommand) {
        if (!isUserAdmin) {
          reply = "权限不足";
        } else {
          const reviews = await this.listPendingReviews(db);
          reply = formatPendingReviews(reviews);
          replyMarkup = buildPendingReviewCleanupMarkup(reviews);
        }
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
          "例如：ADN-100、ADN、#剧情\n\n" +
          "/stats - 查看收录统计\n" +
          "/index - 浏览频道索引\n" +
          "/duplicates - 查看重复候选（管理员）\n" +
          "/reviews - 查看待审核明细（管理员）";
        replyMarkup = STORY_BROWSE_KEYBOARD;
      } else if (isStoryListCommand) {
        if (!storyService) {
          reply = "系列剧情功能暂不可用。";
        } else {
          const stories = await storyService.listStories(db, {
            page: 1,
            pageSize: botResult.page_size,
          });
          reply = formatStoryList(stories);
          replyMarkup = buildStoryListMarkup(stories);
        }
      } else if (isStoryCreateCommand) {
        if (!storyService || !isUserAdmin) {
          reply = "权限不足";
        } else {
          const inlineTitle = text.slice(command.length).trim();
          if (inlineTitle) {
            const created = await storyService.createStory(db, {
              title: inlineTitle,
              createdByUserId: userId,
            });
            reply = formatStoryCreated(created);
            replyMarkup = buildStoryCreatedMarkup(created.story);
          } else {
            await storyService.startTitleEntry(db, userId);
            reply = "请输入一级剧情名称。";
            replyMarkup = buildStoryEntryCancelMarkup();
          }
        }
      } else if (text === "/duplicates") {
        if (!isUserAdmin) {
          reply = "权限不足";
        } else {
          const candidates = await this.listDuplicateCandidates(db);
          reply = formatDuplicateCandidates(candidates, {
            currentChannelId: env.TELEGRAM_CHANNEL_ID,
          });
          replyMarkup = buildDuplicateCandidateMarkup(candidates);
        }
      } else if (storySession?.mode === "awaiting_title") {
        if (!isUserAdmin || !storyService) {
          reply = "权限不足";
        } else if (text.startsWith("/")) {
          reply = "正在输入一级剧情名称。请发送普通文字，或点击取消。";
          replyMarkup = buildStoryEntryCancelMarkup();
        } else {
          const created = await storyService.createStory(db, {
            title: text,
            createdByUserId: userId,
          });
          await storyService.clearSession(db, userId);
          reply = formatStoryCreated(created);
          replyMarkup = buildStoryCreatedMarkup(created.story);
        }
      } else if (storySession?.mode === "awaiting_media_query") {
        if (!isUserAdmin || !storyService) {
          reply = "权限不足";
        } else {
          const story = await storyService.getStory(db, storySession.story_id);
          if (!story) {
            await storyService.clearSession(db, userId);
            reply = "当前剧情条目已不存在，已结束选片。";
          } else {
            await storyService.setMediaQuery(db, { userId, query: text, page: 1 });
            const search = await resolveStorySelectionSearch(db, text, 1);
            const selectedMediaIds = await storyService.listSelectedMediaIds(db, userId);
            reply = formatStorySelectionReply(story, {
              query: text,
              resolution: search.resolution,
              searchResult: search.result,
              selectedCount: selectedMediaIds.length,
            });
            replyMarkup = buildStorySelectionMarkup(story, search.result, selectedMediaIds);
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
        await deletePendingForwardGroup(db, groupKey);
        return { ...result, media_group_id: message.media_group_id };
      } catch (error) {
        await deletePendingForwardGroup(db, groupKey);
        throw error;
      }
    },

    // 私人频道只由管理员维护：原生发布直接入库；经授权的转发则复制为
    // 无来源副本并删除原转发，再对副本建立索引。
    async handleChannelPost(db, post, env) {
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
      const latestPost = latestPendingForwardPost(posts);
      if (Number(post.message_id) !== Number(latestPost?.message_id)) {
        return {
          buffered: true,
          media_group_id: post.media_group_id,
          collected: pending.length,
        };
      }
      if (!(await claimPendingForwardGroup(db, groupKey))) {
        return { buffered: true, media_group_id: post.media_group_id };
      }

      try {
        const copiedMessageIds = await this.stripForwardMediaGroup(
          posts,
          channelId,
          env,
        );
        const outcomes = [];
        for (const [index, source] of posts.entries()) {
          const copiedPost = copiedChannelPost(source, copiedMessageIds[index]);
          // 相册的 caption 只会出现在其中一条消息上。复制后先保存它，
          // 让同组后续视频也能继承人工填写的番号与原生话题。
          await storePendingChannelContext(db, copiedPost, channelId);
          outcomes.push(
            await this.handleChannelPost(db, copiedPost, env),
          );
        }
        return {
          source_stripped: true,
          media_group_id: post.media_group_id,
          copied_message_ids: copiedMessageIds,
          processed: outcomes.filter(Boolean).length,
        };
      } finally {
        // 无论复制、入库还是索引刷新是否失败，都不能让本次临时快照和
        // processing 状态永久卡住后续同一相册的再次转发。
        await deletePendingForwardGroup(db, groupKey);
      }
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
          { command: "stories", description: "浏览系列剧情" },
          { command: "newstory", description: "新增一级剧情（管理员）" },
          { command: "duplicates", description: "查看重复候选（管理员）" },
          { command: "reviews", description: "查看待审核明细（管理员）" },
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

    async handlePendingReviewCleanupCallback(db, callback, env, action) {
      const chatId = callback?.message?.chat?.id;
      const userId = String(callback?.from?.id ?? "");
      if (!chatId || callback?.message?.chat?.type !== "private") {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "仅支持在与 Bot 的私聊中操作。",
          show_alert: true,
        });
        return { ignored: "non_private_pending_cleanup_callback" };
      }
      if (!(await this.isAuthorizedAdmin(userId, env))) {
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "权限不足",
          show_alert: true,
        });
        return { chat_id: chatId, ignored: "pending_cleanup_callback_not_admin" };
      }
      if (action.action === "cancel") {
        await this.clearPendingReviewCleanupSession(db, { userId });
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "已取消，不会清理。",
        });
        await this.callTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: "已取消待审核清理；所有待审核目录记录均已保留。",
        });
        return { chat_id: chatId, cancelled: true };
      }
      if (action.action === "prompt") {
        const entries = await this.startPendingReviewCleanup(db, { userId });
        if (entries.length === 0) {
          await this.callTelegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "当前没有待审核目录记录。",
            show_alert: true,
          });
          return { chat_id: chatId, ignored: "no_pending_media" };
        }
        await this.callTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "请在新消息中确认清理。",
        });
        await this.callTelegram(env, "sendMessage", {
          chat_id: chatId,
          text: formatPendingReviewCleanupConfirmation(entries),
          parse_mode: "HTML",
          reply_markup: buildPendingReviewCleanupConfirmationMarkup(),
        });
        return { chat_id: chatId, confirmation_requested: entries.length };
      }
      const result = await this.deletePendingReviewMedia(db, { deletedByUserId: userId });
      await this.callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.outcome === "cleaned" ? "目录清理完成" : "清理对象已失效",
        show_alert: result.outcome !== "cleaned",
      });
      await this.callTelegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text: formatPendingReviewCleanupResult(result),
        parse_mode: "HTML",
      });
      return { chat_id: chatId, outcome: result.outcome, deleted_count: result.deleted_count };
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

    async listPendingReviews(db) {
      const result = await db
        .prepare(
          `SELECT
             r.review_type,
             r.trigger,
             r.subject_type,
             r.raw_values_json,
             r.normalized_values_json,
             r.origin,
             r.created_at,
             m.normalized_code,
             cp.tg_chat_id,
             cp.tg_message_id
           FROM review_items r
           JOIN media m ON m.id = r.media_id
           LEFT JOIN channel_posts cp ON cp.media_id = m.id
           WHERE r.status = 'pending'
           ORDER BY r.created_at, r.id
           LIMIT 10`,
        )
        .all();
      return (result.results ?? []).map((row) => ({
        review_type: row.review_type,
        trigger: row.trigger,
        subject_type: row.subject_type,
        raw_values: parseJsonArray(row.raw_values_json),
        normalized_values: parseJsonArray(row.normalized_values_json),
        origin: row.origin,
        created_at: row.created_at,
        code: row.normalized_code,
        channel_chat_id: row.tg_chat_id,
        channel_message_id: row.tg_message_id,
      }));
    },

    async listPendingReviewMedia(db) {
      const result = await db
        .prepare(
          `SELECT
             m.id AS media_id,
             m.normalized_code,
             m.title,
             m.status AS media_status,
             m.created_at,
             m.updated_at,
             cp.tg_chat_id,
             cp.tg_message_id,
             COUNT(r.id) AS pending_review_count
           FROM media m
           JOIN review_items r ON r.media_id = m.id AND r.status = 'pending'
           LEFT JOIN channel_posts cp ON cp.media_id = m.id
           GROUP BY m.id
           ORDER BY MIN(r.created_at), m.id`,
        )
        .all();
      return (result.results ?? []).map((row) => ({
        media_id: row.media_id,
        code: row.normalized_code,
        title: row.title,
        media_status: row.media_status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        channel_chat_id: row.tg_chat_id,
        channel_message_id: row.tg_message_id,
        pending_review_count: Number(row.pending_review_count ?? 0),
      }));
    },

    async startPendingReviewCleanup(db, { userId }) {
      const entries = await this.listPendingReviewMedia(db);
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO pending_media_cleanup_sessions (
             tg_user_id, media_ids_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT (tg_user_id) DO UPDATE SET
             media_ids_json = excluded.media_ids_json,
             updated_at = excluded.updated_at`,
        )
        .bind(String(userId), JSON.stringify(entries.map((entry) => entry.media_id)), now, now)
        .run();
      return entries;
    },

    async getPendingReviewCleanupSession(db, { userId }) {
      const row = await db
        .prepare("SELECT media_ids_json FROM pending_media_cleanup_sessions WHERE tg_user_id = ?")
        .bind(String(userId))
        .first();
      return parseJsonArray(row?.media_ids_json).filter((mediaId) => /^media_[a-f0-9]{32}$/iu.test(mediaId));
    },

    async clearPendingReviewCleanupSession(db, { userId }) {
      await db
        .prepare("DELETE FROM pending_media_cleanup_sessions WHERE tg_user_id = ?")
        .bind(String(userId))
        .run();
    },

    async deletePendingReviewMedia(db, { deletedByUserId }) {
      const mediaIds = await this.getPendingReviewCleanupSession(db, { userId: deletedByUserId });
      if (mediaIds.length === 0) {
        return { outcome: "cleanup_session_missing", deleted_count: 0, entries: [] };
      }
      const activeEntries = (await this.listPendingReviewMedia(db))
        .filter((entry) => mediaIds.includes(entry.media_id));
      if (activeEntries.length === 0) {
        await this.clearPendingReviewCleanupSession(db, { userId: deletedByUserId });
        return { outcome: "nothing_to_clean", deleted_count: 0, entries: [] };
      }
      const requestedAt = new Date().toISOString();
      const prepared = activeEntries.map((entry) => ({
        ...entry,
        audit_token: crypto.randomUUID(),
        snapshot_json: JSON.stringify({
          media_id: entry.media_id,
          normalized_code: entry.code,
          title: entry.title,
          media_status: entry.media_status,
          created_at: entry.created_at,
          updated_at: entry.updated_at,
          tg_chat_id: entry.channel_chat_id,
          tg_message_id: entry.channel_message_id,
          pending_review_count: entry.pending_review_count,
          deletion_scope: "catalog_only_no_telegram_delete",
        }),
      }));
      const completedAt = new Date().toISOString();
      const statements = [];
      for (const entry of prepared) {
        statements.push(
          db.prepare(
            `INSERT INTO pending_media_cleanup_audit (
               audit_token, media_id, deleted_by_tg_user_id, snapshot_json,
               outcome, requested_at, completed_at, error_message
             ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
          ).bind(
            entry.audit_token,
            entry.media_id,
            deletedByUserId,
            entry.snapshot_json,
            requestedAt,
            completedAt,
            "Catalog record removed after explicit administrator confirmation; Telegram message was not deleted.",
          ),
          db.prepare("DELETE FROM media WHERE id = ? AND status = 'pending'").bind(entry.media_id),
        );
      }
      const results = await db.batch(statements);
      await this.clearPendingReviewCleanupSession(db, { userId: deletedByUserId });
      const deletedCount = results.filter((result, index) =>
        index % 2 === 1 && Number(result?.meta?.changes ?? result?.changes ?? 0) > 0,
      ).length;
      return {
        outcome: "cleaned",
        deleted_count: deletedCount,
        entries: prepared,
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

  async function resolveStorySelectionSearch(db, query, page) {
    const rawCodes = splitStoryCodeQueries(query);
    if (rawCodes.length < 2) {
      return resolveDirectorySearch(db, query, page);
    }
    const lookups = rawCodes.map((rawCode) => {
      const { resolution } = searchService.resolveQuery(rawCode);
      return resolution?.type === "code" ? { rawCode, resolution } : null;
    });
    if (lookups.some((lookup) => !lookup)) {
      return resolveDirectorySearch(db, query, page);
    }
    const matched = await Promise.all(lookups.map(async ({ rawCode, resolution }) => ({
      rawCode,
      resolution,
      result: await findDirectoryMedia(db, resolution, 1),
    })));
    const results = [];
    const seenMedia = new Set();
    const unmatchedCodes = [];
    for (const entry of matched) {
      if (entry.result.total === 0) {
        unmatchedCodes.push(entry.resolution.code ?? entry.rawCode);
        continue;
      }
      for (const media of entry.result.results) {
        if (!seenMedia.has(media.id)) {
          seenMedia.add(media.id);
          results.push(media);
        }
      }
    }
    return {
      resolution: {
        type: "batch_codes",
        codes: matched.map((entry) => entry.resolution.code ?? entry.rawCode),
        unmatched_codes: unmatchedCodes,
      },
      result: {
        page: 1,
        page_size: Math.max(results.length, 1),
        total: results.length,
        results,
      },
    };
  }

  function splitStoryCodeQueries(query) {
    if (typeof query !== "string") {
      return [];
    }
    const parts = query
      .split(/[，,；;\s]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    return [...new Set(parts)].slice(0, STORY_BATCH_CODE_LIMIT);
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

  async function editStoryMessage(telegramService, env, callback, {
    text,
    replyMarkup,
    answerCallback = true,
  }) {
    const chatId = callback.message.chat.id;
    if (answerCallback) {
      await telegramService.callTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
      });
    }
    try {
      await telegramService.callTelegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      if (!String(error.message).includes("message is not modified")) {
        throw error;
      }
    }
    return { chat_id: chatId, replied: true };
  }

  async function editStorySelectionMessage(telegramService, db, callback, env, {
    storyService: activeStoryService,
    userId,
    page,
    answerCallback = true,
  }) {
    const session = await activeStoryService.getSession(db, userId);
    const story = session?.story_id
      ? await activeStoryService.getStory(db, session.story_id)
      : null;
    if (!session?.query || !story) {
      await activeStoryService.clearSession(db, userId);
      return editStoryMessage(telegramService, env, callback, {
        text: "当前剧情选片已失效，请重新点击“管理视频”。",
        replyMarkup: null,
        answerCallback,
      });
    }
    const search = await resolveStorySelectionSearch(db, session.query, page);
    const selectedMediaIds = await activeStoryService.listSelectedMediaIds(db, userId);
    return editStoryMessage(telegramService, env, callback, {
      text: formatStorySelectionReply(story, {
        query: session.query,
        resolution: search.resolution,
        searchResult: search.result,
        selectedCount: selectedMediaIds.length,
      }),
      replyMarkup: buildStorySelectionMarkup(story, search.result, selectedMediaIds),
      answerCallback,
    });
  }

  async function editStoryRemovalMessage(telegramService, db, callback, env, {
    storyService: activeStoryService,
    userId,
    page,
    notice = "",
  }) {
    const session = await activeStoryService.getMediaRemovalSession(db, userId);
    const story = session?.story_id
      ? await activeStoryService.getStory(db, session.story_id)
      : null;
    if (!story) {
      await activeStoryService.clearMediaRemovalSession(db, userId);
      return editStoryMessage(telegramService, env, callback, {
        text: "当前二级视频移除已失效，请重新打开剧情条目。",
        replyMarkup: null,
      });
    }
    const mediaPage = await activeStoryService.findStoryMedia(db, {
      storyId: story.id,
      page,
      pageSize: botResult.page_size,
    });
    const body = formatStoryRemovalPage(story, mediaPage, telegramService.renderBotResults.bind(telegramService));
    return editStoryMessage(telegramService, env, callback, {
      text: notice ? `${notice}\n\n${body}` : body,
      replyMarkup: buildStoryRemovalMarkup(mediaPage),
    });
  }

  function formatStoryList() {
    // Telegram 的内联按钮必须附着在一条非空消息上；使用简短标题，
    // 清楚说明下方为可点选的剧情目录。
    return "系列剧情目录";
  }

  function formatStoryCreated({ story, created }) {
    const prefix = created ? "✅ 已创建" : "该剧情已存在";
    return `${prefix}：<b>${escapeHtml(story.title)}</b>【${story.video_count}】\n\n点击“添加视频”开始选择二级视频。`;
  }

  function formatStoryManagementPrompt(story) {
    return `<b>正在管理：</b>${escapeHtml(story.title)}【${story.video_count}】\n\n可直接转发当前频道中的视频到这里，Bot 会自动加入本次已选；也可输入番号、番号前缀、演员名或 #话题筛选。多个番号可用逗号、空格或换行一次粘贴，例如：ADN-405, ADN-415, ADN-442。可一次勾选多部视频，最后点击“加入已选视频”统一关联。`;
  }

  function formatStoryMediaPage(story, page, renderResults) {
    const header = `<b>${escapeHtml(story.title)}</b>【${story.video_count}】`;
    if (page.total === 0) {
      return `${header}\n\n该剧情暂未关联视频。`;
    }
    return `${header}\n\n${renderResults(page)}`;
  }

  function formatStoryRemovalPage(story, page, renderResults) {
    const header = `<b>移除“${escapeHtml(story.title)}”中的二级视频</b>\n当前关联 ${story.video_count} 部`;
    if (page.total === 0) {
      return `${header}\n\n该剧情已没有可移除的视频。`;
    }
    return `${header}\n\n${renderResults(page)}\n\n点击下方“从当前剧情移除”只会解除剧情关联，不删除频道视频或媒体目录。`;
  }

  function formatStoryDeleteConfirmation(story) {
    return `<b>确认删除一级剧情？</b>\n\n“${escapeHtml(story.title)}”【${story.video_count}】将被删除，关联的二级视频会从该剧情解除。频道视频、媒体目录和其他剧情不会被删除。`;
  }

  function formatStoryMediaRemovalConfirmation(story, media) {
    const code = media.code ? `#${escapeHtml(media.code)}` : "该视频";
    return `<b>确认移除二级视频？</b>\n\n将 ${code} 从“${escapeHtml(story.title)}”中移除。频道视频、媒体目录和其他剧情不会被删除。`;
  }

  function formatStorySelectionReply(story, {
    query,
    resolution,
    searchResult,
    selectedCount = 0,
  }) {
    const heading = `<b>为“${escapeHtml(story.title)}”选择视频</b>\n已选 ${selectedCount} 部`;
    if (resolution?.type !== "batch_codes") {
      return `${heading}\n\n${renderSearchReply({ query, resolution, searchResult })}`;
    }
    const requested = resolution.codes.length;
    const matched = searchResult.results.length;
    const lines = [`${heading}\n已匹配 ${matched}/${requested} 部`];
    if (searchResult.results.length > 0) {
      lines.push("", ...searchResult.results.map((media, index) => renderDirectoryEntry(media, index + 1)));
    }
    if (resolution.unmatched_codes.length > 0) {
      lines.push(
        "",
        `未找到：${escapeHtml(resolution.unmatched_codes.join("、"))}`,
        "可直接把这些频道视频转发到此处，Bot 会自动加入本次已选。",
      );
    }
    return lines.join("\n");
  }

  function buildStoryListMarkup(page) {
    const rows = page.results.flatMap((story) => {
      const callbackData = encodeStoryCallback("view", story.id, page.page);
      if (!callbackData) {
        return [];
      }
      const label = `【${story.video_count}】 ${story.title}`;
      return [[{ text: label.length > 60 ? `${label.slice(0, 59)}…` : label, callback_data: callbackData }]];
    });
    const pagination = [];
    if (page.page > 1) {
      pagination.push({ text: "‹ 上一页", callback_data: encodeStoryCallback("list", page.page - 1) });
    }
    if (page.page * page.page_size < page.total) {
      pagination.push({ text: "下一页 ›", callback_data: encodeStoryCallback("list", page.page + 1) });
    }
    if (pagination.length > 0) {
      rows.push(pagination.filter((entry) => entry.callback_data));
    }
    return rows.length > 0 ? { inline_keyboard: rows } : null;
  }

  function buildStoryCreatedMarkup(story) {
    return {
      inline_keyboard: [
        [{ text: "添加视频", callback_data: encodeStoryCallback("manage", story.id) }],
        [{ text: "查看系列剧情", callback_data: encodeStoryCallback("list", 1) }],
      ],
    };
  }

  function buildStoryEntryCancelMarkup() {
    return {
      inline_keyboard: [[{ text: "取消", callback_data: encodeStoryCallback("cancel") }]],
    };
  }

  function buildStoryManagementMarkup(story) {
    return {
      inline_keyboard: [
        [{ text: "查看该剧情", callback_data: encodeStoryCallback("view", story.id, 1) }],
        [{ text: "加入已选视频", callback_data: encodeStoryCallback("commit") }, { text: "取消", callback_data: encodeStoryCallback("cancel") }],
      ],
    };
  }

  function buildStoryMediaMarkup(story, page, { isUserAdmin }) {
    const rows = [];
    const pagination = [];
    if (page.page > 1) {
      pagination.push({ text: "‹ 上一页", callback_data: encodeStoryCallback("view", story.id, page.page - 1) });
    }
    if (page.page * page.page_size < page.total) {
      pagination.push({ text: "下一页 ›", callback_data: encodeStoryCallback("view", story.id, page.page + 1) });
    }
    if (pagination.length > 0) {
      rows.push(pagination.filter((entry) => entry.callback_data));
    }
    if (isUserAdmin) {
      rows.push([{ text: "管理视频", callback_data: encodeStoryCallback("manage", story.id) }]);
      rows.push([{ text: "移除二级视频", callback_data: encodeStoryCallback("removal_start", story.id) }]);
      rows.push([{ text: "删除本剧情", callback_data: encodeStoryCallback("delete_story_prompt", story.id) }]);
    }
    rows.push([{ text: "返回剧情目录", callback_data: encodeStoryCallback("list", 1) }]);
    return { inline_keyboard: rows };
  }

  function buildStoryRemovalMarkup(page) {
    const rows = [];
    for (const media of page.results) {
      const callbackData = encodeStoryCallback("remove_story_media_prompt", media.id);
      if (!callbackData) {
        continue;
      }
      rows.push([{
        text: `从当前剧情移除 · ${media.code ? `#${media.code}` : "未标号视频"}`,
        callback_data: callbackData,
      }]);
    }
    const pagination = [];
    if (page.page > 1) {
      pagination.push({ text: "‹ 上一页", callback_data: encodeStoryCallback("removal_page", page.page - 1) });
    }
    if (page.page * page.page_size < page.total) {
      pagination.push({ text: "下一页 ›", callback_data: encodeStoryCallback("removal_page", page.page + 1) });
    }
    if (pagination.length > 0) {
      rows.push(pagination.filter((entry) => entry.callback_data));
    }
    rows.push([{ text: "退出移除", callback_data: encodeStoryCallback("removal_cancel") }]);
    return { inline_keyboard: rows };
  }

  function buildStoryDeleteConfirmationMarkup(story) {
    return {
      inline_keyboard: [
        [{ text: "确认删除剧情", callback_data: encodeStoryCallback("delete_story_confirm", story.id) }],
        [{ text: "取消", callback_data: encodeStoryCallback("list", 1) }],
      ],
    };
  }

  function buildStoryMediaRemovalConfirmationMarkup(media) {
    return {
      inline_keyboard: [
        [{ text: "确认移除视频", callback_data: encodeStoryCallback("remove_story_media_confirm", media.id) }],
        [{ text: "取消", callback_data: encodeStoryCallback("removal_page", 1) }],
      ],
    };
  }

  function buildStorySelectionMarkup(story, searchResult, selectedMediaIds = []) {
    const selected = new Set(selectedMediaIds);
    const rows = [];
    for (const media of searchResult.results) {
      const callbackData = encodeStoryCallback("select", media.id);
      if (!callbackData) {
        continue;
      }
      const code = media.code ? `#${media.code}` : "未标号视频";
      rows.push([{
        text: `${selected.has(media.id) ? "☑ 已选" : "□ 选择"} · ${code}`,
        callback_data: callbackData,
      }]);
    }
    const pagination = [];
    if (searchResult.page > 1) {
      pagination.push({ text: "‹ 上一页", callback_data: encodeStoryCallback("query_page", searchResult.page - 1) });
    }
    if (searchResult.page * searchResult.page_size < searchResult.total) {
      pagination.push({ text: "下一页 ›", callback_data: encodeStoryCallback("query_page", searchResult.page + 1) });
    }
    if (pagination.length > 0) {
      rows.push(pagination.filter((entry) => entry.callback_data));
    }
    rows.push([{
      text: `加入已选视频（${selected.size}）`,
      callback_data: encodeStoryCallback("commit"),
    }]);
    rows.push([{ text: "取消", callback_data: encodeStoryCallback("cancel") }]);
    return { inline_keyboard: rows };
  }

  function encodeStoryCallback(action, value, page) {
    const actionCode = {
      list: "l",
      view: "v",
      manage: "m",
      query_page: "q",
      select: "s",
      commit: "c",
      cancel: "x",
      removal_start: "r",
      removal_page: "p",
      removal_cancel: "rx",
      remove_story_media_prompt: "u",
      remove_story_media_confirm: "uc",
      delete_story_prompt: "t",
      delete_story_confirm: "tc",
    }[action];
    if (!actionCode) {
      return null;
    }
    let data = `story:${actionCode}`;
    if (action === "list" || action === "query_page") {
      if (!Number.isInteger(value) || value < 1 || value > 9999) {
        return null;
      }
      data += `:${value}`;
    } else if (action === "view") {
      if (!isStoryIdentifier(value) || !Number.isInteger(page) || page < 1 || page > 9999) {
        return null;
      }
      data += `:${value}:${page}`;
    } else if (action === "manage" || action === "removal_start" || action === "delete_story_prompt" || action === "delete_story_confirm") {
      if (!isStoryIdentifier(value)) {
        return null;
      }
      data += `:${value}`;
    } else if (action === "removal_page") {
      if (!Number.isInteger(value) || value < 1 || value > 9999) {
        return null;
      }
      data += `:${value}`;
    } else if (action === "select" || action === "remove_story_media_prompt" || action === "remove_story_media_confirm") {
      if (!isMediaIdentifier(value)) {
        return null;
      }
      data += `:${value}`;
    }
    return data.length <= 64 ? data : null;
  }

  function decodeStoryCallback(data) {
    if (typeof data !== "string") {
      return null;
    }
    let match = /^story:l:(\d{1,4})$/u.exec(data);
    if (match) {
      return { type: "list", page: Number(match[1]) };
    }
    match = /^story:v:(story_[a-f0-9]{32}):(\d{1,4})$/iu.exec(data);
    if (match) {
      return { type: "view", storyId: match[1].toLowerCase(), page: Number(match[2]) };
    }
    match = /^story:m:(story_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "manage", storyId: match[1].toLowerCase() };
    }
    match = /^story:r:(story_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "removal_start", storyId: match[1].toLowerCase() };
    }
    match = /^story:t:(story_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "delete_story_prompt", storyId: match[1].toLowerCase() };
    }
    match = /^story:tc:(story_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "delete_story_confirm", storyId: match[1].toLowerCase() };
    }
    match = /^story:p:(\d{1,4})$/u.exec(data);
    if (match) {
      return { type: "removal_page", page: Number(match[1]) };
    }
    match = /^story:q:(\d{1,4})$/u.exec(data);
    if (match) {
      return { type: "query_page", page: Number(match[1]) };
    }
    match = /^story:s:(media_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "select", mediaId: match[1].toLowerCase() };
    }
    match = /^story:u:(media_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "remove_story_media_prompt", mediaId: match[1].toLowerCase() };
    }
    match = /^story:uc:(media_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "remove_story_media_confirm", mediaId: match[1].toLowerCase() };
    }
    // 兼容部署前已发送的“加入当前剧情”旧按钮：点击后只改为勾选，
    // 不再直接建立剧情—视频关联。
    match = /^story:a:(media_[a-f0-9]{32})$/iu.exec(data);
    if (match) {
      return { type: "select", mediaId: match[1].toLowerCase() };
    }
    if (data === "story:c" || data === "story:d") {
      return { type: "commit" };
    }
    if (data === "story:rx") {
      return { type: "removal_cancel" };
    }
    if (data === "story:x") {
      return { type: "cancel" };
    }
    return null;
  }

  function isStoryIdentifier(value) {
    return /^story_[a-f0-9]{32}$/iu.test(value ?? "");
  }

  function isMediaIdentifier(value) {
    return /^media_[a-f0-9]{32}$/iu.test(value ?? "");
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
  const description = summarizeBotDescription(media.description);
  const lines = [`${index} • ${[linkEntry(code), ...tagEntries].join("  ")}`];
  if (description) {
    lines.push(`<b>简介：</b>${escapeHtml(description)}`);
  }
  return lines.join("\n");
}

function summarizeBotDescription(value) {
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length > BOT_DESCRIPTION_LIMIT
    ? `${compact.slice(0, BOT_DESCRIPTION_LIMIT - 1)}…`
    : compact;
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

function buildPendingReviewCleanupMarkup(reviews) {
  if (reviews.length === 0) {
    return null;
  }
  return {
    inline_keyboard: [[{
      text: `清理当前 ${reviews.length} 条待审核收录`,
      callback_data: encodePendingReviewCleanupCallback("prompt"),
    }]],
  };
}

function buildPendingReviewCleanupConfirmationMarkup() {
  return {
    inline_keyboard: [[
      { text: "确认清理这些记录", callback_data: encodePendingReviewCleanupCallback("confirm") },
      { text: "取消", callback_data: encodePendingReviewCleanupCallback("cancel") },
    ]],
  };
}

function encodePendingReviewCleanupCallback(action) {
  return { prompt: "revclean:p", confirm: "revclean:c", cancel: "revclean:x" }[action] ?? null;
}

function decodePendingReviewCleanupCallback(data) {
  const actionCode = typeof data === "string" ? /^revclean:([pcx])$/u.exec(data)?.[1] : null;
  const action = { p: "prompt", c: "confirm", x: "cancel" }[actionCode];
  return action ? { action } : null;
}

function formatPendingReviewCleanupConfirmation(entries) {
  const labels = entries.map((entry, index) => {
    const code = entry.code ? `#${escapeHtml(entry.code)}` : "未识别编号";
    const title = String(entry.title ?? "").trim();
    return `${index + 1}．${code}${title ? ` · ${escapeHtml(title)}` : ""}`;
  });
  return [
    `<b>确认清理 ${entries.length} 条待审核收录？</b>`,
    "",
    ...labels,
    "",
    "将只删除这些媒体目录记录、其频道映射和待审核项；不会删除 Telegram 频道消息，也不会影响其他已审核资源或剧情。",
  ].join("\n");
}

function formatPendingReviewCleanupResult(result) {
  if (result.outcome === "cleanup_session_missing") {
    return "未执行清理：确认已失效，请重新输入 /reviews 后再次操作。";
  }
  if (result.outcome === "nothing_to_clean") {
    return "未执行清理：确认页中的待审核记录已不存在或已被处理。";
  }
  return `✅ 已清理 ${result.deleted_count} 条待审核目录记录，并写入审计。Telegram 频道消息未删除。`;
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

function formatPendingReviews(reviews) {
  if (reviews.length === 0) {
    return "<b>待审核明细</b>\n\n当前没有待审核项。";
  }
  const lines = [`<b>待审核明细</b>（${reviews.length} 条）`];
  for (const [index, item] of reviews.entries()) {
    const channelUrl = channelMessageUrl(item.channel_chat_id, item.channel_message_id);
    const code = item.code ? `#${escapeHtml(item.code)}` : "未识别编号";
    const codeText = channelUrl ? `<a href="${escapeHtml(channelUrl)}">${code}</a>` : code;
    const rawValues = item.raw_values.map((value) => escapeHtml(String(value))).filter(Boolean);
    lines.push(
      "",
      `${index + 1} • ${codeText}`,
      `原因：${escapeHtml(reviewTypeLabel(item.review_type))}`,
      `待确认：${rawValues.length > 0 ? rawValues.join("、") : "未提供"}`,
    );
  }
  lines.push("", "仅供查看，不会自动修改标签、演员或编号规则。");
  return lines.join("\n");
}

function reviewTypeLabel(value) {
  const labels = {
    pending_tag: "标签未识别",
    pending_actor: "演员名称未识别或有歧义",
    pending_alias: "别名需要确认",
    pending_category: "分类需要确认",
    possible_code: "编号格式需要确认",
  };
  return labels[value] ?? "需要人工确认";
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  const { _pending_received_at, ...post } = source;
  return {
    ...post,
    message_id: messageId,
    forward_origin: null,
    forward_from: null,
  };
}

function latestPendingForwardPost(posts) {
  return posts.reduce((latest, post) => {
    if (!latest) {
      return post;
    }
    const latestAt = Date.parse(latest._pending_received_at ?? "");
    const postAt = Date.parse(post._pending_received_at ?? "");
    if (Number.isFinite(postAt) && (!Number.isFinite(latestAt) || postAt > latestAt)) {
      return post;
    }
    if (postAt === latestAt && Number(post.message_id) > Number(latest.message_id)) {
      return post;
    }
    return latest;
  }, null);
}

function sortChannelPosts(posts) {
  return [...posts].sort((left, right) => Number(left.message_id) - Number(right.message_id));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function deletePendingForwardGroup(db, key) {
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
      "SELECT value, updated_at FROM database_metadata WHERE substr(key, 1, length(?)) = ? ORDER BY key",
    )
    .bind(messagePrefix, messagePrefix)
    .all();
  return (result.results ?? []).flatMap((row) => {
    try {
      const post = JSON.parse(row.value);
      return Number.isInteger(Number(post?.message_id))
        ? [{ ...post, _pending_received_at: row.updated_at ?? null }]
        : [];
    } catch {
      return [];
    }
  });
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
  await clearStalePendingForwardGroup(db, key);
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

async function clearStalePendingForwardGroup(db, key) {
  const state = await db
    .prepare("SELECT value, updated_at FROM database_metadata WHERE key = ?")
    .bind(pendingForwardGroupStateKey(key))
    .first();
  if (!state?.value) {
    return;
  }
  const staleBefore = new Date(Date.now() - PENDING_FORWARD_GROUP_STALE_MS).toISOString();
  const isFinished = state.value === "processed";
  const isStaleProcessing =
    state.value === "processing" &&
    typeof state.updated_at === "string" &&
    state.updated_at < staleBefore;
  if (isFinished || isStaleProcessing) {
    await deletePendingForwardGroup(db, key);
  }
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
    const codeMatches = !context.code || !code || code === context.code;
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
    raw_tags: rawTags,
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
