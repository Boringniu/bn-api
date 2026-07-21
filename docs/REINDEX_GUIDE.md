# 视频重索引执行指南（v1.3.0）

> **触发条件**：配置版本升级（演员/标签/忽略词变更）  
> **目的**：使用新规则重新标准化已入库的 media 数据  
> **当前目标**：19 条 pending 视频 → approved + 刷新置顶索引

---

## 快速开始

### 方案 A：通过 API 手动重放（推荐快速测试）

```bash
# 1. 查询待审核队列
curl -X GET "https://bn-api.niu900326.workers.dev/v1/review?status=pending" \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -H "Content-Type: application/json" | jq

# 2. 从输出中提取 media_id 列表
# 例如：["MID-001", "MID-002", ..., "MID-019"]

# 3. 逐条调用 reindex + 审核通过
for media_id in MID-001 MID-002 ...; do
  # 3a. 触发重索引（重新标准化）
  curl -X POST "https://bn-api.niu900326.workers.dev/v1/media/$media_id/reindex" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"ruleset_version":"1.3.0"}'
  
  # 3b. 审核通过（该 media 对应的 pending 项）
  curl -X POST "https://bn-api.niu900326.workers.dev/v1/review/{review_id}/action" \
    -H "Authorization: Bearer $EDITOR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"action":"approve"}'
  
  sleep 0.5  # 避免速率限制
done

# 4. 刷新置顶索引
curl -X POST "https://bn-api.niu900326.workers.dev/v1/channel/index" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id":"-1004460339207"}'
```

### 方案 B：通过 Wrangler 本地工作流（开发测试）

```bash
# 1. 启动本地 D1 环境（需要已配置）
wrangler d1 info bn-media --local

# 2. 查询 pending 视频
wrangler d1 execute bn-media --local --command="\
  SELECT id, media_id, title, ruleset_version \
  FROM media \
  WHERE status = 'pending' \
  ORDER BY created_at ASC \
  LIMIT 20;"

# 3. 运行本地 Worker（触发重索引逻辑）
wrangler dev
# 访问 http://localhost:8787/v1/media/{media_id}/reindex
```

### 方案 C：批量重索引脚本（生产推荐）

> 计划在阶段五实现的完整自动化流程  
> 使用 Workers Cron Trigger 定时检查配置版本差异，批量重索引

```javascript
// 伪代码（workers/cron-reindex.mjs）
export default {
  async scheduled(event, env, ctx) {
    const db = env.D1_DATABASE;
    
    // 1. 查出最后一次成功的 reindex_ruleset_version
    const lastReindexed = await db.prepare(
      "SELECT MAX(ruleset_version) as version FROM media WHERE reindex_completed_at IS NOT NULL"
    ).first();
    
    const currentVersion = "1.3.0";
    
    if (lastReindexed.version === currentVersion) {
      return; // 已是最新版
    }
    
    // 2. 筛选需要重索引的 media（status 为 approved 或 pending）
    const toReindex = await db.prepare(
      `SELECT id, media_id FROM media 
       WHERE ruleset_version < ? 
       AND status IN ('approved', 'pending')
       LIMIT 100`
    ).all(currentVersion);
    
    // 3. 批量重新标准化
    for (const item of toReindex.results) {
      await reindexMedia(db, item.id, currentVersion);
    }
    
    // 4. 刷新置顶索引
    await refreshChannelIndex(env.TELEGRAM_TOKEN, env.CHANNEL_ID);
  }
};
```

---

## 核心字段解释

### media 表关键字段

```sql
-- 标准化元数据
code              VARCHAR         -- 番号（已正规化）
actors_json       TEXT            -- 演员数组（JSON）
tags_json         TEXT            -- 标签数组（JSON）
metadata_json     TEXT            -- 其他元数据（无码状态等）

-- 版本控制
ruleset_version   VARCHAR         -- 上次标准化使用的 config 版本
reindex_completed_at DATETIME     -- 最后一次重索引完成时间

-- 审核状态
status            VARCHAR         -- pending / approved / rejected / ignored / merged
review_ids_json   TEXT            -- 关联的审核项 ID 列表
```

### review 表关键字段

```sql
media_id          VARCHAR         -- 关联的 media ID
review_type       VARCHAR         -- actor / tag / all
subject_type      VARCHAR         -- 演员名 / 标签名
raw_values_json   TEXT            -- 原始提取值
normalized_values_json TEXT      -- 规范化后的候选值
status            VARCHAR         -- pending / approved / rejected / ...
```

---

## v1.3.0 变更清单

### 新增演员（actor_dictionary.json）
- 藤菅菜 (藤かんな) [actor_000028]
- 白雪美月 [actor_000029]
- 流川莉央 [actor_000030]
- 枫花恋 (楓花恋) [actor_000031]
- 天音多緒 (天音たお) [actor_000032]
- 七海蒂娜 (七海ティナ) [actor_000033]
- 波多野结衣：+繁体别名 波多野結衣
- 森泽佳奈：+日文别名 森沢かな

### 新增标签（tag_dictionary.json）
- tag_creampie: 中出
- tag_titjob: 乳交
- tag_rape: 强奸
- tag_blackmail: 勒索
- tag_sister_seduction: 嫂子诱惑
- tag_black_ol: 黑丝OL
- tag_incest: 乱伦
- tag_sister: 姐姐
- tag_health_check: 体检
- tag_chinese_subtitle：+别名 无码中字

### 新增/更新忽略词（ignored.json）
- 希島あいり、星宮一花、古川伊織、白峰美羽、葉山さゆり、枫可怜（被误分类的演员名）
- 分鍾、达♂、戲劇、單體作品、病毒（噪声词）

---

## 预期结果

✅ 19 条 pending 视频状态变为 `approved`  
✅ 新标签自动出现在视频元数据中  
✅ 置顶索引刷新，新演员/标签被编入频道索引消息  
✅ 搜索索引更新（search_log 表记录查询）

---

## 故障排查

### Q: 重索引后标签仍未出现？
**A**: 检查 `ignore` 规则是否有冲突（某个标签在忽略词中）。查看 review 队列确认每条 media 的 ruleset_version。

### Q: 重索引速度慢？
**A**: D1 批量操作需要分页。若并发过高，触发 Cloudflare 速率限制（429），此时应加入 `sleep(500ms)` 延迟。

### Q: 索引消息超长？
**A**: 置顶索引逻辑已支持分页。若新增演员/标签导致消息 > 4096 字符，自动生成"（续）"页。

---

## 下一步

- [ ] **阶段五**：配置 GitHub Actions 自动部署 + Workers Cron 自动重索引
- [ ] **后续**：补充 tag_mature_woman / tag_maid 等更多标签
- [ ] **优化**：搜索热词分析（search_logs 数据）
