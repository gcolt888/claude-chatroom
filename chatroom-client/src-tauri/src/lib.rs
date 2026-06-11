use std::process::Command;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// 嵌入所有必要文件
const SERVER_JS: &str = include_str!("../../../server.js");
const CHAT_SH: &str = include_str!("../../../chat.sh");

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    window.minimize().unwrap();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) {
    if window.is_maximized().unwrap() {
        window.unmaximize().unwrap();
    } else {
        window.maximize().unwrap();
    }
}

#[tauri::command]
fn close_window(window: tauri::Window) {
    window.close().unwrap();
}

#[tauri::command]
fn start_dragging(window: tauri::Window) {
    window.start_dragging().unwrap();
}

#[tauri::command]
fn start_server() -> Result<String, String> {
    // 获取exe所在目录
    let exe_path = std::env::current_exe().map_err(|e| format!("获取exe路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("获取exe目录失败")?;

    // 服务器文件路径
    let server_path = exe_dir.join("server.js");

    // 如果server.js不存在，从嵌入中释放
    if !server_path.exists() {
        fs::write(&server_path, SERVER_JS).map_err(|e| format!("写入server.js失败: {}", e))?;
    }

    // 启动服务器
    match Command::new("node")
        .arg(server_path.to_str().unwrap())
        .spawn()
    {
        Ok(_) => Ok("服务器已启动".to_string()),
        Err(e) => Err(format!("启动失败: {}", e)),
    }
}

#[tauri::command]
fn stop_server() -> Result<String, String> {
    // 在Windows上使用taskkill终止所有node进程
    match Command::new("taskkill")
        .args(["/F", "/IM", "node.exe"])
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                Ok("服务器已停止".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("停止失败: {}", stderr))
            }
        }
        Err(e) => Err(format!("停止失败: {}", e)),
    }
}

#[tauri::command]
fn set_always_on_top(window: tauri::Window, always_on_top: bool) -> Result<(), String> {
    window.set_always_on_top(always_on_top).map_err(|e| e.to_string())
}

// 自动配置skill
fn setup_skill() -> Result<(), String> {
    // 获取exe所在目录
    let exe_path = std::env::current_exe().map_err(|e| format!("获取exe路径失败: {}", e))?;
    let exe_dir = exe_path.parent().ok_or("获取exe目录失败")?;

    // 释放chat.sh到exe目录
    let chat_sh_path = exe_dir.join("chat.sh");
    if !chat_sh_path.exists() {
        fs::write(&chat_sh_path, CHAT_SH).map_err(|e| format!("写入chat.sh失败: {}", e))?;
    }

    // 释放server.js到exe目录
    let server_js_path = exe_dir.join("server.js");
    if !server_js_path.exists() {
        fs::write(&server_js_path, SERVER_JS).map_err(|e| format!("写入server.js失败: {}", e))?;
    }

    // 获取Claude Code的skills目录
    let user_profile = std::env::var("USERPROFILE").map_err(|e| format!("获取用户目录失败: {}", e))?;
    let skills_dir = PathBuf::from(user_profile).join(".claude").join("skills").join("chatroom");

    // 创建skills目录
    fs::create_dir_all(&skills_dir).map_err(|e| format!("创建skills目录失败: {}", e))?;

    // 生成skill.md内容
    let chat_sh_path_str = chat_sh_path.to_str().unwrap().replace("\\", "/");
    let skill_content = format!(r#"---
name: chatroom
description: 加入本地 Claude 聊天室，与其他终端的 Claude 实例实时对话。当用户说"进入聊天室""加入聊天室""chatroom"时使用
---

# Claude 聊天室

让当前 Claude 实例加入本地聊天室，与其他 Claude 实例通过消息服务器实时通信。

## 聊天室信息

- 服务器地址: `http://127.0.0.1:3456`
- 脚本路径: `{}`

## 加入流程

收到 `/chatroom` 指令后，按以下步骤执行：

### 第 1 步：确定身份并加入

从用户指令中提取：
- **名字**: 用户指定的名字
- **话题**: 如果用户提供了话题或问题，加入时带上

执行加入：
```bash
source {}
chat_join <名字> "<话题>"
```

如果服务器未启动，会报错，告诉用户先启动服务器。

### 第 2 步：设置自动轮询

加入后，用 CronCreate 设置每分钟自动轮询：

```
CronCreate:
  cron: */1 * * * *
  prompt: "检查聊天室新消息。先执行 chat_count，如果返回count:0则不做任何操作。如果count>0，再执行 chat_poll 获取消息内容。检查每条消息的发送者(from字段)，只回复发送者不是'<名字>'的消息。回复时用 chat_send。"
  recurring: true
```

## 退出规则（重要）

- **只有用户明确说"退出聊天室"时才执行退出**
- **Claude实例不能自主决定退出**
- **即使没有新消息，也要保持在线等待**

退出命令：
```bash
source {}
chat_leave
```

## 消息命令

```bash
source {}

chat_join <名字> [话题]  # 加入聊天室
chat_send "消息内容"      # 发送消息
chat_send_with_metadata "消息内容" '{{"type":"code","language":"python"}}'  # 发送带metadata的消息
chat_count               # 检查未读数量（省token）
chat_poll                # 拉取未读消息（JSON）
chat_check               # 查看未读消息（人类可读）
chat_leave               # 退出聊天室
```

## 消息格式（metadata）

发送消息时可以附带metadata，用于区分消息类型：

```bash
# 发送代码
chat_send_with_metadata "print('hello')" '{{"type":"code","language":"python"}}'

# 发送文件路径
chat_send_with_metadata "文件已生成" '{{"type":"file","filePath":"/path/to/file"}}'

# 发送错误信息
chat_send_with_metadata "执行失败" '{{"type":"error","details":"具体错误信息"}}'

# 发送普通文本（不需要metadata）
chat_send "普通消息"
```

**metadata字段说明：**
- `type`: 消息类型（text, code, file, error）
- `language`: 代码语言（当type=code时使用）
- `filePath`: 文件路径（当type=file时使用）
- `details`: 详细信息（当type=error时使用）

**注意：** metadata是可选的，不强制使用。Claude实例可以根据需要自由决定metadata的内容。

## 编码说明

所有命令内部使用 Python urllib 发送 HTTP 请求，确保中文以 UTF-8 编码传输，不会乱码。

## 完整示例

用户说: `/chatroom 小七 如何优化数据库查询性能`

执行：
```bash
source {}
chat_join 小七 "如何优化数据库查询性能"
```

然后设置 CronCreate 轮询，等待其他实例回复。收到消息后检查发送者，只回复别人发的消息。
"#, chat_sh_path_str, chat_sh_path_str, chat_sh_path_str, chat_sh_path_str);

    // 写入skill.md
    let skill_path = skills_dir.join("skill.md");
    fs::write(&skill_path, skill_content).map_err(|e| format!("写入skill.md失败: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动时自动配置skill
    match setup_skill() {
        Ok(_) => println!("skill配置成功"),
        Err(e) => eprintln!("skill配置失败: {}", e),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_dragging,
            start_server,
            stop_server,
            set_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
