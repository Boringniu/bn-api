# 配置指南

本文档说明 `config/` 下各文件的用途、当前通用字段和修改流程。完整职责边界见 [architecture.md](architecture.md)。

## 通用字段

所有配置文件均使用以下基础字段：

| 字段 | 说明 |
| --- | --- |
| `schema_version` | 配置结构版本；当前仓库要求所有配置文件保持相同值，结构不兼容变化时统一升级 |
| `updated_at` | UTC ISO 8601 更新时间，必须以 `Z` 结尾 |
| `updated_by` | 修改人 GitHub 用户名或管理员标识 |
| `items` | 配置内容列表；无列表语义的文件保持空数组 |

仓库使用**单一发布版本**：`config/version.json` 的 `config_version` 与 `release.version` 必须相等。各配置文件不再维护独立 `config_version`，也不存在 `version.json.files` 清单。

## 文件一览

| 文件 | 用途 |
| --- | --- |
| `version.json` | 仓库发布版本、日期和变更说明 |
| `category.json` | 固定五个一级分类及别名；当前运行时保留兼容与查询用途，不自动确定新记录分类 |
| `tag_dictionary.json` | 标准标签、别名、展示与搜索开关、权重 |
| `actor_dictionary.json` | 演员标准名（中文简体展示名）、多语言名与别名 |
| `alias.json` | 跨来源搜索兼容层：错别字、旧称、缩写、编号格式变体 |
| `ignored.json` | 忽略词：清晰度、文件格式、无检索价值的泛化词及其作用范围 |
| `display.json` | 频道索引与 Bot 结果的展示字段、数量与模板 |
| `search.json` | 公开搜索优先级、分页、模糊匹配与编号标准化 |
| `review_rules.json` | 运行时审核项的类型、角色和动作 |

## 修改流程

1. 从 `main` 创建分支，修改 `config/*.json`、Schema 或相关运行时规则。
2. 只要 `config/` 内容发生变化，就同步提升 `config/version.json` 的 `config_version` 与 `release.version`，更新 `release_date` 和 `description`。
3. 更新受影响配置的 `updated_at`（UTC）与 `updated_by`。
4. 新字段必须有相应 Schema 支持；删除或改变字段语义时，检查下游 Worker 与契约。
5. 本地运行唯一完整检查命令 `npm run check`。
6. 提交 Pull Request；CI 也只执行 `npm run check`。当 CI 可取得 `origin/main` 且配置发生变化时，版本必须比基准严格提升。
7. 禁止直接推送 `main`；审核 API 只产生配置变更建议，最终规则仍由 Pull Request 合并。

## 版本升级规则

```text
1.0.1  修复词条、增加 Alias、修正展示或搜索规则
1.1.0  增加新字段或新规则，且保持兼容
2.0.0  配置结构发生不兼容变更，同时升级 schema_version
```

版本单调性脚本只比较数字形式的 `x.y.z` 发布版本。配置未改变时会通过；在没有 `origin/main` 的本地浅克隆或离线目录中会明确提示跳过，避免把缺少 Git 基准误判为配置错误。

## 标签与审核规则

标签路径会匹配已批准的标签、分类别名和全局别名。未知或并列匹配的原始标签会保留为稳定自由话题，不自动创建标签词典项，也不因标签未知而生成审核项。未知演员和歧义演员别名仍会按 `review_rules.json` 创建审核项，详细处理见 [审核指南](REVIEW_GUIDE.md)。

## 格式要求

- 所有 JSON 使用 2 空格缩进、末尾换行的规范格式（`JSON.stringify(data, null, 2)` 输出）；CI 会拒绝非规范格式。
- `normalized_*` 字段必须与 `src/value-normalizer.mjs` 的标准化结果一致：NFKC 归一化、分隔符（`-`、`_`、`.`、`/`）统一为空格、压缩空白、英文转小写。`match_mode: regex` 的条目除外。
- 同一个标准化别名禁止指向多个目标对象；冲突时 CI 直接失败。
