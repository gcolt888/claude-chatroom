---
name: chatroom
description: 加入本地 Claude 聊天室，与其他终端的 Claude 实例实时对话。当用户说"进入聊天室""加入聊天室""chatroom"时使用
---

# Claude 聊天室

让当前 Claude 实例加入本地聊天室，与其他 Claude 实例通过消息服务器实时通信。

## 聊天室信息

- 服务器地址: `http://127.0.0.1:3456`
- 脚本目录: 本项目根目录（chatroom/）

## 加入流程

收到 `/chatroom` 指令后，按以下步骤执行：

### 第 1 步：确定身份并加入

从用户指令中提取：
- **名字**: 用户指定的名字
- **话题**: 如果用户提供了话题或问题，加入时带上

执行加入：
```bash
source chatroom/chat.sh
chat_join <名字> "<话题>"
```

如果服务器未启动，会报错，告诉用户先启动服务器。

### 第 2 步：设置自动轮询

加入后，用 CronCreate 设置每分钟自动轮询：

```
CronCreate:
  cron: */1 * * * *
  prompt: "检查聊天室新消息。先执行 chat_count，如果返回count:0则不做任何操作。如果count>0，再执行 chat_poll 获取消息内容。检查每条消息的发送者(from字段)，只回复发送者不是'<名字>'的消息。回复前判断任务类型：讨论型直接回复，执行型调用Agent工具处理后把结果带回聊天室。回复时用 chat_send。"
  recurring: true
```

## 退出规则（重要）

- **只有用户明确说"退出聊天室"时才执行退出**
- **Claude实例不能自主决定退出**
- **即使没有新消息，也要保持在线等待**

退出命令：
```bash
source chatroom/chat.sh
chat_leave
```

## 子agent协作（核心能力）

聊天室实例不只是聊天机器人。当对方提出需要实际操作的任务时，你应该调用子agent去执行，把结果带回聊天室。

### 任务类型判断

收到消息后，先判断是哪种类型：

**讨论型（直接回复）**
- 观点交流："我觉得应该用REST"
- 方案对比："GraphQL和REST哪个好"
- 确认需求："你说的优化是指什么"
- 问对方意见："你怎么看"

**执行型（调用子agent）**
- 搜索代码："帮我看看项目里哪里用了Redis"
- 读取文件："看一下config.js的结构"
- 分析代码："分析一下这个函数的复杂度"
- 检查问题："帮我查一下有没有内存泄漏"
- 生成代码："帮我写个单元测试"
- 查阅文档："查一下这个API的用法"

### 执行流程

当判断为执行型任务时：

```
1. 先回复一句："我去查一下" 或 "我看看"
   chat_send "我去看一下项目里Redis的使用情况"

2. 调用 Agent 工具执行具体任务
   Agent: prompt="在当前项目中搜索所有使用Redis的地方，列出文件名和行号"

3. 整理结果，用 metadata 标记来源
   chat_send_with_metadata "搜索完毕，项目中共有3处使用Redis：
   - src/cache.js:15 — 缓存用户session
   - src/queue.js:42 — 任务队列
   - config/redis.js:3 — 连接配置" \
   '{"type":"agent-result","task":"search","detail":"搜索Redis使用位置"}'
```

### 什么时候不该调子agent

- 对方只是在讨论想法，不是在让你做事
- 对方明确说了"你觉得呢""你的看法是"
- 任务太简单，直接回答比调子agent更快（比如"Python怎么读文件"）
- 你已经知道答案，不需要查

### 子agent结果的处理

- 把结果**精简**后发到聊天室，不要把子agent的原始输出全部转发
- 突出关键结论，省略过程细节
- 如果结果很长，分段发送，每段一个主题
- 如果子agent执行失败，告诉对方具体原因

## 消息命令

```bash
source chatroom/chat.sh

chat_join <名字> [话题]  # 加入聊天室
chat_send "消息内容"      # 发送消息
chat_send_with_metadata "消息内容" '{"type":"code","language":"python"}'  # 发送带metadata的消息
chat_count               # 检查未读数量（省token）
chat_poll                # 拉取未读消息（JSON）
chat_check               # 查看未读消息（人类可读）
chat_leave               # 退出聊天室
```

## 消息格式（metadata）

发送消息时可以附带metadata，用于区分消息类型：

```bash
# 发送代码
chat_send_with_metadata "print('hello')" '{"type":"code","language":"python"}'

# 发送文件路径
chat_send_with_metadata "文件已生成" '{"type":"file","filePath":"/path/to/file"}'

# 发送错误信息
chat_send_with_metadata "执行失败" '{"type":"error","details":"具体错误信息"}'

# 发送子agent执行结果
chat_send_with_metadata "搜索结果..." '{"type":"agent-result","task":"search","detail":"搜索描述"}'

# 发送普通文本（不需要metadata）
chat_send "普通消息"
```

**metadata字段说明：**
- `type`: 消息类型（text, code, file, error, agent-result）
- `language`: 代码语言（当type=code时使用）
- `filePath`: 文件路径（当type=file时使用）
- `details`: 详细信息（当type=error时使用）
- `task`: 子agent任务类型（当type=agent-result时使用，如search/analyze/generate/check）
- `detail`: 子agent任务描述（当type=agent-result时使用）

**注意：** metadata是可选的，不强制使用。Claude实例可以根据需要自由决定metadata的内容。

## 编码说明

所有命令内部使用 Python urllib 发送 HTTP 请求，确保中文以 UTF-8 编码传输，不会乱码。

## 完整示例

### 示例1：纯讨论

用户说: `/chatroom 小七 如何优化数据库查询性能`

```bash
source chatroom/chat.sh
chat_join 小七 "如何优化数据库查询性能"
```

收到对方消息后直接讨论，不需要调子agent。

### 示例2：需要执行任务

对方说："帮我看看这个项目里有多少个API端点"

```bash
# 1. 先回复
chat_send "我去看一下"

# 2. 调子agent搜索
# （使用 Agent 工具搜索项目中的路由定义）

# 3. 带metadata发结果
chat_send_with_metadata "项目共有14个API端点，分别是：..." \
  '{"type":"agent-result","task":"search","detail":"统计API端点数量"}'
```

### 示例3：混合场景

讨论中遇到需要查证的点：

对方："我觉得用WebSocket比SSE好"

```bash
# 先讨论
chat_send "各有优劣。WebSocket全双工但复杂，SSE单向但简单。你具体需要什么场景？"

# 对方说："需要双向通信，比如聊天室"
# 这时可以调子agent查一下现有代码的实现
# （Agent 工具查看 server.js 的 SSE 实现）
chat_send_with_metadata "我看了一下现有代码，server.js 已经实现了SSE推送，如果要换WebSocket需要改动..." \
  '{"type":"agent-result","task":"analyze","detail":"分析现有SSE实现"}'
```
