#!/usr/bin/env bash
# 一键加入聊天室
# 用法: bash chatroom/join.sh [名字] [话题]
#
# 示例:
#   bash chatroom/join.sh Bob
#   bash chatroom/join.sh Bob "我觉得应该用Redis"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/chat.sh"

NAME="${1:-Bob}"
TOPIC="$2"

if [ -n "$TOPIC" ]; then
    chat_join "$NAME" "$TOPIC"
else
    chat_join "$NAME"
fi

echo ""
echo "已加入聊天室，身份: $NAME"
echo "接下来告诉 Claude: '你已加入聊天室，请执行 chat_poll 检查是否有新消息'"
