# Boringniuniu Media Config

Boringniuniu 影视库的规则配置与目录服务仓库。分类、标签、演员名称、别名、忽略词、展示格式、搜索参数和审核策略均在此维护；Worker、Bot 和管理端以通过校验的配置为基础处理媒体事实与检索结果。

## 架构边界

本项目遵循 [GitHub 配置标准 v1.0](docs/architecture.md)：

- GitHub 是影视库的规则中心，规则变化通过 Pull Request 和校验流程进入主分支。
- D1 保存内容事实、归一化结果、关系记录和审核记录，不作为独立规则来源。
- Worker 与 Bot 使用已批准的词典项匹配演员、标签和别名；无法匹配的频道话题会保留为自由话题，不会自动写入规则词典。
- AI 只能为审核项提供建议，不能直接创建、批准或修改 Git 中的规则。

配套文档：[配置指南](docs/CONFIG_GUIDE.md) · [审核指南](docs/REVIEW_GUIDE.md) · [命名指南](docs/NAMING_GUIDE.md) · [变更日志](docs/CHANGELOG.md)

## 目录

| 路径 | 作用 |
| --- | --- |
| `config/` | 实际生效的 JSON 配置 |
| `schema/` | 与配置文件一一对应的 JSON Schema |
| `contracts/` | 下游运行时结果的 JSON Schema |
| `migrations/` | D1 内容事实、关联结果和审核队列表结构 |
| `src/` | 配置驱动的运行时规则实现 |
| `scripts/` | 配置校验、版本检查、规则执行和 manifest 构建 |
| `test/` | 运行时规则、输出契约和工具脚本测试 |
| `wrangler.jsonc` | `bn-api` Worker 和 D1 binding 配置 |
| `dist/config-manifest.json` | `npm run build:manifest` 生成的消费清单，不提交 Git |

## 本地检查

需要 Node.js 22 或更高版本。

```bash
npm ci
npm run check
```

`npm run check` 是本地与 CI 共用的唯一完整检查入口，依次执行：

1. `npm run validate`：校验 JSON Schema、ID 唯一性、规范化值、版本字段一致性、跨配置上限、正则表达式、固定五分类、演员中文名唯一性、regex Alias 测试样例和 JSON 规范格式。
2. `npm run check:aliases`：检查别名重复、一个别名指向多个目标、忽略词冲突和全局别名目标引用。
3. `npm run check:versions`：当 `origin/main` 可用且 `config/` 有变化时，要求 `config/version.json` 的发布版本严格高于基准版本；在无 Git 基准的本地浅克隆中会明确跳过。
4. `npm test`：验证文本标准化、标签、演员和编号归一化，以及媒体入库、搜索、审核、Telegram 与 Worker 接口行为。
5. `npm run build:manifest`：生成包含版本、文件大小和 SHA-256 的 `dist/config-manifest.json`。
6. `npm run build:worker`：执行 Wrangler dry-run，确认 Worker 可以打包并识别 D1 binding。

## 标签规范化

标签规范化器会以状态为 `approved` 的分类、标签和全局别名作为匹配来源。已命中的词典项按其展示与搜索开关输出；未命中或存在并列最高匹配的原始标签会保留为稳定的自由话题（`tag_topic_<fingerprint>`），以便展示和搜索，但不会自动写入标签词典，也不会仅因此创建审核项。

当前运行时不自动选定一级分类，`selected_category` 与 `category_candidates` 字段仅保留给既有数据和接口兼容。未知演员或歧义演员别名仍会进入审核队列，具体见 [审核指南](docs/REVIEW_GUIDE.md)。

命令行参数会被逐项视为原始标签：

```bash
npm run normalize:tags -- 日本成人 CHS 电影 未知流派
```

也可以从标准输入传入 JSON 数组或带有 `raw_tags` 的对象：

```bash
printf '%s\n' '{"raw_tags":["日本成人","CHS","电影"]}' | npm run normalize:tags
```

结果包含标准标签、展示标签、逐输入决策和规则违规；兼容字段中的分类候选、忽略项和审核项在当前标签路径中保持为空。完整结构由 `contracts/tag-normalization-result.schema.json` 定义。

## 修改规则

1. 未知标签保留为自由话题，不自动写入规则词典；未知演员或歧义演员别名进入审核队列，不允许 AI 自动批准。
2. 修改任何 `config/*.json` 后，同步提升 `config/version.json` 的 `config_version` 与 `release.version`，并更新发布日期和变更说明。
3. 新增或修改配置字段时，同时更新对应 Schema 和相关文档。
4. `normalized_value` 与 `normalized_aliases` 使用 NFKC、分隔符（`-`、`_`、`.`、`/`）统一为空格、去除首尾空白、合并连续空白并转小写后的结果。
5. 提交前只需运行 `npm run check`；CI 也只调用同一命令。

## 配置说明

| 文件 | 内容 |
| --- | --- |
| `version.json` | 仓库发布版本、日期和变更说明，是规则版本的权威来源 |
| `category.json` | 固定一级分类及其别名；当前主要用于兼容和查询，不自动选定新记录分类 |
| `tag_dictionary.json` | 可展示、可搜索的标准标签字典 |
| `actor_dictionary.json` | 演员标准中文名和多语言别名 |
| `alias.json` | 跨来源全局别名及目标映射 |
| `ignored.json` | 不进入特定处理范围的噪声词 |
| `display.json` | 频道索引、Bot 结果和 hashtag 展示规则 |
| `search.json` | 公开搜索顺序、模糊匹配、编号归一化和分页参数 |
| `review_rules.json` | 运行时审核类型、角色与操作策略 |

下游应先读取 manifest，对文件 SHA-256 校验通过后再加载配置。`config/version.json` 是规则版本判断的权威来源。

## Worker 与 D1

Worker 提供以下基础接口：

- `GET /health`：服务与规则版本检查。
- `GET /v1/search`：只读公开搜索，仅返回 `approved` 媒体记录。
- `POST /v1/media`：受 `INGEST_TOKEN` 保护的幂等媒体入库接口。
- `GET` / `POST /v1/review...`：受审核令牌保护的审核队列与操作接口。
- `POST /telegram/webhook`：受 Telegram Webhook 密钥保护的更新入口。

首次部署前：

1. 运行 `npm run db:create` 创建 `bn-media` D1 数据库。
2. 将返回的数据库 ID 写入 `wrangler.jsonc` 的 `database_id`。
3. 运行 `npm run db:migrate:remote` 应用迁移。
4. 运行 `npx wrangler secret put INGEST_TOKEN` 配置入库密钥。
5. 运行 `npm run deploy` 部署 `bn-api`。

本地开发使用 `npm run db:migrate:local` 和 `npm run dev`。本地密钥写入不提交 Git 的 `.dev.vars`：

```dotenv
INGEST_TOKEN=replace-with-a-random-secret
```

Worker 工具链使用 Wrangler 4，要求 Node.js 22 或更高版本。

入库请求示例：

```json
{
  "source": {
    "provider": "example",
    "external_id": "video-001",
    "url": "https://example.com/video-001"
  },
  "title": "样例影片",
  "code": "ABP 123",
  "release_date": "2026-07-19",
  "actors": ["希島愛理"],
  "raw_tags": ["日本成人", "NTR", "CHS"],
  "metadata": {
    "source_channel": "example"
  }
}
```
