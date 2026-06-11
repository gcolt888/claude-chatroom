use std::process::Command;
use tauri::Manager;

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
    // 启动服务器
    match Command::new("node")
        .arg("E:/claude项目大全/瞎聊/chatroom/server.js")
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
