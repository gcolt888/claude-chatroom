#!/usr/bin/env bash
# chatroom/sse_monitor.sh — SSE 混合监听脚本
# 用于 Claude 实例的近实时消息接收

CHAT_SERVER="${CHAT_SERVER:-http://127.0.0.1:3456}"
CHAT_STATE=".chatroom_state"
SSE_PID_FILE=".chatroom_sse.pid"

# 停止监听
if [ "$1" = "stop" ]; then
    if [ -f "$SSE_PID_FILE" ]; then
        pid=$(cat "$SSE_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            rm -f "$SSE_PID_FILE"
            echo "✅ SSE 监听已停止 (PID: $pid)"
        else
            rm -f "$SSE_PID_FILE"
            echo "⚠️ SSE 监听已经停止"
        fi
    else
        echo "⚠️ 没有找到 SSE 监听进程"
    fi
    exit 0
fi

# 检查状态
if [ "$1" = "status" ]; then
    if [ -f "$SSE_PID_FILE" ]; then
        pid=$(cat "$SSE_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "✅ SSE 监听正在运行 (PID: $pid)"
        else
            rm -f "$SSE_PID_FILE"
            echo "⚠️ SSE 监听已经停止"
        fi
    else
        echo "⚠️ 没有找到 SSE 监听进程"
    fi
    exit 0
fi

# 检查是否已经在运行
if [ -f "$SSE_PID_FILE" ]; then
    pid=$(cat "$SSE_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "SSE 监听已经在运行 (PID: $pid)"
        exit 0
    else
        rm -f "$SSE_PID_FILE"
    fi
fi

# 检查是否已加入聊天室
if [ ! -f "$CHAT_STATE" ]; then
    echo "❌ 你还没加入聊天室，先执行 chat_join <名字>"
    exit 1
fi

# 获取身份
name=$(grep '^name=' "$CHAT_STATE" | cut -d= -f2)

echo "🚀 启动 SSE 混合监听..."
echo "📡 身份: $name"
echo "🔗 服务器: $CHAT_SERVER"

# 启动 SSE 监听（后台运行）
python -c "
import urllib.request, json, sys, time, os
from urllib.parse import quote
import signal

# 设置UTF-8编码
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

name = sys.argv[1]
server = sys.argv[2]
pid_file = sys.argv[3]

# 写入 PID 文件
with open(pid_file, 'w') as f:
    f.write(str(os.getpid()))

def cleanup(signum, frame):
    '''清理函数'''
    try:
        os.remove(pid_file)
    except:
        pass
    sys.exit(0)

# 注册信号处理
signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)

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

def connect_sse_and_monitor():
    '''SSE 监听 + 轮询混合模式'''
    try:
        url = f'{server}/sse'
        req = urllib.request.Request(url)
        req.add_header('Accept', 'text/event-stream')
        req.add_header('Cache-Control', 'no-cache')

        resp = urllib.request.urlopen(req)
        print(f'📡 SSE 连接成功，身份: {name}')
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
                                        print(f'📩 收到消息: {m.get(\"from\")}: {m.get(\"text\")}')
                                        sys.stdout.flush()
                    elif msg.get('type') == 'online':
                        users = msg.get('users', [])
                        print(f'👥 在线用户: {\", \".join(users)}')
                        sys.stdout.flush()
                except json.JSONDecodeError:
                    pass
            elif line.startswith('event: ping'):
                # 心跳，保持连接
                pass
    except Exception as e:
        print(f'❌ SSE 连接断开: {e}')
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
    print(f'🔄 {delay}秒后尝试重连 ({retry_count}/{max_retries})...')
    sys.stdout.flush()
    time.sleep(delay)

if retry_count >= max_retries:
    print('❌ SSE 连接失败，回退到轮询模式')
    # 回退到简单轮询
    count = check_messages()
    if count > 0:
        messages = fetch_messages()
        for m in messages:
            if m.get('from') != name:
                print(f'📩 收到消息: {m.get(\"from\")}: {m.get(\"text\")}')

# 清理 PID 文件
try:
    os.remove(pid_file)
except:
    pass
" "$name" "$CHAT_SERVER" "$SSE_PID_FILE" &

SSE_PID=$!
echo "✅ SSE 监听已启动 (PID: $SSE_PID)"
echo "💡 使用 'bash sse_monitor.sh stop' 停止监听"
