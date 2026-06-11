# chatroom/start.pyw
# 双击启动 Claude 聊天室，无黑窗口
import subprocess
import sys
import os
import json
import webbrowser
import time
import threading
import urllib.request
import tkinter as tk
from tkinter import messagebox

PORT = 3456
URL = f"http://localhost:{PORT}"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_JS = os.path.join(SCRIPT_DIR, "server.js")

# ============================================================
# 服务器管理
# ============================================================
server_proc = None
log_file = None

def is_server_running():
    """检查服务器是否已在运行"""
    try:
        urllib.request.urlopen(f"{URL}/messages", timeout=1)
        return True
    except Exception:
        return False

def start_server():
    global server_proc, log_file
    if server_proc and server_proc.poll() is None:
        return True
    if is_server_running():
        update_status("running")
        return True

    if not os.path.exists(SERVER_JS):
        update_status("error")
        messagebox.showerror("错误", f"找不到服务器文件:\n{SERVER_JS}")
        return False

    log_path = os.path.join(SCRIPT_DIR, "server.log")
    log_file = open(log_path, "w", encoding="utf-8")

    try:
        server_proc = subprocess.Popen(
            ["node", SERVER_JS, str(PORT)],
            cwd=SCRIPT_DIR,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
    except FileNotFoundError:
        update_status("error")
        messagebox.showerror("错误", "找不到 Node.js，请先安装:\nhttps://nodejs.org")
        return False

    # 等服务器就绪
    for _ in range(20):
        time.sleep(0.5)
        if is_server_running():
            update_status("running")
            return True

    # 超时但进程还在，可能只是慢
    if server_proc.poll() is None:
        update_status("running")
        return True

    update_status("error")
    with open(log_path, "r", encoding="utf-8") as f:
        log = f.read()
    messagebox.showerror("启动失败", f"服务器未能启动，日志:\n\n{log[-500:]}")
    return False

def stop_server():
    global server_proc, log_file
    if server_proc and server_proc.poll() is None:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        server_proc = None
    if log_file:
        log_file.close()
        log_file = None
    update_status("stopped")

def open_browser():
    webbrowser.open(URL)

def restart_server():
    stop_server()
    time.sleep(1)
    start_server()

def clear_messages():
    """清空聊天室消息"""
    try:
        req = urllib.request.Request(
            f"{URL}/clear",
            data=b'{}',
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass

# ============================================================
# 后台健康检查 + 实时状态
# ============================================================
info_var = None

def health_loop():
    global info_var
    while True:
        time.sleep(3)
        try:
            if not root.winfo_exists():
                break
            if server_proc and server_proc.poll() is not None:
                root.after(0, lambda: update_status("crashed"))
            # 查询在线实例和消息数
            try:
                resp = urllib.request.urlopen(f"{URL}/messages", timeout=2)
                data = json.loads(resp.read().decode("utf-8"))
                users = data.get("users", [])
                msg_count = len(data.get("messages", []))
                info = f"在线: {', '.join(users) if users else '无'} | 消息: {msg_count}"
                if info_var:
                    root.after(0, lambda i=info: info_var.set(i))
            except Exception:
                if info_var:
                    root.after(0, lambda: info_var.set("服务器无响应"))
        except tk.TclError:
            break

# ============================================================
# GUI
# ============================================================
root = tk.Tk()
root.title("Claude 聊天室")
root.geometry("380x260")
root.resizable(False, False)
root.configure(bg="#1a1a2e")

# 标题
tk.Label(root, text="📡 Claude 聊天室",
         font=("Microsoft YaHei", 18, "bold"),
         fg="#e94560", bg="#1a1a2e").pack(pady=(20, 5))

# 状态
status_var = tk.StringVar(value="正在启动...")
status_label = tk.Label(root, textvariable=status_var,
                        font=("Microsoft YaHei", 12),
                        fg="#888", bg="#1a1a2e")
status_label.pack(pady=(0, 5))

# URL
url_label = tk.Label(root, text=URL,
                     font=("Consolas", 11),
                     fg="#4fc3f7", bg="#1a1a2e",
                     cursor="hand2")
url_label.pack(pady=(0, 5))
url_label.bind("<Button-1>", lambda e: open_browser())

# 实时状态
info_var = tk.StringVar(value="正在查询...")
info_label = tk.Label(root, textvariable=info_var,
                      font=("Microsoft YaHei", 10),
                      fg="#666", bg="#1a1a2e")
info_label.pack(pady=(0, 10))

def update_status(state):
    colors = {
        "running": ("🟢 运行中", "#4caf50"),
        "stopped": ("🔴 已停止", "#f44336"),
        "error":   ("❌ 启动失败", "#f44336"),
        "crashed": ("💥 进程崩溃，点击重启", "#ff9800"),
    }
    text, color = colors.get(state, ("未知", "#888"))
    status_var.set(text)
    status_label.configure(fg=color)

# 按钮区域
btn_frame = tk.Frame(root, bg="#1a1a2e")
btn_frame.pack(pady=5)

btn_style = {
    "font": ("Microsoft YaHei", 10),
    "width": 10,
    "bd": 0,
    "relief": "flat",
    "cursor": "hand2",
}

tk.Button(btn_frame, text="打开浏览器", command=open_browser,
          bg="#0f3460", fg="#e0e0e0", activebackground="#1a4a7a",
          **btn_style).grid(row=0, column=0, padx=5, pady=4)

tk.Button(btn_frame, text="重启服务", command=lambda: threading.Thread(target=restart_server, daemon=True).start(),
          bg="#3d3500", fg="#f5a623", activebackground="#5a4d00",
          **btn_style).grid(row=0, column=1, padx=5, pady=4)

tk.Button(btn_frame, text="停止服务", command=lambda: threading.Thread(target=stop_server, daemon=True).start(),
          bg="#5a1a1a", fg="#f44336", activebackground="#7a2a2a",
          **btn_style).grid(row=0, column=2, padx=5, pady=4)

tk.Button(btn_frame, text="查看日志", command=lambda: os.startfile(os.path.join(SCRIPT_DIR, "server.log")),
          bg="#1a3a1a", fg="#4caf50", activebackground="#2a5a2a",
          **btn_style).grid(row=1, column=0, padx=5, pady=4)

tk.Button(btn_frame, text="打开目录", command=lambda: os.startfile(SCRIPT_DIR),
          bg="#2a1a3a", fg="#bb86fc", activebackground="#3a2a5a",
          **btn_style).grid(row=1, column=1, padx=5, pady=4)

tk.Button(btn_frame, text="清空消息", command=lambda: threading.Thread(target=clear_messages, daemon=True).start(),
          bg="#3a2a00", fg="#ff9800", activebackground="#5a3a00",
          **btn_style).grid(row=1, column=2, padx=5, pady=4)

tk.Button(btn_frame, text="退出", command=lambda: on_close(),
          bg="#333", fg="#888", activebackground="#444",
          **btn_style).grid(row=2, column=0, columnspan=3, padx=5, pady=(8,4))

# ============================================================
# 关闭处理
# ============================================================
def on_close():
    if server_proc and server_proc.poll() is None:
        if messagebox.askyesno("确认退出", "服务器正在运行，退出时是否同时停止服务器？"):
            stop_server()
    root.destroy()

root.protocol("WM_DELETE_WINDOW", on_close)

# ============================================================
# 启动
# ============================================================
threading.Thread(target=start_server, daemon=True).start()
threading.Thread(target=health_loop, daemon=True).start()

root.mainloop()
