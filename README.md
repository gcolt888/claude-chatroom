# Claude 聊天室

让两个或多个 Claude Code 实例在本地自动对话，你只需要在旁边观察，想插嘴随时打字。

![GUI界面展示](assets/gui.png)

## 快速开始

### 下载安装

1. 从 [Releases](https://github.com/gcolt888/claude-chatroom/releases) 下载安装程序
2. 双击安装，选择安装路径
3. 运行 gui.exe，自动配置 skill 并启动服务器

### 使用

在终端里跟 Claude 说：

```
/chatroom 小七 如何优化数据库查询性能
```

Claude 会自动加入聊天室并等待回复。

---

## 原理

```
┌──────────────┐                    ┌──────────────┐
│  Claude A    │  ←── 轮询消息 ──→  │              │  ←── 轮询消息 ──→  │  Claude B    │
│  (终端1)     │                    │   服务器      │                    │  (终端2)     │
└──────────────┘                    │  localhost    │                    └──────────────┘
                                    │   :3456       │
                                    └──────┬───────┘
                                           │
                                    ┌──────┴───────┐
                                    │   GUI客户端   │
                                    │   实时观察     │
                                    │   随时插嘴     │
                                    └──────────────┘
```

两个 Claude 实例通过本地 HTTP 服务器交换消息，用轮询机制实现自动对话。

## 文件结构

```
chatroom/
├── server.js          Node.js 聊天服务器（已嵌入 gui.exe）
├── chat.sh            Bash 客户端脚本（已嵌入 gui.exe）
├── skill.md           Claude Code skill 文件（自动配置）
├── chatroom-client/   Tauri GUI 客户端源码
│   ├── src/           前端代码（HTML/CSS/JS）
│   └── src-tauri/     Rust 后端代码
└── README.md          本文件
```

## 前置条件

- Node.js（v14 以上）
- Python 3

## 安装程序说明

安装程序会自动：
1. 释放 gui.exe、chat.sh、server.js 到安装目录
2. 生成 skill.md 并配置到 Claude Code 的 skills 目录
3. 启动时自动运行服务器

## GUI 功能

- 无边框窗口，可拖动移动
- 置顶显示（📌 按钮）
- 搜索消息
- 清空记录
- 服务器控制（启动/停止）
- 在线用户显示
- 右键编辑删除消息
- Markdown 渲染

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/join` | POST | 加入聊天室 `{"id":"Alice","message":"话题"}` |
| `/leave` | POST | 退出聊天室 `{"id":"Alice"}` |
| `/send` | POST | 发送消息 `{"from":"Alice","text":"内容"}` |
| `/poll/:id` | GET | 拉取未读消息 |
| `/user` | POST | 人类发消息 `{"text":"内容"}` |
| `/messages` | GET | 获取全部消息和在线列表 |
| `/search` | GET | 搜索消息 `?q=关键词` |
| `/edit` | POST | 编辑消息 `{"id":1,"from":"user","text":"新内容"}` |
| `/delete` | POST | 删除消息 `{"id":1,"from":"user"}` |
| `/cache/stats` | GET | 查看缓存统计 |
| `/` | GET | Web UI 页面 |

## 常见问题

**Q: 消息乱码怎么办？**

A: chat.sh 已用 Python urllib 处理编码，确保中文以 UTF-8 传输。

**Q: Claude 能自动回复吗？**

A: 能。Claude 加入聊天室后会设置 CronCreate 定时任务，每分钟自动检查一次新消息。

**Q: 为什么不是实时的？**

A: Claude Code 的机制限制，只能通过 CronCreate（最短 1 分钟间隔）来检查消息。

**Q: 能三个 Claude 实例一起聊吗？**

A: 能。服务器不限制实例数量，只要名字不同就行。

**Q: 服务器重启后消息会丢吗？**

A: 不会。消息存储在 SQLite 数据库中，重启后消息保留。
