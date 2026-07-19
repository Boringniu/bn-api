# 配置指南（CONFIG_GUIDE）

本文档说明 `config/` 下各文件的用途、通用字段和修改流程。完整规范见 [architecture.md](architecture.md)。

## 通用字段

每个配置文件必须包含以下顶层字段：

| 字段 | 说明 |
| --- | --- |
| `schema_version` | 配置结构版本，结构变化时升级，目前固定为 `"1.0"` |
| `config_version` | 当前文件版本，语义化版本 `x.y.z`，内容变化必须升级 |
| `updated_at` | UTC ISO 8601 时间，必须以 `Z` 结尾 |
| `updated_by` | 修改人 GitHub 用户名或管理员标识 |
| `items` | 配置内容列表；无列表语义的文件保持空数组 |

## 文件一览

| 文件 | 用途 |
| --- | --- |
| `version.json` | 仓库版本、兼容性下限、各文件版本声明 |
| `category.json` | 固定五个一级分类（日本、欧美、国产、自拍、AI短剧）及识别规则 |
| `tag_dictionary.json` | 标准标签、别名、展示与搜索开关、权重 |
| `actor_dictionary.json` | 演员标准名（中文简体展示名）、多语言名与别名 |
| `alias.json` | 全局搜索兼容层：错别字、旧称、缩写、番号格式变体 |
| `ignored.json` | 忽略词：清晰度、文件格式、无检索价值的泛化词 |
| `display.json` | 频道索引与 Bot 结果的展示字段、数量与模板 |
| `search.json` | 搜索优先级、分页、模糊匹配、番号标准化 |
| `review_rules.json` | 待审核项生成条件、置信度阈值、审核动作 |

## 修改流程

1. 从 `main` 创建分支，修改 `config/*.json`。
2. 内容变化的文件必须升级其 `config_version`，并同步更新 `version.json` 的 `files` 声明与 `config_version`。
3. 更新 `updated_at`（UTC）与 `updated_by`。
4. 本地运行 `npm run check`，确保全部通过。
5. 提交 Pull Request，CI（`.github/workflows/validate-config.yml`）必须通过后才能合并。
6. 禁止直接推送 `main`；禁止 AI 绕过审核直接写入。

## 版本升级规则

```text
1.0.1  修复词条、增加 Alias、修正描述
1.1.0  增加新字段或新规则，保持兼容
2.0.0  配置结构发生不兼容变更（同时升级 schema_version）
```

## 格式要求

- 所有 JSON 使用 2 空格缩进、末尾换行的规范格式（`JSON.stringify(data, null, 2)` 输出）；CI 会拒绝非规范格式。
- `normalized_*` 字段必须与 `src/value-normalizer.mjs` 的标准化结果一致：NFKC 归一化、分隔符（`-`、`_`、`.`、`/`）统一为空格、压缩空白、英文转小写。`match_mode: regex` 的条目除外。
- 同一个标准化别名禁止指向多个目标对象；冲突时 CI 直接失败。
