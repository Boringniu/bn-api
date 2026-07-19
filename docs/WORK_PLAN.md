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

## 阶段三：审核后台 API（已完成 2026-07-19）

已实现并线上验证：`GET /v1/review`（按 status/type/role 过滤分页）、
`POST /v1/review/:id/action`（七个动作全通）。角色鉴权用两个独立
Bearer secret（REVIEW_TOKEN_EDITOR / REVIEW_TOKEN_ADMIN，值在本地
`.dev.vars`），角色由 token 决定、不信客户端声明；editor 审 admin 级
返回 403，重复审核返回 409。approve/merge/deprecate/edit/link_existing
生成 `config_proposal`（标记 requires_pull_request，注明目标配置文件和
建议改动）存入 resolution_json，由人工提 PR 落地，符合标准 §十五。
遗留：受影响 media 的重新标准化标记（并入阶段五的重索引）。

## 阶段四：Telegram Bot 与频道（已完成 2026-07-19）

Bot：@MMCOOBOT（沿用原 Bot，旧 file_id 保持可用）。频道：`-1004460339207`
（新建）。管理员：`8351469516`。

已实现并上线：
- `POST /telegram/webhook`（Telegram secret header 校验）：Bot 收到任意
  文本即走 search_order 解析并回复；/start /help 有引导；每次查询写入
  search_logs（含解析类型与命中目标，为热词分析积累数据）。
- `POST /v1/channel/publish/:id`（ingest token 鉴权）：按 display.json
  模板渲染频道索引消息（仅分类/演员/类型三块、hashtag 替换规则、
  上限截断、空块隐藏），message_id 记入 channel_posts；再次发布自动
  editMessageText，"内容未变"响应按成功处理。
- 迁移 0003：channel_posts、search_logs、media_files。
- 旧库 32 条有标题记录经 /v1/media 重新入库（22 approved + 10 进审核，
  即 pending_actor 等待确认），file_id 全部存入 media_files；40 条
  "未命名视频"按约定放弃（导出 SQL 备份仍在 .backup/）。
- 23 条 approved 内容已全部发布到新频道并可搜索验证。

遗留：Bot 发视频文件（用 media_files 的 file_id 响应搜索结果）、
/page 翻页命令的会话状态——可并入阶段五后打磨。

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
