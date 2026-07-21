# 审核指南（REVIEW_GUIDE）

本文档面向负责规则审核的管理员，说明审核队列的来源、审核动作和处理结果。规则定义见 `config/review_rules.json`。

## 审核项来源

Worker 在入库时遇到以下情况会写入 D1 的审核队列（`review_items`）：

| 类型 | 触发条件 | 审核角色 |
| --- | --- | --- |
| `pending_tag` | 原始标签不在标签字典 | editor |
| `pending_actor` | 演员名称不在演员字典 | editor |
| `pending_alias` | 检测到疑似别名候选 | editor |
| `pending_category` | 无法归入固定一级分类 | admin |
| `possible_duplicate` | 疑似重复视频或同番号多版本 | editor |
| `possible_code` | 疑似番号但无法确认格式 | editor |

AI 只能在审核项上附加建议（`allow_ai_suggestion: true`），一律不得自动批准（`allow_auto_approve: false`）。

## 审核动作

| 动作 | 结果 |
| --- | --- |
| `approve` | 写入对应字典，状态为 `approved` |
| `reject` | 保留审核记录，标记为 `rejected` |
| `ignore` | 写入 `ignored.json` 或标记为忽略 |
| `merge` | 合并至既有标签、演员或别名 |
| `deprecate` | 旧规则保留，但不再用于新数据 |
| `edit` | 管理员修改后再提交 |
| `link_existing` | 将待审核项关联至已有标准对象 |

## 批准后的落地流程

管理员只编辑根目录 `review-decisions.json`：

```json
[
  ["新话题", "1"],
  ["同义词", "1", "标准话题"],
  ["应忽略词", "2"]
]
```

`1` 表示通过，`2` 表示否定；第三列只用于明确同义词目标。提交到
`main` 后，GitHub Actions 自动：

1. 从生产审核队列确认 `#话题` 应放在演员位、分类位还是题材位。
2. 修改对应配置并自动提升补丁版本。
3. 运行全套配置校验和测试。
4. 提交生成后的配置并部署 Worker。
5. 分批重新标准化旧数据，最后刷新频道置顶索引。

任何歧义、缺失审核项或校验错误都会中止流程，不会直接修改生产环境。

## 审核注意事项

- 演员：不确定的名称保留原文，不得凭空翻译；中文简体标准名必须人工确认后才能进入 `approved`。
- 标签：先判断是否应归并为既有标签的别名（例如 `OL` 归入 `办公室`），而不是新建标签；元数据类信息（清晰度、格式）进入 `ignored.json`。
- 分类位：日本、欧美、国产、自拍、AI短剧在 Telegram 中同样是 `#话题`，
  这里只定义它们在置顶索引中的排列位置。
- Alias：`contains` 和 `regex` 必须写明 `notes`；`regex` 必须附带 `test_cases`，CI 会实际执行。
