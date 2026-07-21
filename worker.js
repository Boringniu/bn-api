const CONFIG = {
  AI_URL: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  AI_MODEL: "glm-4.7-flash",
  MERGE_WAIT_MS: 2000,
  MERGE_MAX_WAIT_MS: 10000,
  MERGE_MAX_ITEMS: 20,
  MAX_REPLY_LEN: 200,
  HISTORY_MAX_MESSAGES: 10,
  HISTORY_TTL: 7200,
  WELCOME_COOLDOWN_MS: 12 * 60 * 60 * 1000,
  TAKEOVER_TTL_MS: 20 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 15000,
  botPrefix: "🫪🫪🫪🛌躺平🤦🏻摆烂🧘🫪🫪🫪",
  systemPrompt: `全程隐藏AI身份，严禁出现AI、助手、机器人等暴露词汇。
人设：佛系松弛、摆烂随性、随遇而安。拒绝线上随时待命。作息随心所欲，经常离线失联，语气轻松口语化，略带慵懒感，不严肃刻板，拒绝宣腔。像是在说"算了，随它去吧”的感觉。对方是主人的联系人，态度随性温和，不调侃、不冷嘲。
预设欢迎语只用于首次展示给特定联系人，不属于对话内容，也不作为后续回复的语气或措辞参考。
规则：1. 只收纳正事留言，拒绝闲聊唠嗑、趣味问答、身份猜测类对话。2. 绝不替主人答应约会、约定时间、许诺任何事情、处理金钱相关问题。3. 被追问不回消息时可以轻松说明：平时不常刷手机，推送很容易漏掉。4. 回复简短，拒绝写大段文字，摒弃格式化客套话。5. 无法答复的问题统一委婉留存留言，等待本人上线处理。6. 始终保持温和，不使用反问、挖苦、阴阳怪气或带攻击性的玩笑。`,
  tempPublic: 0.6,
  tempAdmin: 0.6
};

const OPENING_POOL = [
  "近期线下放空模式，没有实时在线。有想说的话可以留言，莫急，我闲下来会回看消息。",
  "离线待机，非实时在线。有事留言，上线自会回复，请勿等候即时回复。",
  "没有常驻线上，消息会延迟查看。把事情留下来，稍后处理回复。",
  "手机未随身携带，不知你发送消息，滞后接收。留下你的内容，晚些回复。",
  "独处躺平摆烂中，手机常年静音漏推送。如有事慢慢留话，勿急，随缘回复。"
];

const CUSTOM_WELCOME_MAP = {
  "8336355467": "哟，这是我九哥得，九哥好🫡🫡🫡 今日怎么有空跟我发消息得，么情况？该不得说是要了我地愿，要掺我坐哈吧😱😱😱",
  "7590811080": "么家？歹地忙，冒得时间一天拉黑和你日白，就这。"
};

function getRandomOpening() {
  return OPENING_POOL[Math.floor(Math.random() * OPENING_POOL.length)];
}

function validateEnv(env) {
  const adminId = Number(env.ADMIN_ID);
  const missing = [];

  if (!env.TG_BOT_TOKEN) missing.push("TG_BOT_TOKEN");
  if (!env.AI_API_KEY) missing.push("AI_API_KEY");
  if (!env.tg_chat_kv) missing.push("tg_chat_kv");
  if (!env.CHAT_HANDLER) missing.push("CHAT_HANDLER");
  if (!Number.isSafeInteger(adminId)) missing.push("ADMIN_ID");

  if (missing.length) {
    throw new Error(`Missing or invalid bindings: ${missing.join(", ")}`);
  }

  return adminId;
}

function getChatStub(env, chatId) {
  const id = env.CHAT_HANDLER.idFromName(String(chatId));
  return env.CHAT_HANDLER.get(id);
}

async function getPmSwitch(env, KV) {
  const globalSwitch = await KV.get("global_pm_switch");

  // 管理指令的显式设置优先于环境变量默认值。
  if (globalSwitch === "on") return true;
  if (globalSwitch === "off") return false;
  return env.PM_SWITCH !== "off";
}

function parseJsonArray(raw) {
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function trimHistory(history) {
  return history.slice(-CONFIG.HISTORY_MAX_MESSAGES);
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Segmenter 可避免从 emoji 或组合字符中间截断；不支持时退回码点截断。
  if (typeof Intl?.Segmenter === "function") {
    const segments = Array.from(new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text));
    return segments.slice(0, maxLength).map((item) => item.segment).join("");
  }

  return Array.from(text).slice(0, maxLength).join("");
}

function splitTelegramText(text, maxLength = 4000) {
  const result = [];
  let remaining = String(text || "");

  while (remaining.length > maxLength) {
    let cutAt = remaining.lastIndexOf("\n", maxLength);
    if (cutAt < Math.floor(maxLength / 2)) cutAt = maxLength;
    result.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).replace(/^\n/, "");
  }

  if (remaining) result.push(remaining);
  return result.length ? result : [""];
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function telegramRequest(token, method, payload) {
  const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(
      `Telegram ${method} failed: ${response.status} ${data?.description || "unknown error"}`
    );
  }

  return data.result;
}

async function sendBotMsg(token, chatId, text) {
  for (const chunk of splitTelegramText(text)) {
    await telegramRequest(token, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function safeSendTG(token, businessConnId, chatId, text, msgId) {
  const payload = { chat_id: chatId, text };
  if (businessConnId) payload.business_connection_id = businessConnId;
  if (msgId) {
    payload.reply_parameters = {
      message_id: msgId,
      allow_sending_without_reply: true
    };
  }

  return telegramRequest(token, "sendMessage", payload);
}

async function requestAiReply({ apiKey, temperature, systemPrompt, history }) {
  const response = await fetchWithTimeout(CONFIG.AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: CONFIG.AI_MODEL,
      temperature,
      stream: false,
      messages: [{ role: "system", content: systemPrompt }, ...history]
    })
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.[0]?.error?.message ||
      data?.message ||
      `HTTP ${response.status}`;
    throw new Error(`AI request failed: ${detail}`);
  }

  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("AI returned empty content");
  return content;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Only POST Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let ADMIN_ID;
    try {
      ADMIN_ID = validateEnv(env);
    } catch (error) {
      console.error("Worker configuration error:", error?.message || error);
      return new Response("Worker Configuration Error", { status: 500 });
    }

    if (
      env.TG_WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_WEBHOOK_SECRET
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      if (payload.business_connection) {
        const conn = payload.business_connection;
        await env.tg_chat_kv.put(
          "business_status_string",
          conn.is_enabled ? "已激活（使用你的账号回复客户）✅" : "已断开 ❌"
        );
        return new Response("OK");
      }

      if (payload.business_message) {
        await handleBusinessMessage(payload.business_message, env, ADMIN_ID);
        return new Response("OK");
      }

      if (payload.message) {
        await handleNormalMessage(
          payload,
          env,
          ADMIN_ID,
          env.TG_BOT_TOKEN,
          env.AI_API_KEY,
          env.tg_chat_kv
        );
        return new Response("OK");
      }

      return new Response("OK");
    } catch (error) {
      console.error("Webhook processing error:", error?.stack || error);

      // 返回 500 让 Telegram 重试；商务消息由 DO 内的 message_id 再做去重。
      return new Response("Temporary Error", { status: 500 });
    }
  }
};

async function handleBusinessMessage(msg, env, ADMIN_ID) {
  const chatId = msg.chat?.id;
  if (chatId == null) return;

  // Bot 代表商务账号发出的消息也会进入 webhook，必须先排除，避免误触发人工接管。
  if (msg.sender_business_bot) return;

  const stub = getChatStub(env, chatId);

  // 管理员每发一条人工消息，都刷新 20 分钟接管期限。
  if (msg.from?.id === ADMIN_ID) {
    const response = await stub.fetch("https://chat.internal/takeover", { method: "POST" });
    if (!response.ok) throw new Error(`Takeover failed: ${response.status}`);
    return;
  }

  const userText = msg.text?.trim();
  if (!userText || !(await getPmSwitch(env, env.tg_chat_kv))) return;

  // 关键入队直接 await。只有 DO 确认收下消息后才向 Telegram 返回成功。
  const response = await stub.fetch("https://chat.internal/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId,
      msgId: msg.message_id,
      businessConnId: msg.business_connection_id,
      text: userText,
      // 定制欢迎语按联系人用户 ID 匹配，不依赖聊天 ID 的具体形式。
      welcomeText: CUSTOM_WELCOME_MAP[String(msg.from?.id)] || null
    })
  });

  if (!response.ok) throw new Error(`Queue push failed: ${response.status}`);
}

async function handleNormalMessage(payload, env, ADMIN_ID, token, AI_API_KEY, KV) {
  const msg = payload.message;
  const chatId = msg.chat?.id;
  const inputText = msg.text?.trim();

  // 管理命令只接受管理员与 Bot 的私聊消息，同时校验发送者身份。
  if (!inputText || chatId !== ADMIN_ID || msg.from?.id !== ADMIN_ID) return;

  // 普通管理员消息仍用 update_id 做轻量去重，写入放在处理成功之后。
  const dedupKey = payload.update_id == null ? null : `admin_dedup_${payload.update_id}`;
  if (dedupKey && await KV.get(dedupKey)) return;

  if (inputText.startsWith("/")) {
    await handleAdminCommand(inputText, token, chatId, KV, env);
  } else {
    await handleAdminChat(inputText, token, chatId, AI_API_KEY, KV);
  }

  if (dedupKey) await KV.put(dedupKey, "1", { expirationTtl: 300 });
}

async function handleAdminCommand(cmd, token, chatId, KV, env) {
  const parts = cmd.trim().split(/\s+/);
  const baseCmd = parts[0].split("@")[0].toLowerCase();
  const targetChatId = parts[1];

  switch (baseCmd) {
    case "/start":
      await sendBotMsg(token, chatId, "已启动。");
      break;

    case "/help":
      await sendBotMsg(
        token,
        chatId,
        `帮助指令：

/status - 查看当前运行状态
/pmon - 开启客户自动回复
/pmoff - 关闭客户自动回复
/history <chat_id> - 查看用户聊天记录
/clear <chat_id> - 清空客户会话并恢复托管
/clear - 清空管理员聊天记录
/resume <chat_id> - 手动恢复指定客户的自动回复
/help - 查看全部帮助指令`
      );
      break;

    case "/resume": {
      if (!isValidChatId(targetChatId)) {
        await sendBotMsg(token, chatId, "用法：/resume <chat_id>");
        break;
      }

      const response = await getChatStub(env, targetChatId).fetch("https://chat.internal/resume", {
        method: "POST"
      });
      if (!response.ok) throw new Error(`Resume failed: ${response.status}`);
      await sendBotMsg(token, chatId, `已恢复 ${targetChatId} 的自动回复。`);
      break;
    }

    case "/status": {
      const businessMode = (await KV.get("business_status_string")) || "代言 BOT 模式";
      const effective = await getPmSwitch(env, KV);
      await sendBotMsg(
        token,
        chatId,
        `当前机器人状态：\n自动回复开关：${effective ? "开启 ✅" : "关闭 ❌"}\n商务代发模式：${businessMode}`
      );
      break;
    }

    case "/pmon":
      await KV.put("global_pm_switch", "on");
      await sendBotMsg(token, chatId, "已开启客户自动回复");
      break;

    case "/pmoff":
      await KV.put("global_pm_switch", "off");
      await sendBotMsg(token, chatId, "已关闭客户自动回复");
      break;

    case "/history": {
      if (!isValidChatId(targetChatId)) {
        await sendBotMsg(token, chatId, "用法：/history <chat_id>");
        break;
      }

      const historyArr = parseJsonArray(await KV.get(`chat_${targetChatId}`));
      if (!historyArr.length) {
        await sendBotMsg(token, chatId, "暂无记录");
        break;
      }

      let display = `记录（共 ${historyArr.length} 条消息）：\n\n`;
      historyArr.forEach((item, index) => {
        display += `${index + 1}. ${item.role === "user" ? "👤" : "💬"}: ${item.content}\n\n`;
      });
      await sendBotMsg(token, chatId, display);
      break;
    }

    case "/clear": {
      if (!targetChatId) {
        await KV.delete(`admin_history_${chatId}`);
        await sendBotMsg(token, chatId, "已清空管理员聊天记录。");
        break;
      }

      if (!isValidChatId(targetChatId)) {
        await sendBotMsg(token, chatId, "用法：/clear <chat_id>");
        break;
      }

      const response = await getChatStub(env, targetChatId).fetch("https://chat.internal/clear", {
        method: "POST"
      });
      if (!response.ok) throw new Error(`Clear failed: ${response.status}`);
      await KV.delete(`chat_${targetChatId}`);
      await sendBotMsg(token, chatId, `已清理 ${targetChatId} 的记录并恢复自动回复。`);
      break;
    }

    default:
      await sendBotMsg(token, chatId, "未知指令，可发送 /help 查看帮助。");
      break;
  }
}

function isValidChatId(value) {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

async function handleAdminChat(inputText, token, chatId, AI_API_KEY, KV) {
  const key = `admin_history_${chatId}`;
  let history = parseJsonArray(await KV.get(key));
  history = trimHistory([...history, { role: "user", content: inputText }]);

  let reply;
  try {
    reply = await requestAiReply({
      apiKey: AI_API_KEY,
      temperature: CONFIG.tempAdmin,
      systemPrompt: "你是管理员的通用中文助手。回答准确、简洁。",
      history
    });
  } catch (error) {
    console.error("Admin AI error:", error?.stack || error);
    reply = `后台请求失败：${error?.message || "未知错误"}`;
  }

  await sendBotMsg(token, chatId, reply);
  history = trimHistory([...history, { role: "assistant", content: reply }]);
  await KV.put(key, JSON.stringify(history), { expirationTtl: CONFIG.HISTORY_TTL });
}

export class ChatHandler {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/push":
          return await this.push(request);
        case "/takeover":
          return await this.takeover();
        case "/resume":
          return await this.resume();
        case "/clear":
          return await this.clear();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (error) {
      console.error("ChatHandler fetch error:", error?.stack || error);
      return new Response("Temporary Error", { status: 500 });
    }
  }

  async push(request) {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const data = await request.json();
    if (!data || data.chatId == null || !data.msgId || typeof data.text !== "string") {
      return new Response("Bad Request", { status: 400 });
    }

    // 接管状态和队列在同一个 DO 中，避免先检查后入队之间的竞态。
    const takeoverUntil = (await this.state.storage.get("takeoverUntil")) || 0;
    if (takeoverUntil > Date.now()) return new Response("IGNORED_TAKEOVER");
    if (takeoverUntil) await this.state.storage.delete("takeoverUntil");

    const seenIds = (await this.state.storage.get("seenIds")) || [];
    if (seenIds.includes(data.msgId)) return new Response("DUPLICATE");

    const now = Date.now();
    const pending = (await this.state.storage.get("pending")) || {
      items: [],
      firstAt: now,
      alarmAt: now + CONFIG.MERGE_WAIT_MS
    };

    pending.items.push(data);

    // 达到合并数量上限时立即触发处理，不通过截断数组静默丢消息。
    pending.alarmAt = pending.items.length >= CONFIG.MERGE_MAX_ITEMS
      ? now
      : Math.min(now + CONFIG.MERGE_WAIT_MS, pending.firstAt + CONFIG.MERGE_MAX_WAIT_MS);

    await this.state.storage.put({
      pending,
      seenIds: [...seenIds, data.msgId].slice(-100)
    });
    await this.state.storage.setAlarm(pending.alarmAt);
    return new Response("QUEUED");
  }

  async takeover() {
    // 每条人工消息都会调用这里，因此接管期限会持续顺延。
    await this.state.storage.put("takeoverUntil", Date.now() + CONFIG.TAKEOVER_TTL_MS);

    // 人工已开始回复时，丢弃尚未处理及正在重试的自动回复任务。
    await this.state.storage.delete(["pending", "processing"]);
    await this.state.storage.deleteAlarm();
    return new Response("OK");
  }

  async resume() {
    await this.state.storage.delete("takeoverUntil");
    return new Response("OK");
  }

  async clear() {
    // 清理会话时同时重置接管、欢迎标记、去重记录和待处理队列。
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    return new Response("OK");
  }

  async shouldStopReply() {
    const takeoverUntil = (await this.state.storage.get("takeoverUntil")) || 0;
    return takeoverUntil > Date.now() || !(await getPmSwitch(this.env, this.env.tg_chat_kv));
  }

  async stopReply() {
    // 开关关闭或人工接管后，当前批次和后续待处理批次都不再回复。
    await this.state.storage.delete(["processing", "pending"]);
  }

  async alarm() {
    let processing = await this.state.storage.get("processing");

    if (!processing) {
      const pending = await this.state.storage.get("pending");
      if (!pending?.items?.length) return;

      if (Date.now() < pending.alarmAt) {
        await this.state.storage.setAlarm(pending.alarmAt);
        return;
      }

      // 先把本批次移入 processing。失败重试时复用同一批次和同一条模型回复。
      processing = {
        items: pending.items,
        reply: null,
        isAiSuccess: false,
        welcomeSent: false,
        replySent: false
      };
      await this.state.storage.put("processing", processing);
      await this.state.storage.delete("pending");
    }

    const items = processing.items;
    const latest = items[items.length - 1];
    const chatId = latest.chatId;
    const KV = this.env.tg_chat_kv;

    // 消息入队后管理员可能关闭开关或开始人工回复，所以执行前必须再次检查。
    if (await this.shouldStopReply()) {
      await this.stopReply();
      return;
    }

    let history = parseJsonArray(await KV.get(`chat_${chatId}`));
    const combinedText = items.map((item) => item.text).join("\n");
    const userHistory = trimHistory([...history, { role: "user", content: combinedText }]);

    if (processing.reply == null) {
      try {
        const rawReply = await requestAiReply({
          apiKey: this.env.AI_API_KEY,
          temperature: CONFIG.tempPublic,
          systemPrompt: CONFIG.systemPrompt,
          history: userHistory
        });
        processing.reply = truncateText(rawReply, CONFIG.MAX_REPLY_LEN);
        processing.isAiSuccess = true;
      } catch (error) {
        console.error("Public AI error:", error?.stack || error);
        processing.reply = "暂时断线了，请稍后重试。";
        processing.isAiSuccess = false;
      }

      await this.state.storage.put("processing", processing);
    }

    // 模型请求期间可能发生人工接管，发送任何内容前重新确认一次。
    if (await this.shouldStopReply()) {
      await this.stopReply();
      return;
    }

    let welcomedAt = await this.state.storage.get("welcomedAt");
    const legacyWelcomed = (await this.state.storage.get("welcomed")) === true;

    // 旧版本只有永久布尔标记；升级后从当前时间开始计算十二小时冷却。
    if (!Number.isFinite(welcomedAt) && legacyWelcomed) {
      welcomedAt = Date.now();
      await this.state.storage.put("welcomedAt", welcomedAt);
      await this.state.storage.delete("welcomed");
    }

    const welcomeCooling =
      Number.isFinite(welcomedAt) &&
      Date.now() - welcomedAt < CONFIG.WELCOME_COOLDOWN_MS;

    if (!welcomeCooling && processing.isAiSuccess && !processing.welcomeSent) {
      const firstMsg = latest.welcomeText || getRandomOpening();
      await safeSendTG(
        this.env.TG_BOT_TOKEN,
        latest.businessConnId,
        chatId,
        `　⁠【${CONFIG.botPrefix}】\n${firstMsg}`,
        latest.msgId
      );

      processing.welcomeSent = true;
      await this.state.storage.put({ welcomedAt: Date.now(), processing });
    }

    // 欢迎语发送后也允许管理员立即接管，避免继续补发模型正文。
    if (await this.shouldStopReply()) {
      await this.stopReply();
      return;
    }

    if (!processing.replySent) {
      await safeSendTG(
        this.env.TG_BOT_TOKEN,
        latest.businessConnId,
        chatId,
        processing.reply,
        latest.msgId
      );
      processing.replySent = true;
      await this.state.storage.put("processing", processing);
    }

    // 即使模型失败，也保存客户消息和已发送的断线提示，避免聊天记录出现缺口。
    history = trimHistory([...userHistory, { role: "assistant", content: processing.reply }]);
    await KV.put(`chat_${chatId}`, JSON.stringify(history), {
      expirationTtl: CONFIG.HISTORY_TTL
    });

    // 所有外部发送和历史保存成功后才删除批次，保留 Alarm 自动重试能力。
    await this.state.storage.delete("processing");

    // alarm 执行期间如果来了新消息，确保后续批次仍有闹钟可触发。
    const nextPending = await this.state.storage.get("pending");
    if (nextPending?.items?.length) {
      await this.state.storage.setAlarm(nextPending.alarmAt);
    }
  }
}
