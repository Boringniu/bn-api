# 工作计划（2026-07-19 起）

本文档列出项目从当前状态到上线的剩余工作。已完成部分见 [progress-2026-07-19.md](progress-2026-07-19.md) 和 [CHANGELOG.md](CHANGELOG.md)，不再重复。

## 当前状态摘要

- 配置中心（config/ + schema/ + 校验脚本 + CI）已达到标准 v1.0 要求，配置发布 1.2.0。
- 运行时已实现：文本/番号标准化、标签与演员归一化、分类判定、媒体入库服务。
- `bn-api` Worker 已实现 `GET /health` 和 `POST /v1/media`（Bearer Token 鉴权），本地 dry-run 构建通过。
- D1 表结构已就绪（media、分类候选、演员关联、标签关联、review_items、ingest_events、database_metadata），迁移仅在本地应用过。
- 本地 main 领先 origin/main 4 个提交，尚未推送。

## 阶段一：Cloudflare 部署（已完成 2026-07-19）

已全部执行：`bn-media` D1 创建并迁移、`INGEST_TOKEN` 设置、Worker 部署在
https://bn-api.niu900326.workers.dev ，冒烟验证通过。旧库 `bn2`（空）与
`boringniu-media` 已删除；后者删除前发现含 90 条旧 Telegram 视频记录
（file_id / message_id），已整库导出到
`.backup/boringniu-media-export-20260719.sql`，阶段四做 Bot 时可评估是否
回灌。

## 阶段二：查询与搜索 API（已完成 2026-07-19）

已实现并线上验证：`GET /v1/search`（q 智能解析走完整 search_order 链 +
组合筛选 ≤5 + 分页/200 上限）、`GET /v1/media/:id`、`GET /v1/codes`。
公开结果仅 approved；忽略词返回空；模糊匹配 Levenshtein ≤2。
遗留优化：演员/标签按名称的 D1 级搜索索引（当前走内存字典已够用）。

## 阶段三：审核后台 API

review_items 表已有数据流入口，缺处理出口：

1. `GET /v1/review` — 按 status、type、required_reviewer_role 过滤的队列列表。
2. `POST /v1/review/:id/action` — 实现 review_rules.json 的七个动作（approve/reject/ignore/merge/deprecate/edit/link_existing）。
3. 鉴权：区分 editor 与 admin 角色（review_rules 中 pending_category 仅 admin）。
4. approve/merge 的产物是"待回写 GitHub 的配置变更建议"，不直接改配置——生成结构化 diff 或 PR 草稿内容，由人工提交 PR，符合标准 §十五。
5. 审核完成后触发受影响 media 的重新标准化标记（存 rule_version 对比即可，重索引可延后）。

## 阶段四：Telegram Bot 与频道

1. Bot Webhook Worker（或并入 bn-api）：接收查询，按阶段二的搜索 API 返回结果，遵守 display.json 的 bot_result 规则（page_size 10、显示番号、来源链接仅授权用户）。
2. 频道索引发布：按 display.json 的 channel_index 模板生成消息（只展示分类/演员/类型三块，hashtag 规则替换分隔符），记录 Telegram Message ID 到 D1。
3. 内容更新时的频道消息编辑/重发策略。
4. 搜索日志写入 D1（为后续热词分析和 alias 候选做数据积累）。

依赖：阶段二。需要新增：Bot Token secret、频道 ID 配置、Telegram 相关表迁移（message_id 映射，标准 §十八已声明归 D1）。

## 阶段五：配置热更新与重索引

当前 Worker 在构建时打包 config（import ... with type json），配置变更需重新部署：

1. 决策：保持"合并 main 后 CI 自动重新部署 Worker"（简单，推荐先行）或实现"Worker 定时拉取 GitHub 配置 + 缓存"（标准 §十七的完整形态：5–15 分钟缓存、拉取失败用最后成功版本、首次失败停止标准化只存原始数据）。
2. 每条处理结果已存 ruleset_version；实现按版本差异筛选受影响 media 的批量重新标准化任务（可用 Workers Cron Trigger）。
3. 重索引完成后刷新频道消息。

## 第二阶段可延后项（标准 §十九）

- alias.json 的复杂纠错规则与 regex Alias 实战条目
- 审核建议自动生成 PR
- 多管理员审批流
- 搜索热词分析
- 配置变更自动触发批量重索引的全自动化

## 风险与依赖备忘

- Wrangler OAuth 凭据在 /tmp，环境重启即失效，阶段一开始时大概率要重新登录。
- 仓库标准要求 PR 合并、禁止直推 main；本地 4 个提交推送时若遇分支保护需改走 PR。
- 演员字典仅 27 人，真实数据入库后 pending_actor 会大量堆积，阶段三的审核效率直接决定内容可见速度。
- D1 免费额度与 Telegram API 速率限制在阶段四前需确认。
