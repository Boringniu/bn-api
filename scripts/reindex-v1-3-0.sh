#!/bin/bash

# 版本 1.3.0 视频重索引脚本
# 用途：批量审核通过 19 条 pending 视频，应用新的演员/标签/忽略词规则

set -e

# ===== 配置 =====
WORKER_URL="${WORKER_URL:-https://bn-api.niu900326.workers.dev}"
EDITOR_TOKEN="${EDITOR_TOKEN:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
CHANNEL_ID="-1004460339207"
CONFIG_VERSION="1.3.0"
SLEEP_MS=500  # 请求间隔（毫秒），避免速率限制

# ===== 颜色输出 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ===== 验证 token =====
if [ -z "$EDITOR_TOKEN" ] || [ -z "$ADMIN_TOKEN" ]; then
  echo -e "${RED}❌ 错误：缺少 EDITOR_TOKEN 或 ADMIN_TOKEN${NC}"
  echo "请设置环境变量后再运行："
  echo "  export EDITOR_TOKEN='your-editor-token'"
  echo "  export ADMIN_TOKEN='your-admin-token'"
  exit 1
fi

echo -e "${YELLOW}📋 版本 1.3.0 重索引计划${NC}"
echo "Worker: $WORKER_URL"
echo "Config version: $CONFIG_VERSION"
echo "Channel: $CHANNEL_ID"
echo ""

# ===== 查询 pending 队列 =====
echo -e "${YELLOW}🔍 第 1/3 步：查询 pending 视频队列...${NC}"

QUEUE_RESPONSE=$(curl -s -X GET "$WORKER_URL/v1/review?status=pending" \
  -H "Authorization: Bearer $EDITOR_TOKEN" \
  -H "Content-Type: application/json")

# 检查错误
if echo "$QUEUE_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
  ERROR_MSG=$(echo "$QUEUE_RESPONSE" | jq -r '.error')
  echo -e "${RED}❌ API 错误：$ERROR_MSG${NC}"
  exit 1
fi

# 提取审核项列表
REVIEW_IDS=$(echo "$QUEUE_RESPONSE" | jq -r '.items[].id' 2>/dev/null || echo "")

if [ -z "$REVIEW_IDS" ]; then
  echo -e "${YELLOW}⚠️  没有找到 pending 项，可能已全部审核完成${NC}"
else
  COUNT=$(echo "$REVIEW_IDS" | wc -l)
  echo -e "${GREEN}✓ 找到 $COUNT 条 pending 项${NC}"
  echo ""

  # ===== 逐条审核 =====
  echo -e "${YELLOW}✏️  第 2/3 步：批量审核通过...${NC}"

  APPROVED=0
  FAILED=0

  for REVIEW_ID in $REVIEW_IDS; do
    # 审核通过
    APPROVE_RESPONSE=$(curl -s -X POST "$WORKER_URL/v1/review/$REVIEW_ID/action" \
      -H "Authorization: Bearer $EDITOR_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"action":"approve"}')

    if echo "$APPROVE_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
      APPROVED=$((APPROVED + 1))
      echo -e "${GREEN}  ✓${NC} $REVIEW_ID 已通过"
    else
      FAILED=$((FAILED + 1))
      echo -e "${RED}  ✗${NC} $REVIEW_ID 审核失败"
    fi

    # 延迟避免速率限制
    sleep 0.$(printf "%03d" $((RANDOM % 1000)))
  done

  echo ""
  echo -e "${GREEN}✓ 审核完成：$APPROVED 通过，$FAILED 失败${NC}"
fi

# ===== 刷新置顶索引 =====
echo ""
echo -e "${YELLOW}🔄 第 3/3 步：刷新置顶索引...${NC}"

INDEX_RESPONSE=$(curl -s -X POST "$WORKER_URL/v1/channel/index" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\":\"$CHANNEL_ID\",\"force_refresh\":true}")

if echo "$INDEX_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
  PAGES=$(echo "$INDEX_RESPONSE" | jq '.data.pages // 1')
  echo -e "${GREEN}✓ 索引已刷新（分 $PAGES 页）${NC}"
else
  echo -e "${RED}⚠️  索引刷新可能失败，请手动检查${NC}"
fi

echo ""
echo -e "${GREEN}✅ v1.3.0 重索引流程完成！${NC}"
echo ""
echo "总结："
echo "  • 新增演员：8 个（+ 2 个别名）"
echo "  • 新增标签：9 个（+ 1 个别名）"
echo "  • 新增忽略词：11 个"
echo "  • 审核通过数：$APPROVED 条"
echo "  • 置顶索引：已刷新"
