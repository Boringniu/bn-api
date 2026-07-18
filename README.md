# Boringniuniu Media Config

Boringniuniu 影视库的唯一规则配置中心。分类、标签、演员名称、别名、忽略词、展示格式、搜索参数和审核策略都在此仓库维护，下游 worker、bot 和管理端只消费已通过校验的配置。

## 目录

| 路径 | 作用 |
| --- | --- |
| `config/` | 实际生效的 JSON 配置 |
| `schema/` | 与配置文件一一对应的 JSON Schema |
| `contracts/` | 下游运行时结果的 JSON Schema |
| `src/` | 配置驱动的运行时规则实现 |
| `scripts/` | 结构校验、规则执行和 manifest 构建 |
| `test/` | 运行时规则和输出契约测试 |
| `dist/config-manifest.json` | `npm run build:manifest` 生成的消费清单，不提交 Git |

## 本地检查

需要 Node.js 20 或更高版本。

```bash
npm ci
npm run check
```

`npm run check` 依次执行：

1. `npm run validate`：校验 JSON Schema、ID 唯一性、规范化值、版本声明、跨配置上限和正则表达式。
2. `npm run check:aliases`：检查别名重复、一个别名指向多个目标、忽略词冲突和全局别名目标引用。
3. `npm test`：验证标签规范化行为及其输出契约。
4. `npm run build:manifest`：生成包含版本、文件大小和 SHA-256 的 `dist/config-manifest.json`。

## 标签规范化

标签规范化器只使用状态为 `approved` 的分类、标签、全局别名和忽略词。未知标签和无法确定的分类进入 `review_rules.json` 定义的审核流程，不会自动创建字典项。

命令行参数会被逐项视为原始标签：

```bash
npm run normalize:tags -- 日本成人 CHS 电影 未知流派
```

也可以从标准输入传入 JSON 数组或带有 `raw_tags` 的对象：

```bash
printf '%s\n' '{"raw_tags":["日本成人","CHS","电影"]}' | npm run normalize:tags
```

结果包含选定分类、全部分类候选、标准标签、展示标签、忽略项、审核项、逐输入决策和规则违规。完整结构由 `contracts/tag-normalization-result.schema.json` 定义。

## 修改规则

1. 未知标签、演员、别名或分类进入审核队列，不允许 AI 自动创建或自动批准。
2. 修改配置时同步更新该文件的 `config_version`、`updated_at` 和 `updated_by`。
3. 同步更新 `config/version.json` 的发布版本、日期和 `files` 中对应版本。
4. `normalized_value` 和 `normalized_aliases` 使用 NFKC、去除首尾空白、合并连续空白并转小写后的结果。
5. 新增或修改字段时，必须同时更新同名 Schema。
6. 提交前运行 `npm run check`；主分支合并由 CI 结果保护。

## 配置说明

| 文件 | 内容 |
| --- | --- |
| `version.json` | 发布版本、下游最低兼容版本和各配置版本 |
| `category.json` | 固定一级分类及分类决策规则 |
| `tag_dictionary.json` | 可展示、可搜索的标准标签字典 |
| `actor_dictionary.json` | 演员标准中文名和多语言别名 |
| `alias.json` | 跨来源全局别名及目标映射 |
| `ignored.json` | 不进入公开索引或搜索的噪声词 |
| `display.json` | 频道索引、bot 结果和 hashtag 展示规则 |
| `search.json` | 搜索顺序、模糊匹配、番号归一化和访问控制 |
| `review_rules.json` | 待审核类型、阈值、操作和 GitHub 同步策略 |

下游应先读取 manifest，对文件 SHA-256 校验通过后再加载配置。`config/version.json` 是兼容性判断的权威来源。
