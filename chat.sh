#!/usr/bin/env bash
# chatroom/chat.sh — Claude 实例聊天室客户端
# 用法: source chatroom/chat.sh && chat_join Alice "我的话题"

CHAT_SERVER="${CHAT_SERVER:-http://127.0.0.1:3456}"
CHAT_STATE=".chatroom_state"

# 用 Python 发 POST 请求，确保 UTF-8 编码
_chat_post() {
  local url="$1"
  local json="$2"
  python -c "
import urllib.request, json, sys
data = json.dumps(json.loads(sys.argv[1])).encode('utf-8')
req = urllib.request.Request(sys.argv[2], data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print(e.read().decode('utf-8'))
" "$json" "$url"
}

# ============================================================
# chat_join <名字> [初始消息]
# 加入聊天室，写状态文件，可选带话题
# ============================================================
chat_join() {
  local name="$1"
  local msg="$2"
  if [ -z "$name" ]; then
    echo "❌ 用法: chat_join <名字> [初始消息]"
    return 1
  fi

  # 写本地状态
  echo "name=$name" > "$CHAT_STATE"
  echo "server=$CHAT_SERVER" >> "$CHAT_STATE"

  # 向服务器注册（用 Python 确保 UTF-8 编码）
  if [ -n "$msg" ]; then
    _chat_post "$CHAT_SERVER/join" "{\"id\":\"$name\",\"message\":\"$msg\"}" > /dev/null
    echo "🟢 $name 已加入聊天室 (带话题)"
  else
    _chat_post "$CHAT_SERVER/join" "{\"id\":\"$name\"}" > /dev/null
    echo "🟢 $name 已加入聊天室"
  fi
}

# ============================================================
# chat_send <消息>
# 发送消息
# ============================================================
chat_send() {
  local text="$1"

  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室，先执行 chat_join <名字>"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

  local result
  result=$(_chat_post "$CHAT_SERVER/send" "{\"from\":\"$name\",\"text\":\"$text\"}")

  local err
  err=$(echo "$result" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$err" ]; then
    echo "⚠️ $err"
    return 1
  fi

  echo "✅ 已发送"
}

# ============================================================
# chat_send_with_metadata <消息> <metadata_json>
# 发送带metadata的消息
# 示例: chat_send_with_metadata "print('hello')" '{"type":"code","language":"python"}'
# ============================================================
chat_send_with_metadata() {
  local text="$1"
  local metadata="$2"

  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室，先执行 chat_join <名字>"
    return 1
  fi

  if [ -z "$metadata" ]; then
    echo "⚠️ 用法: chat_send_with_metadata <消息> <metadata_json>"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

  local result
  result=$(_chat_post "$CHAT_SERVER/send" "{\"from\":\"$name\",\"text\":\"$text\",\"metadata\":$metadata}")

  local err
  err=$(echo "$result" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$err" ]; then
    echo "⚠️ $err"
    return 1
  fi

  echo "✅ 已发送（带metadata）"
}

# ============================================================
# chat_poll
# 拉取未读消息，返回原始 JSON
# ============================================================
chat_poll() {
  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)
  python -c "
import urllib.request, json, sys, io
from urllib.parse import quote
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
name = quote(sys.argv[1])
url = f'http://127.0.0.1:3456/poll/{name}'
resp = urllib.request.urlopen(url)
print(resp.read().decode('utf-8'))
" "$name"
}

# ============================================================
# chat_count
# 检查未读消息数量（节省 token，不返回消息内容）
# ============================================================
chat_count() {
  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)
  python -c "
import urllib.request, json, sys
from urllib.parse import quote
name = quote(sys.argv[1])
url = f'http://127.0.0.1:3456/poll/{name}?mode=count'
resp = urllib.request.urlopen(url)
print(resp.read().decode('utf-8'))
" "$name"
}

# ============================================================
# chat_check
# 检查未读消息，人类可读格式输出
# ============================================================
chat_check() {
  local result
  result=$(chat_poll)
  local count
  count=$(echo "$result" | grep -o '"from"' | wc -l)

  if [ "$count" -eq 0 ]; then
    echo "📭 没有新消息"
    return
  fi

  echo "📬 收到 $count 条新消息:"
  echo "$result" | python -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('messages', []):
    src = '👤 你' if m['from'] == 'user' else ('⚙️ 系统' if m['from'] == 'system' else '🤖 ' + m['from'])
    print(f\"  {src}: {m['text']}\")
"
}

# ============================================================
# chat_leave
# 退出聊天室
# ============================================================
chat_leave() {
  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

  _chat_post "$CHAT_SERVER/leave" "{\"id\":\"$name\"}" > /dev/null

  rm -f "$CHAT_STATE"
  echo "🔴 $name 已退出聊天室"
}

# ============================================================
# chat_status
# 查看当前状态
# ============================================================
chat_status() {
  if [ -f "$CHAT_STATE" ]; then
    local name
    name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)
    echo "📡 聊天室状态: 在线 (身份: $name)"
  else
    echo "📡 聊天室状态: 未加入"
  fi
}

# ============================================================
# chat_sse
# 实时监听聊天室消息（SSE 模式）
# ============================================================
chat_sse() {
  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室，先执行 chat_join <名字>"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

  echo "🔴 连接到聊天室 SSE... (按 Ctrl+C 退出)"
  echo "📡 身份: $name"
  echo "---"

  python -c "
import urllib.request, json, sys, time

name = sys.argv[1]
server = sys.argv[2]

def connect_sse():
    url = f'{server}/sse'
    req = urllib.request.Request(url)
    req.add_header('Accept', 'text/event-stream')
    req.add_header('Cache-Control', 'no-cache')

    try:
        resp = urllib.request.urlopen(req)
        buffer = ''
        for line in resp:
            line = line.decode('utf-8').rstrip()
            if line.startswith('data: '):
                data = line[6:]
                try:
                    msg = json.loads(data)
                    if msg.get('type') == 'message':
                        from_name = msg.get('from', 'unknown')
                        text = msg.get('text', '')
                        if from_name != name:
                            src = '👤 你' if from_name == 'user' else '🤖 ' + from_name
                            print(f'  {src}: {text}')
                            sys.stdout.flush()
                    elif msg.get('type') == 'online':
                        users = msg.get('users', [])
                        print(f'📡 在线用户: {\", \".join(users)}')
                        sys.stdout.flush()
                except json.JSONDecodeError:
                    pass
            elif line.startswith('event: ping'):
                # 心跳，保持连接
                pass
    except Exception as e:
        print(f'❌ 连接断开: {e}')
        return False
    return True

# 断线重连机制
retry_count = 0
max_retries = 5
while retry_count < max_retries:
    if connect_sse():
        break
    retry_count += 1
    print(f'[RETRY] 尝试重连 ({retry_count}/{max_retries})...')
    time.sleep(2)

if retry_count >= max_retries:
    print('❌ 连接失败，请检查服务器状态')
" "$name" "$CHAT_SERVER"
}

# ============================================================
# chat_sse_monitor
# SSE 混合监听模式：SSE 接收通知 + 轮询获取完整消息
# 用于 CronCreate 自动任务，实现近实时消息接收
# ============================================================
chat_sse_monitor() {
  if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室，先执行 chat_join <名字>"
    return 1
  fi

  local name
  name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

  python -c "
import urllib.request, json, sys, time
from urllib.parse import quote

# 设置UTF-8编码
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

name = sys.argv[1]
server = sys.argv[2]

def check_messages():
    '''检查未读消息数量'''
    try:
        encoded_name = quote(name)
        url = f'{server}/poll/{encoded_name}?mode=count'
        resp = urllib.request.urlopen(url)
        data = json.loads(resp.read().decode('utf-8'))
        return data.get('count', 0)
    except Exception as e:
        return 0

def fetch_messages():
    '''获取未读消息'''
    try:
        encoded_name = quote(name)
        url = f'{server}/poll/{encoded_name}'
        resp = urllib.request.urlopen(url)
        data = json.loads(resp.read().decode('utf-8'))
        return data.get('messages', [])
    except Exception as e:
        return []

def send_reply(text):
    '''发送回复消息'''
    try:
        data = json.dumps({'from': name, 'text': text}).encode('utf-8')
        req = urllib.request.Request(
            f'{server}/send',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read().decode('utf-8')).get('ok', False)
    except Exception as e:
        return False

def connect_sse_and_monitor():
    '''SSE 监听 + 轮询混合模式'''
    try:
        url = f'{server}/sse'
        req = urllib.request.Request(url)
        req.add_header('Accept', 'text/event-stream')
        req.add_header('Cache-Control', 'no-cache')

        resp = urllib.request.urlopen(req)
        print(f'[SSE] 连接成功，身份: {name}')
        sys.stdout.flush()

        for line in resp:
            line = line.decode('utf-8').rstrip()
            if line.startswith('data: '):
                data = line[6:]
                try:
                    msg = json.loads(data)
                    if msg.get('type') == 'message':
                        from_name = msg.get('from', 'unknown')
                        if from_name != name:
                            # 收到新消息通知，轮询获取完整消息
                            count = check_messages()
                            if count > 0:
                                messages = fetch_messages()
                                for m in messages:
                                    if m.get('from') != name:
                                        print(f'[MSG] {m.get(\"from\")}: {m.get(\"text\")}')
                                        sys.stdout.flush()
                    elif msg.get('type') == 'online':
                        users = msg.get('users', [])
                        print(f'[ONLINE] {\", \".join(users)}')
                        sys.stdout.flush()
                except json.JSONDecodeError:
                    pass
            elif line.startswith('event: ping'):
                # 心跳，保持连接
                pass
    except Exception as e:
        print(f'[ERROR] SSE 连接断开: {e}')
        return False
    return True

# 主循环：SSE 监听 + 自动重连
retry_count = 0
max_retries = 10
retry_delay = 5  # 初始重连延迟（秒）

while retry_count < max_retries:
    if connect_sse_and_monitor():
        break
    retry_count += 1
    # 指数退避算法：延迟时间翻倍，最大60秒
    delay = min(retry_delay * (2 ** (retry_count - 1)), 60)
    print(f'[RETRY] {delay}秒后尝试重连 ({retry_count}/{max_retries})...')
    sys.stdout.flush()
    time.sleep(delay)

if retry_count >= max_retries:
    print('[FALLBACK] SSE 连接失败，回退到轮询模式')
    # 回退到简单轮询
    count = check_messages()
    if count > 0:
        messages = fetch_messages()
        for m in messages:
            if m.get('from') != name:
                print(f'[MSG] {m.get(\"from\")}: {m.get(\"text\")}')
" "$name" "$CHAT_SERVER"
}

echo "📡 聊天室客户端已加载"
echo "   chat_join <名字> [话题]  — 加入聊天室"
echo "   chat_send <消息>          — 发送消息"
echo "   chat_count               — 检查未读数量 (省token)"
echo "   chat_poll                — 拉取未读 (JSON)"
echo "   chat_check               — 查看未读 (可读格式)"
echo "   chat_sse                 — 实时监听消息 (SSE模式)"
echo "   chat_sse_monitor         — SSE混合监听 (近实时+自动重连)"
echo "   chat_leave               — 退出聊天室"
echo "   chat_status              — 查看状态"
