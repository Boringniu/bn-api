# 审核指南

本文档面向负责规则审核的管理员，说明当前 Worker 会写入 D1 的审核项、可执行操作和规则落地边界。审核类型定义见 `config/review_rules.json`。

## 当前审核项来源

Worker 不会因为未知标签而生成审核项。标签路径会把未知或并列匹配的原始标签保留为自由话题；它们不会自动写入标签词典。当前实际会在入库路径生成的审核项如下：

| 类型 | 触发条件 | 审核角色 |
| --- | --- | --- |
| `pending_actor` | 演员名称不在已批准演员词典或其别名中 | editor |
| `pending_alias` | 一个演员输入匹配到多个不同的已批准演员 | editor |
| `possible_code` | 输入看起来像编号但不符合当前编号规范 | editor |
| `rule_violation` | 演员或标签数量超过配置上限 | editor |

`pending_tag`、`pending_category` 和 `possible_duplicate` 仍可作为配置中的兼容审核类型存在，但当前标签归一化器不会因未知标签或分类不确定性创建它们。当前运行时也不自动选定一级分类。

AI 可以在允许的审核项上提供建议（`allow_ai_suggestion: true`），但不能自动批准；所有已启用审核类型的 `allow_auto_approve` 均为 `false`。

## 审核动作

| 动作 | 记录结果 |
| --- | --- |
| `approve` | 审核项标记为 `approved`，必要时生成配置变更建议 |
| `reject` | 审核项保留并标记为 `rejected` |
| `ignore` | 审核项标记为 `ignored`，可作为后续维护忽略规则的依据 |
| `merge` | 审核项标记为 `merged`，必须指定既有目标对象 |
| `deprecate` | 审核项标记为 `approved`，建议弃用旧规则 |
| `edit` | 审核项标记为 `approved`，保存人工修订值 |
| `link_existing` | 审核项标记为 `merged`，必须关联既有目标对象 |

审核接口只会把操作、审核人角色、备注、目标和 `config_proposal` 写入 D1。它不会直接修改 `config/`、创建 Git 提交或部署 Worker。

## 批准后的落地流程

1. 管理员在审核队列中确认演员、别名或编号规则的处理方式。
2. 系统生成的 `config_proposal` 指明建议修改的配置文件和变更方向；它只是交接信息，不是自动写入。
3. 管理员在 Git 分支中修改对应 JSON、Schema 和文档；若改动 `config/`，同时提升 `config/version.json` 的仓库发布版本。
4. 运行 `npm run check`，再提交 Pull Request。
5. CI 通过后合并；后续目录重新索引和频道索引刷新由受保护的运维入口执行。

任何歧义、缺失审核项或校验错误都会中止规则变更，不会直接修改生产规则。

## 审核注意事项

- 演员：不确定的名称保留原文，不得凭空翻译；中文简体标准名必须人工确认后才能进入 `approved`。
- 标签：未知标签会作为自由话题保留。如需将其升格为标准标签、并入既有别名或加入忽略词，应通过 Git Pull Request 修改规则，而不是依赖审核 API 自动写入。
- 分类：日本、欧美、国产、自拍、AI短剧作为固定词典项保留；当前标签路径不自动给新记录归类。
- Alias：`contains` 和 `regex` 必须写明 `notes`；`regex` 必须附带 `test_cases`，CI 会实际执行。
