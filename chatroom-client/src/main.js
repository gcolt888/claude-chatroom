const { invoke } = window.__TAURI__.core;

// 配置
const SERVER_URL = 'http://127.0.0.1:3456';

// 元素
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const closeBtn = document.getElementById('close-btn');
const titlebar = document.getElementById('titlebar');
const searchBtn = document.getElementById('search-btn');
const clearBtn = document.getElementById('clear-btn');
const searchPanel = document.getElementById('searchPanel');
const searchInput = document.getElementById('searchInput');
const searchSubmit = document.getElementById('searchSubmit');
const searchClear = document.getElementById('searchClear');
const searchResults = document.getElementById('searchResults');

// 对话框元素
const dialogOverlay = document.getElementById('dialogOverlay');
const dialogTitle = document.getElementById('dialogTitle');
const dialogMessage = document.getElementById('dialogMessage');
const dialogCancel = document.getElementById('dialogCancel');
const dialogConfirm = document.getElementById('dialogConfirm');

// 置顶按钮
const pinBtn = document.getElementById('pin-btn');
let isPinned = false;

// 当前用户
let currentUser = 'user';

// 标题栏按钮
minimizeBtn.addEventListener('click', async () => {
  await invoke('minimize_window');
});

maximizeBtn.addEventListener('click', async () => {
  await invoke('toggle_maximize_window');
});

closeBtn.addEventListener('click', async () => {
  await invoke('close_window');
});

// 标题栏拖动 - 使用Tauri的startDragging API
titlebar.addEventListener('mousedown', async (e) => {
  // 忽略按钮点击
  if (e.target.closest('.titlebar-btn') || e.target.closest('.toolbar-btn')) return;

  // 调用Tauri的startDragging
  try {
    await invoke('start_dragging');
  } catch (err) {
    console.error('拖动失败:', err);
  }
});

// 搜索功能
searchBtn.addEventListener('click', () => {
  searchPanel.classList.toggle('active');
  if (searchPanel.classList.contains('active')) {
    searchInput.focus();
  }
});

searchSubmit.addEventListener('click', performSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch();
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchResults.textContent = '';
  loadHistory();
});

async function performSearch() {
  const keyword = searchInput.value.trim();
  if (!keyword) {
    searchResults.textContent = '请输入搜索关键词';
    return;
  }

  try {
    const response = await fetch(`${SERVER_URL}/search?q=${encodeURIComponent(keyword)}`);
    const data = await response.json();

    if (data.error) {
      searchResults.textContent = '搜索错误: ' + data.error;
      return;
    }

    searchResults.textContent = `找到 ${data.total} 条消息`;
    messagesEl.innerHTML = '';
    data.messages.forEach(addMessage);
  } catch (error) {
    searchResults.textContent = '搜索失败: ' + error.message;
  }
}

// 自定义对话框函数
function showDialog(title, message) {
  return new Promise((resolve) => {
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogOverlay.classList.add('active');

    const onConfirm = () => {
      dialogOverlay.classList.remove('active');
      dialogConfirm.removeEventListener('click', onConfirm);
      dialogCancel.removeEventListener('click', onCancel);
      resolve(true);
    };

    const onCancel = () => {
      dialogOverlay.classList.remove('active');
      dialogConfirm.removeEventListener('click', onConfirm);
      dialogCancel.removeEventListener('click', onCancel);
      resolve(false);
    };

    dialogConfirm.addEventListener('click', onConfirm);
    dialogCancel.addEventListener('click', onCancel);
  });
}

function showAlert(message) {
  return showDialog('提示', message);
}

// 清空记录
clearBtn.addEventListener('click', async () => {
  const confirmed = await showDialog('清空记录', '确定要清空所有聊天记录吗？此操作不可恢复。');
  if (!confirmed) return;

  try {
    const response = await fetch(`${SERVER_URL}/clear`, { method: 'POST' });
    const data = await response.json();

    if (data.ok) {
      messagesEl.innerHTML = '';
      await showAlert('聊天记录已清空');
    }
  } catch (error) {
    await showAlert('清空失败: ' + error.message);
  }
});

// 置顶功能
pinBtn.addEventListener('click', async () => {
  try {
    isPinned = !isPinned;
    await invoke('set_always_on_top', { alwaysOnTop: isPinned });
    pinBtn.classList.toggle('active', isPinned);
  } catch (error) {
    console.error('置顶失败:', error);
  }
});

// 服务器控制
const serverBtn = document.getElementById('server-btn');
const serverPanel = document.getElementById('serverPanel');
const serverStatus = document.getElementById('serverStatus');
const startServerBtn = document.getElementById('startServer');
const stopServerBtn = document.getElementById('stopServer');
const onlineUsersEl = document.getElementById('onlineUsers');

serverBtn.addEventListener('click', () => {
  serverPanel.classList.toggle('active');
  if (serverPanel.classList.contains('active')) {
    checkServerStatus();
  }
});

startServerBtn.addEventListener('click', async () => {
  try {
    serverStatus.textContent = '启动中...';
    serverStatus.className = 'status-text';
    await invoke('start_server');
    setTimeout(checkServerStatus, 1000);
  } catch (error) {
    serverStatus.textContent = '启动失败';
    serverStatus.className = 'status-text offline';
    alert('启动失败: ' + error);
  }
});

stopServerBtn.addEventListener('click', async () => {
  try {
    serverStatus.textContent = '停止中...';
    serverStatus.className = 'status-text';
    await invoke('stop_server');
    setTimeout(checkServerStatus, 1000);
  } catch (error) {
    serverStatus.textContent = '停止失败';
    serverStatus.className = 'status-text offline';
    alert('停止失败: ' + error);
  }
});

async function checkServerStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${SERVER_URL}/messages`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      serverStatus.textContent = '运行中';
      serverStatus.className = 'status-text online';
    } else {
      serverStatus.textContent = '异常';
      serverStatus.className = 'status-text offline';
    }
  } catch (error) {
    serverStatus.textContent = '未启动';
    serverStatus.className = 'status-text offline';
  }
}

// 更新在线用户
async function updateOnlineUsers() {
  try {
    const response = await fetch(`${SERVER_URL}/messages`);
    const data = await response.json();
    const users = data.users || [];

    if (users.length > 0) {
      onlineUsersEl.textContent = '在线: ' + users.join(', ');
      onlineUsersEl.className = 'online-users online';
    } else {
      onlineUsersEl.textContent = '无在线用户';
      onlineUsersEl.className = 'online-users';
    }
  } catch (error) {
    onlineUsersEl.textContent = '离线';
    onlineUsersEl.className = 'online-users';
  }
}

// 发送消息
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  try {
    const response = await fetch(`${SERVER_URL}/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (response.ok) {
      inputEl.value = '';
    }
  } catch (error) {
    console.error('发送失败:', error);
  }
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// 添加消息到界面
function addMessage(msg) {
  const div = document.createElement('div');
  const isUser = msg.from === 'user';
  div.className = `msg ${isUser ? 'user' : 'other'}`;
  div.dataset.id = msg.id;
  div.dataset.from = msg.from;

  const label = isUser ? '👤 你' : `🤖 ${msg.from}`;

  // 渲染Markdown内容
  let renderedText = '';
  try {
    if (typeof marked !== 'undefined') {
      renderedText = marked.parse(msg.text);
    } else {
      renderedText = escapeHtml(msg.text);
    }
  } catch (e) {
    renderedText = escapeHtml(msg.text);
  }

  div.innerHTML = `<div class="meta">${label}</div><div class="bubble">${renderedText}</div>`;

  // 用户消息添加右键菜单
  if (isUser) {
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, msg.id, msg.text);
    });
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 右键菜单
function showContextMenu(e, msgId, msgText) {
  // 移除现有菜单
  const existingMenu = document.querySelector('.context-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  // 编辑按钮
  const editItem = document.createElement('div');
  editItem.className = 'context-menu-item';
  editItem.textContent = '✏️ 编辑';
  editItem.onclick = () => {
    menu.remove();
    editMessage(msgId, msgText);
  };

  // 删除按钮
  const deleteItem = document.createElement('div');
  deleteItem.className = 'context-menu-item danger';
  deleteItem.textContent = '🗑️ 删除';
  deleteItem.onclick = () => {
    menu.remove();
    deleteMessage(msgId);
  };

  menu.appendChild(editItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    });
  }, 100);
}

// 编辑消息
async function editMessage(msgId, oldText) {
  const newText = prompt('编辑消息:', oldText);
  if (newText === null || newText === oldText) return;

  try {
    const response = await fetch(`${SERVER_URL}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msgId, from: 'user', text: newText })
    });

    const data = await response.json();
    if (data.error) {
      alert('编辑失败: ' + data.error);
    }
  } catch (error) {
    alert('编辑失败: ' + error.message);
  }
}

// 删除消息
async function deleteMessage(msgId) {
  if (!confirm('确定要删除这条消息吗？')) return;

  try {
    const response = await fetch(`${SERVER_URL}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: msgId, from: 'user' })
    });

    const data = await response.json();
    if (data.error) {
      alert('删除失败: ' + data.error);
    }
  } catch (error) {
    alert('删除失败: ' + error.message);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 加载历史消息
async function loadHistory() {
  try {
    const response = await fetch(`${SERVER_URL}/messages`);
    const data = await response.json();
    data.messages.forEach(addMessage);
  } catch (error) {
    console.error('加载历史消息失败:', error);
  }
}

// SSE 实时连接
function connectSSE() {
  const eventSource = new EventSource(`${SERVER_URL}/sse`);

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'message') {
      addMessage(data);
    } else if (data.type === 'message_update') {
      // 更新消息内容
      const msgEl = document.querySelector(`[data-id="${data.id}"]`);
      if (msgEl) {
        const bubble = msgEl.querySelector('.bubble');
        if (bubble) {
          try {
            if (typeof marked !== 'undefined') {
              bubble.innerHTML = marked.parse(data.text);
            } else {
              bubble.textContent = data.text;
            }
          } catch (e) {
            bubble.textContent = data.text;
          }
        }
      }
    } else if (data.type === 'message_delete') {
      // 删除消息
      const msgEl = document.querySelector(`[data-id="${data.id}"]`);
      if (msgEl) msgEl.remove();
    } else if (data.type === 'clear') {
      // 清空消息
      messagesEl.innerHTML = '';
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(connectSSE, 3000);
  };
}

// 初始化
window.addEventListener('DOMContentLoaded', async () => {
  await loadHistory();
  connectSSE();
  updateOnlineUsers();
  inputEl.focus();

  // 每30秒更新在线用户
  setInterval(updateOnlineUsers, 30000);
});
