# 工作计划（更新于 2026-07-19 晚）

本文档是项目的进度与剩余工作计划书。变更历史见 [CHANGELOG.md](CHANGELOG.md)，
部署事实见 [progress-2026-07-19.md](progress-2026-07-19.md)。

## 一、当前进度总览

| 阶段 | 状态 |
| --- | --- |
| 一：Cloudflare 部署（D1 + Worker） | ✅ 完成 |
| 二：查询与搜索 API | ✅ 完成 |
| 三：审核后台 API | ✅ 完成 |
| 四：Telegram Bot 与频道（频道优先流程） | ✅ 完成 |
| 五：配置热更新与重索引 | ⬜ 未开始 |
| 六：审核落地与字典扩充（新增） | ⬜ 待用户决策 |

生产环境：
- Worker：https://bn-api.niu900326.workers.dev（版本随 main 部署）
- D1：`bn-media`（4 个迁移全部应用）
- Bot：@MMCOOBOT；频道：`-1004460339207`；管理员：`8351469516`
- 配置发布 1.2.0；测试 78 个全绿；CI（validate-config.yml）齐备

## 二、已完成能力清单

**规则中心（标准 v1.0 达标）**
- config/ 9 文件 + schema 一一对应；CI 校验 18 项（固定五分类、
  演员中文名唯一、regex 测试样例实际执行、版本单调性、规范格式等）
- 文档：CONFIG_GUIDE / REVIEW_GUIDE / NAMING_GUIDE / CHANGELOG

**Worker API**
- `POST /v1/media` 标准化入库（番号/分类/演员/标签/忽略词/审核项）
- `GET /v1/search`、`GET /v1/media/:id`、`GET /v1/codes`
- `GET /v1/review`、`POST /v1/review/:id/action`（七动作、双角色令牌）
- `POST /telegram/webhook`、`POST /v1/channel/index`（置顶索引刷新）、
  `POST /v1/channel/reconcile`（对账）、`POST /v1/channel/publish/:id`

**频道优先流程（今日重构后的最终形态）**
- 用户向频道转发视频 → Bot 自动入库：标题第一行取番号（严格正则，
  杜绝 Join_file_/Pu229 类误识）、#话题 进标签、名字样词进演员
  （字典命中或含假名），正文进简介
- 频道默认标签 `TELEGRAM_CHANNEL_DEFAULT_TAGS=日本`（频道主声明）
- 置顶索引实时刷新，超长自动分页（第一页置顶，续页带"（续）"）
- **视频消息本体不动**（用户要求）：转发消息 Telegram 禁止编辑，
  hashtag 无法写入视频消息；复制替换能力保留在
  `TELEGRAM_REPLACE_FORWARDS=1` 开关后，默认关闭
- 对账：`reconcile` 探测频道已删消息并清理数据（`keep_media=1` 仅
  断开映射）；单条发布遇消息已删自动重发
- webhook 永不 500（单条坏消息不再阻塞队列——今日实际发生过，
  153 条积压，已修复并排空）
- 数据库曾被误清一次，已用 D1 Time Travel 完整恢复，零丢失

**频道当前数据**
- 71 条视频入库：52 approved（含 hashtag 说明文字）+ 19 pending
- 置顶索引：#日本 (52)，演员 #叶山小百合 #橘玛丽
- 44 条待审核项（清单见第三节）

## 三、未完成事项与计划

### 阶段六（新增，下一步）：审核落地与字典扩充

**为什么优先**：19 条 pending 视频和 44 条审核项等着；字典越全，
以后转发的自动识别率越高。

**需要用户决策的清单**：

待确认演员（8 个真名 + 1 个噪声）：
波多野結衣（繁体，建议加为现有"波多野结衣"的别名）、藤かんな、
森沢かな（建议并入现有"森泽佳奈"）、白雪美月、流川莉央、枫花恋、
天音たお、七海ティナ；"分鍾"直接拒绝。

待确认标签（约 25 个）：
真标签候选：中出、乳交、强奸、勒索、嫂子诱惑、黑丝OL、熟女、
乱伦、姐姐、体检、白发女人等；
应作别名的：无码中字→中文字幕；
实为演员被打成标签的：希島あいり、星宮一花、古川伊織、白峰美羽、
葉山さゆり、波多野结衣、枫可怜、叶山小百合♀；
噪声：达♂、戲劇、單體作品、病毒 等建议拒绝或忽略。

**执行步骤**（用户给出取舍后，约半天）：
1. 按决策修改 config（演员/别名/标签/忽略词），版本升 1.3.0，CI 过
2. 重放 19 条 pending（原始数据都在库里，不需要重新转发）
3. 刷新置顶索引；审核队列清零

### 阶段五：配置热更新与重索引

1. GitHub Actions 自动部署：合并 main → 自动 `wrangler deploy`
   （需要用户在 GitHub 仓库 Settings→Secrets 添加 CLOUDFLARE_API_TOKEN）
2. 重索引：按 ruleset_version 差异筛选受影响 media，批量重新标准化
   （Workers Cron Trigger），完成后刷新置顶索引
3. 这是"审核通过的规则自动生效"的最后一环，与阶段六配套

### 打磨项（可穿插）

- Bot 搜索结果直接发视频文件（file_id 已全部在 media_files）
- Bot `/page` 翻页
- 未识别（pending）视频在审核通过后自动补 hashtag 的策略
  （受"不动转发消息"限制，需与用户确认交互方式）
- 搜索热词分析（search_logs 已在积累数据）

## 四、待用户决策/提供

1. **阶段六的字典取舍**（上面清单，逐个说"收/别名/忽略"即可）
2. **阶段五**：往 GitHub 仓库 Secrets 放一个 Cloudflare API Token
   （我提供步骤），或选择继续手动部署
3. **置顶索引跳转取舍**：不动视频 = 索引 hashtag 点击搜不到转发的
   视频（Telegram 限制）；要跳转需开 `TELEGRAM_REPLACE_FORWARDS=1`
4. 项目收尾时：Roll/删除 Cloudflare API Token（曾在聊天中出现）

## 五、风险备忘

- Wrangler 凭据用 `.dev.vars.deploy`（gitignore 内），环境重启不丢，
  但 Codespace 删除会丢——已提醒项目结束时废除 token
- 演员字典 30+ 人，扩充节奏决定自动识别率
- Telegram 速率限制：批量频道操作需 3 秒/条节流（脚本已内置）
- D1 Time Travel 保留 30 天，是最后的数据兜底
