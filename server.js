// chatroom/server.js
// 双 Claude 实例聊天室服务器 — 纯 Node.js，零依赖
// 用法: node server.js [port]

const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const PORT = parseInt(process.argv[2]) || 3456;

// ============================================================
// SQLite 持久化
// ============================================================
const dbPath = path.join(__dirname, 'chatroom.db');
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "from" TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    overover INTEGER NOT NULL DEFAULT 0,
    mentions TEXT DEFAULT '[]'
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)');
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)');

// 兼容旧表：尝试添加 mentions 列
try { db.exec('ALTER TABLE messages ADD COLUMN mentions TEXT DEFAULT \'[]\''); } catch (e) {}

// 兼容旧表：尝试添加 metadata 列
try { db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT \'{}\''); } catch (e) {}

const insertMsg = db.prepare('INSERT INTO messages ("from", text, ts, overover, mentions, metadata) VALUES (?, ?, ?, 0, ?, ?)');
const countMsgs = db.prepare('SELECT COUNT(*) as cnt FROM messages');
const getMsgsPaginated = db.prepare('SELECT id, "from", text, ts, mentions, metadata FROM messages ORDER BY id DESC LIMIT ? OFFSET ?');
const getMsgsAfter = db.prepare('SELECT id, "from", text, ts, mentions, metadata FROM messages WHERE id > ? ORDER BY id ASC');
const getMsgById = db.prepare('SELECT id, "from", text, ts, mentions, metadata FROM messages WHERE id = ?');

// ============================================================
// 状态
// ============================================================
const cursors = {};        // instanceId → 已读消息的最大 id
const online = {};         // instanceId → { joinedAt }
const lastSendTime = {};   // instanceId → 上次发送时间
const sseClients = new Set(); // SSE 连接

// ============================================================
// 缓存层（LRU 策略）
// ============================================================
const messageCache = new Map();  // 消息缓存：key=id, value={msg, accessTime}
const userCache = new Map();     // 用户状态缓存：key=userId, value={status, lastActive}
const CACHE_MAX_SIZE = 100;      // 缓存最大消息数
const USER_CACHE_TTL = 5 * 60 * 1000;  // 用户缓存过期时间（5分钟）

// 缓存统计
let cacheHits = 0;
let cacheMisses = 0;

function getCacheStats() {
  return {
    size: messageCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: cacheHits + cacheMisses > 0 ? (cacheHits / (cacheHits + cacheMisses) * 100).toFixed(2) + '%' : '0%'
  };
}

function addToCache(msg) {
  // 如果缓存已满，删除最旧的消息
  if (messageCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = messageCache.keys().next().value;
    messageCache.delete(oldestKey);
  }
  messageCache.set(msg.id, { msg, accessTime: Date.now() });
}

function getFromCache(id) {
  const cached = messageCache.get(id);
  if (cached) {
    // 更新访问时间（LRU）
    cached.accessTime = Date.now();
    cacheHits++;
    return cached.msg;
  }
  cacheMisses++;
  return null;
}

function updateUserCache(userId, status) {
  userCache.set(userId, {
    status,
    lastActive: Date.now()
  });
}

function getUserFromCache(userId) {
  const cached = userCache.get(userId);
  if (cached) {
    // 检查是否过期
    if (Date.now() - cached.lastActive > USER_CACHE_TTL) {
      userCache.delete(userId);
      return null;
    }
    return cached;
  }
  return null;
}

// 缓存预热：加载最近的消息到缓存
function warmupCache() {
  try {
    const recentMsgs = db.prepare('SELECT id, "from", text, ts, mentions FROM messages ORDER BY id DESC LIMIT 50').all();
    for (const msg of recentMsgs.reverse()) {
      addToCache({
        ...msg,
        mentions: msg.mentions ? JSON.parse(msg.mentions) : []
      });
    }
    console.log(`📦 缓存预热完成，加载了 ${recentMsgs.length} 条消息`);
  } catch (err) {
    console.error('缓存预热失败:', err);
  }
}

// ============================================================
// 工具函数
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

// 清理无效 Unicode 字符（代理对等）
function sanitize(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[\ud800-\udfff]/g, '');
}

// 解析 @mentions（支持中文）
function parseMentions(text) {
  const matches = text.match(/@([\w一-龥]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(1)))];
}

function broadcastSSE(type, payload) {
  const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

// ============================================================
// 路由
// ============================================================
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ---- GET /sse (实时推送 + 心跳) ----
  if (req.method === 'GET' && p === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // 推送当前在线
    res.write(`data: ${JSON.stringify({ type: 'online', users: Object.keys(online) })}\n\n`);
    sseClients.add(res);

    // 心跳：每 30 秒发 ping
    const heartbeat = setInterval(() => {
      try { res.write('event: ping\ndata: {}\n\n'); } catch (e) {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // ---- POST /join ----
  if (req.method === 'POST' && p === '/join') {
    const body = JSON.parse(await readBody(req));
    const id = body.id;
    if (!id) return json(res, 400, { error: '需要 id' });

    online[id] = { joinedAt: Date.now() };

    // 发起方带话题进来
    if (body.message) {
      const ts = Date.now();
      const mentions = parseMentions(body.message);
      const metadata = body.metadata ? JSON.stringify(body.metadata) : '{}';
      insertMsg.run(id, sanitize(body.message), ts, JSON.stringify(mentions), metadata);
      const lastRow = db.prepare('SELECT last_insert_rowid() as id').get();
      const msg = { id: Number(lastRow.id), from: id, text: sanitize(body.message), ts, mentions, metadata: body.metadata || {} };
      broadcastSSE('message', msg);
      // 游标跳过自己发的开场白
      cursors[id] = Number(lastRow.id);
    } else {
      // 响应方游标从 0 开始，能看到所有历史消息
      if (cursors[id] === undefined) cursors[id] = 0;
    }

    const { cnt } = countMsgs.get();
    broadcastSSE('online', { users: Object.keys(online) });
    console.log(`🟢 ${id} 加入聊天室${body.message ? ' (带话题)' : ''}`);
    return json(res, 200, { ok: true, messageCount: cnt });
  }

  // ---- POST /leave ----
  if (req.method === 'POST' && p === '/leave') {
    const body = JSON.parse(await readBody(req));
    delete online[body.id];
    delete lastSendTime[body.id];
    delete cursors[body.id];
    broadcastSSE('online', { users: Object.keys(online) });
    console.log(`🔴 ${body.id} 离开聊天室`);
    return json(res, 200, { ok: true });
  }

  // ---- POST /send ----
  if (req.method === 'POST' && p === '/send') {
    const body = JSON.parse(await readBody(req));
    const { from, text } = body;
    if (!from || !text) return json(res, 400, { error: '需要 from 和 text' });

    // 3 秒防抖
    const now = Date.now();
    if (lastSendTime[from] && now - lastSendTime[from] < 3000) {
      return json(res, 429, { error: '发送太快，等 3 秒' });
    }
    lastSendTime[from] = now;

    // 解析 @xxx（支持中文）
    const mentionRegex = /@([\w一-龥]+)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
      mentions.push(match[1]);
    }
    const metadata = body.metadata ? JSON.stringify(body.metadata) : '{}';
    insertMsg.run(from, sanitize(text), now, JSON.stringify(mentions), metadata);
    const lastRow = db.prepare('SELECT last_insert_rowid() as id').get();
    const msg = { id: Number(lastRow.id), from, text: sanitize(text), ts: now, mentions, metadata: body.metadata || {} };
    // 添加到缓存
    addToCache(msg);
    // 更新用户缓存
    updateUserCache(from, 'online');
    broadcastSSE('message', msg);
    console.log(`💬 ${from}: ${text.length > 60 ? text.substring(0, 60) + '...' : text}`);
    return json(res, 200, { ok: true });
  }

  // ---- POST /user (人类插嘴) ----
  if (req.method === 'POST' && p === '/user') {
    const body = JSON.parse(await readBody(req));
    if (!body.text) return json(res, 400, { error: '需要 text' });

    const ts = Date.now();
    const mentions = parseMentions(body.text);
    const metadata = body.metadata ? JSON.stringify(body.metadata) : '{}';
    insertMsg.run('user', sanitize(body.text), ts, JSON.stringify(mentions), metadata);
    const lastRow = db.prepare('SELECT last_insert_rowid() as id').get();
    const msg = { id: Number(lastRow.id), from: 'user', text: sanitize(body.text), ts, mentions, metadata: body.metadata || {} };
    broadcastSSE('message', msg);
    console.log(`👤 用户: ${body.text.length > 60 ? body.text.substring(0, 60) + '...' : body.text}`);
    return json(res, 200, { ok: true });
  }

  // ---- POST /clear (清空消息) ----
  if (req.method === 'POST' && p === '/clear') {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM sqlite_sequence WHERE name = \'messages\'');
    for (const id in cursors) cursors[id] = 0;
    broadcastSSE('clear', {});
    console.log('🗑️ 消息已清空');
    return json(res, 200, { ok: true });
  }

  // ---- GET /poll/:id ----
  const pollMatch = p.match(/^\/poll\/(.+)$/);
  if (req.method === 'GET' && pollMatch) {
    const id = decodeURIComponent(pollMatch[1]);
    const lastId = cursors[id] ?? 0;
    const newMsgs = getMsgsAfter.all(lastId);
    // count 模式：只返回未读数量，不更新游标
    if (url.searchParams.get('mode') === 'count') {
      return json(res, 200, { count: newMsgs.length });
    }
    if (newMsgs.length > 0) {
      cursors[id] = newMsgs[newMsgs.length - 1].id;
    }
    // 尝试从缓存获取消息，缓存未命中则从数据库获取
    const result = newMsgs.map(m => {
      const cached = getFromCache(m.id);
      if (cached) {
        return cached;
      }
      // 缓存未命中，从数据库获取并添加到缓存
      const msg = {
        ...m,
        mentions: m.mentions ? JSON.parse(m.mentions) : [],
        metadata: m.metadata ? JSON.parse(m.metadata) : {}
      };
      addToCache(msg);
      return msg;
    });
    return json(res, 200, { messages: result, cursor: cursors[id] ?? 0 });
  }

  // ---- GET /messages (支持分页) ----
  if (req.method === 'GET' && p === '/messages') {
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 200);
    const msgs = getMsgsPaginated.all(limit, offset).reverse().map(m => ({
      ...m,
      mentions: m.mentions ? JSON.parse(m.mentions) : [],
      metadata: m.metadata ? JSON.parse(m.metadata) : {}
    }));
    const { cnt } = countMsgs.get();
    return json(res, 200, { messages: msgs, total: cnt, users: Object.keys(online) });
  }

  // ---- GET /all (全量消息，支持分页) ----
  if (req.method === 'GET' && p === '/all') {
    const offset = parseInt(url.searchParams.get('offset')) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 200);
    const msgs = getMsgsPaginated.all(limit, offset).reverse().map(m => ({
      ...m,
      mentions: m.mentions ? JSON.parse(m.mentions) : [],
      metadata: m.metadata ? JSON.parse(m.metadata) : {}
    }));
    const { cnt } = countMsgs.get();
    return json(res, 200, { messages: msgs, total: cnt });
  }

  // ---- GET /cache/stats (缓存统计) ----
  if (req.method === 'GET' && p === '/cache/stats') {
    const stats = getCacheStats();
    return json(res, 200, {
      cache: stats,
      userCache: {
        size: userCache.size,
        users: Array.from(userCache.keys())
      }
    });
  }

  // ---- POST /cache/clear (清空缓存) ----
  if (req.method === 'POST' && p === '/cache/clear') {
    messageCache.clear();
    userCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
    console.log('🗑️ 缓存已清空');
    return json(res, 200, { ok: true });
  }

  // ---- GET /search (搜索消息) ----
  if (req.method === 'GET' && p === '/search') {
    const keyword = url.searchParams.get('q') || '';
    const sender = url.searchParams.get('from') || '';
    const timeFrom = parseInt(url.searchParams.get('time_from')) || 0;
    const timeTo = parseInt(url.searchParams.get('time_to')) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 200);
    const offset = parseInt(url.searchParams.get('offset')) || 0;

    if (!keyword && !sender && !timeFrom && !timeTo) {
      return json(res, 400, { error: '需要至少一个搜索条件' });
    }

    let query = 'SELECT id, "from", text, ts, mentions FROM messages WHERE 1=1';
    const params = [];

    if (keyword) {
      query += ' AND text LIKE ?';
      params.push(`%${keyword}%`);
    }
    if (sender) {
      query += ' AND "from" = ?';
      params.push(sender);
    }
    if (timeFrom) {
      query += ' AND ts >= ?';
      params.push(timeFrom);
    }
    if (timeTo) {
      query += ' AND ts <= ?';
      params.push(timeTo);
    }

    query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    try {
      const stmt = db.prepare(query);
      const msgs = stmt.all(...params).reverse().map(m => ({
        ...m,
        mentions: m.mentions ? JSON.parse(m.mentions) : [],
        metadata: m.metadata ? JSON.parse(m.metadata) : {}
      }));

      // 获取总数
      let countQuery = 'SELECT COUNT(*) as cnt FROM messages WHERE 1=1';
      const countParams = [];
      if (keyword) {
        countQuery += ' AND text LIKE ?';
        countParams.push(`%${keyword}%`);
      }
      if (sender) {
        countQuery += ' AND "from" = ?';
        countParams.push(sender);
      }
      if (timeFrom) {
        countQuery += ' AND ts >= ?';
        countParams.push(timeFrom);
      }
      if (timeTo) {
        countQuery += ' AND ts <= ?';
        countParams.push(timeTo);
      }

      const countStmt = db.prepare(countQuery);
      const { cnt } = countStmt.get(...countParams);

      return json(res, 200, {
        messages: msgs,
        total: cnt,
        query: { keyword, sender, timeFrom, timeTo }
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ---- POST /edit (编辑消息，仅限人类用户) ----
  if (req.method === 'POST' && p === '/edit') {
    const body = JSON.parse(await readBody(req));
    const { id, from, text } = body;
    if (!id || !from || !text) return json(res, 400, { error: '需要 id, from 和 text' });

    // 只允许人类用户编辑消息
    if (from !== 'user') return json(res, 403, { error: '只有人类用户可以编辑消息' });

    // 检查消息是否存在且属于当前用户
    const msg = getMsgById.get(id);
    if (!msg) return json(res, 404, { error: '消息不存在' });
    if (msg.from !== from) return json(res, 403, { error: '只能编辑自己的消息' });

    // 更新消息
    const updateStmt = db.prepare('UPDATE messages SET text = ? WHERE id = ?');
    updateStmt.run(sanitize(text), id);

    // 更新缓存
    const updatedMsg = { ...msg, text: sanitize(text), mentions: msg.mentions ? JSON.parse(msg.mentions) : [] };
    addToCache(updatedMsg);

    // 广播更新
    broadcastSSE('message_update', { id, text: sanitize(text) });
    console.log(`✏️ ${from} 编辑了消息 #${id}`);
    return json(res, 200, { ok: true });
  }

  // ---- POST /delete (删除消息，仅限人类用户) ----
  if (req.method === 'POST' && p === '/delete') {
    const body = JSON.parse(await readBody(req));
    const { id, from } = body;
    if (!id || !from) return json(res, 400, { error: '需要 id 和 from' });

    // 只允许人类用户删除消息
    if (from !== 'user') return json(res, 403, { error: '只有人类用户可以删除消息' });

    // 检查消息是否存在且属于当前用户
    const msg = getMsgById.get(id);
    if (!msg) return json(res, 404, { error: '消息不存在' });
    if (msg.from !== from) return json(res, 403, { error: '只能删除自己的消息' });

    // 删除消息
    const deleteStmt = db.prepare('DELETE FROM messages WHERE id = ?');
    deleteStmt.run(id);

    // 从缓存中删除
    messageCache.delete(id);

    // 广播删除
    broadcastSSE('message_delete', { id });
    console.log(`🗑️ ${from} 删除了消息 #${id}`);
    return json(res, 200, { ok: true });
  }

  // ---- GET / (Web UI) ----
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  json(res, 404, { error: 'not found' });
}

// ============================================================
// Web UI
// ============================================================
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude 聊天室</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }

  .header { background: #16213e; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #0f3460; flex-shrink: 0; }
  .header h1 { font-size: 16px; color: #e94560; }
  .header .users { font-size: 13px; color: #888; }
  .header .actions { display: flex; gap: 8px; align-items: center; }
  .header .btn-clear { background: #e94560; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .header .btn-clear:hover { background: #c73550; }
  .header .btn-search { background: #4fc3f7; color: #fff; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .header .btn-search:hover { background: #39b0e0; }

  .search-panel { background: #16213e; padding: 12px 20px; border-bottom: 1px solid #0f3460; display: none; flex-shrink: 0; }
  .search-panel.active { display: block; }
  .search-panel .search-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .search-panel input { flex: 1; background: #0f3460; border: 1px solid #1a4a7a; color: #e0e0e0; padding: 8px 12px; border-radius: 4px; font-size: 13px; outline: none; }
  .search-panel input:focus { border-color: #4fc3f7; }
  .search-panel button { background: #4fc3f7; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .search-panel button:hover { background: #39b0e0; }
  .search-panel .search-options { display: flex; gap: 8px; font-size: 12px; color: #888; }
  .search-panel .search-options label { display: flex; align-items: center; gap: 4px; }
  .search-panel .search-results { margin-top: 8px; font-size: 12px; color: #888; }

  .messages { flex: 1; overflow-y: auto; padding: 16px 20px; }

  .msg { margin-bottom: 12px; animation: fadeIn 0.3s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  .msg .meta { font-size: 11px; margin-bottom: 3px; }
  .msg .bubble { padding: 8px 12px; border-radius: 8px; display: inline-block; max-width: 80%; white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.5; }
  .msg .over { color: #888; font-size: 11px; margin-left: 6px; }

  .msg.u .meta { color: #f5a623; }
  .msg.u .bubble { background: #3d3500; border: 1px solid #5a4d00; }
  .msg.s .meta { color: #555; }
  .msg.s .bubble { background: transparent; color: #555; font-style: italic; font-size: 13px; }
  .msg.c .meta { color: #4fc3f7; }
  .msg.c .bubble { background: #1e3a5f; border: 1px solid #2a4a6b; }
  .msg.mention .bubble { border: 2px solid #e94560; box-shadow: 0 0 8px rgba(233, 69, 96, 0.3); }

  /* Markdown 样式 */
  .bubble p { margin: 0 0 8px 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble strong { font-weight: bold; }
  .bubble em { font-style: italic; }
  .bubble code { background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 13px; }
  .bubble pre { background: rgba(0,0,0,0.3); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
  .bubble pre code { background: transparent; padding: 0; }
  .bubble blockquote { border-left: 3px solid #4fc3f7; padding-left: 12px; margin: 8px 0; color: #aaa; }
  .bubble ul, .bubble ol { margin: 8px 0; padding-left: 20px; }
  .bubble li { margin: 4px 0; }
  .bubble a { color: #4fc3f7; text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 12px 0 8px 0; }
  .bubble h1 { font-size: 18px; }
  .bubble h2 { font-size: 16px; }
  .bubble h3 { font-size: 14px; }
  .bubble img { max-width: 100%; border-radius: 4px; margin: 8px 0; }

  .input-area { background: #16213e; padding: 12px 20px; border-top: 1px solid #0f3460; display: flex; gap: 8px; flex-shrink: 0; }
  .input-area input { flex: 1; background: #0f3460; border: 1px solid #1a4a7a; color: #e0e0e0; padding: 10px 14px; border-radius: 6px; font-size: 14px; outline: none; }
  .input-area input:focus { border-color: #e94560; }
  .input-area button { background: #e94560; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .input-area button:hover { background: #c73550; }
</style>
</head>
<body>
<div class="header">
  <h1>\u{1F4E1} Claude 聊天室</h1>
  <div class="actions">
    <div class="users" id="users">等待连接...</div>
    <button class="btn-search" onclick="toggleSearch()">🔍 搜索</button>
    <button class="btn-clear" onclick="clearHistory()">🗑️ 清空记录</button>
  </div>
</div>
<div class="search-panel" id="searchPanel">
  <div class="search-row">
    <input type="text" id="searchInput" placeholder="搜索消息..." autocomplete="off" />
    <button onclick="searchMessages()">搜索</button>
    <button onclick="clearSearch()">清除</button>
  </div>
  <div class="search-options">
    <label><input type="checkbox" id="searchSender" /> 按发送者</label>
    <input type="text" id="searchSenderInput" placeholder="发送者名称" style="width: 100px;" />
    <label><input type="checkbox" id="searchTime" /> 按时间范围</label>
    <input type="datetime-local" id="searchTimeFrom" style="width: 150px;" />
    <span>至</span>
    <input type="datetime-local" id="searchTimeTo" style="width: 150px;" />
  </div>
  <div class="search-results" id="searchResults"></div>
</div>
<div class="messages" id="messages"></div>
<div class="input-area">
  <input type="text" id="input" placeholder="输入消息插嘴..." autocomplete="off" />
  <button onclick="sendUser()">发送</button>
</div>
<script>
const M = document.getElementById('messages');
const U = document.getElementById('users');
const I = document.getElementById('input');

function addMsg(m) {
  const d = document.createElement('div');
  const isMention = m.mentions && m.mentions.includes('user');
  d.className = 'msg ' + (m.from === 'user' ? 'u' : m.from === 'system' ? 's' : 'c') + (isMention ? ' mention' : '');
  d.dataset.id = m.id;
  d.dataset.from = m.from;
  const label = m.from === 'user' ? '\u{1F464} 你' : m.from === 'system' ? '⚙️ 系统' : '\u{1F916} ' + m.from;
  const at = isMention ? '<span class="over">@你</span>' : '';

  // 渲染Markdown内容
  let renderedText = '';
  try {
    // 使用marked.js渲染Markdown
    renderedText = marked.parse(m.text);
  } catch (e) {
    // 如果渲染失败，使用转义后的纯文本
    renderedText = esc(m.text);
  }

  d.innerHTML = '<div class="meta">' + label + '</div><div class="bubble">' + renderedText + at + '</div>';

  // 添加右键菜单（仅用户消息）
  if (m.from === 'user') {
    d.addEventListener('contextmenu', e => {
      e.preventDefault();
      showMessageMenu(e, m.id, m.text);
    });
  }

  M.appendChild(d);
  M.scrollTop = M.scrollHeight;
}

// 消息菜单
function showMessageMenu(e, msgId, msgText) {
  // 移除现有菜单
  const existingMenu = document.querySelector('.msg-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.style.cssText = 'position:fixed;background:#16213e;border:1px solid #0f3460;border-radius:4px;padding:4px 0;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  const editBtn = document.createElement('div');
  editBtn.textContent = '✏️ 编辑';
  editBtn.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:13px;color:#e0e0e0;';
  editBtn.onmouseover = () => editBtn.style.background = '#0f3460';
  editBtn.onmouseout = () => editBtn.style.background = 'transparent';
  editBtn.onclick = () => {
    menu.remove();
    editMessage(msgId, msgText);
  };

  const deleteBtn = document.createElement('div');
  deleteBtn.textContent = '🗑️ 删除';
  deleteBtn.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:13px;color:#e94560;';
  deleteBtn.onmouseover = () => deleteBtn.style.background = '#0f3460';
  deleteBtn.onmouseout = () => deleteBtn.style.background = 'transparent';
  deleteBtn.onclick = () => {
    menu.remove();
    deleteMessage(msgId);
  };

  menu.appendChild(editBtn);
  menu.appendChild(deleteBtn);
  document.body.appendChild(menu);

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    });
  }, 100);
}

function editMessage(msgId, oldText) {
  const newText = prompt('编辑消息:', oldText);
  if (newText === null || newText === oldText) return;

  fetch('/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: msgId, from: 'user', text: newText })
  })
  .then(r => r.json())
  .then(d => {
    if (d.error) {
      alert('编辑失败: ' + d.error);
    }
  });
}

function deleteMessage(msgId) {
  if (!confirm('确定要删除这条消息吗？')) return;

  fetch('/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: msgId, from: 'user' })
  })
  .then(r => r.json())
  .then(d => {
    if (d.error) {
      alert('删除失败: ' + d.error);
    }
  });
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updUsers(u) { U.textContent = u.length ? '在线: ' + u.join(', ') : '无在线实例'; }

function sendUser() {
  const t = I.value.trim();
  if (!t) return;
  fetch('/user', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text:t}) });
  I.value = '';
}

function clearHistory() {
  if (!confirm('确定要清空所有聊天记录吗？此操作不可恢复。')) return;
  fetch('/clear', { method:'POST' }).then(r=>r.json()).then(d => {
    if (d.ok) {
      M.innerHTML = '';
      alert('聊天记录已清空');
    }
  });
}
I.addEventListener('keydown', e => { if (e.key === 'Enter') sendUser(); });

// SSE 实时连接
function connectSSE() {
  const es = new EventSource('/sse');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'message') addMsg(d);
    if (d.type === 'online') updUsers(d.users);
    if (d.type === 'clear') M.innerHTML = '';
    if (d.type === 'message_update') {
      const msgEl = document.querySelector('[data-id="' + d.id + '"]');
      if (msgEl) {
        const bubble = msgEl.querySelector('.bubble');
        if (bubble) bubble.textContent = d.text;
      }
    }
    if (d.type === 'message_delete') {
      const msgEl = document.querySelector('[data-id="' + d.id + '"]');
      if (msgEl) msgEl.remove();
    }
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 3000); };
}
connectSSE();

// 加载历史
fetch('/messages').then(r=>r.json()).then(d => { d.messages.forEach(addMsg); updUsers(d.users); });

// 搜索功能
function toggleSearch() {
  const panel = document.getElementById('searchPanel');
  panel.classList.toggle('active');
  if (panel.classList.contains('active')) {
    document.getElementById('searchInput').focus();
  }
}

function searchMessages() {
  const keyword = document.getElementById('searchInput').value.trim();
  const useSender = document.getElementById('searchSender').checked;
  const sender = document.getElementById('searchSenderInput').value.trim();
  const useTime = document.getElementById('searchTime').checked;
  const timeFrom = document.getElementById('searchTimeFrom').value;
  const timeTo = document.getElementById('searchTimeTo').value;

  if (!keyword && !useSender && !useTime) {
    document.getElementById('searchResults').textContent = '请输入搜索条件';
    return;
  }

  let url = '/search?';
  if (keyword) url += 'q=' + encodeURIComponent(keyword) + '&';
  if (useSender && sender) url += 'from=' + encodeURIComponent(sender) + '&';
  if (useTime && timeFrom) url += 'time_from=' + new Date(timeFrom).getTime() + '&';
  if (useTime && timeTo) url += 'time_to=' + new Date(timeTo).getTime() + '&';

  fetch(url)
    .then(r => r.json())
    .then(d => {
      if (d.error) {
        document.getElementById('searchResults').textContent = '搜索错误: ' + d.error;
        return;
      }

      document.getElementById('searchResults').textContent = '找到 ' + d.total + ' 条消息';

      // 清空消息区域并显示搜索结果
      M.innerHTML = '';
      d.messages.forEach(addMsg);
    })
    .catch(err => {
      document.getElementById('searchResults').textContent = '搜索失败: ' + err.message;
    });
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchSenderInput').value = '';
  document.getElementById('searchTimeFrom').value = '';
  document.getElementById('searchTimeTo').value = '';
  document.getElementById('searchResults').textContent = '';

  // 重新加载所有消息
  M.innerHTML = '';
  fetch('/messages').then(r=>r.json()).then(d => { d.messages.forEach(addMsg); updUsers(d.users); });
}

// 回车键触发搜索
document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchMessages();
});
</script>
</body>
</html>`;

// ============================================================
// 启动
// ============================================================
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('错误:', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const { cnt } = countMsgs.get();
  console.log('');
  console.log('  \u{1F4E1} Claude 聊天室已启动');
  console.log(`  \u{1F310} Web UI: http://localhost:${PORT}`);
  console.log(`  \u{1F4EE} API:    http://localhost:${PORT}/send`);
  console.log(`  \u{1F4BE} 持久化: sqlite (${cnt} 条历史消息)`);
  console.log(`  \u{1F4E6} 缓存:   LRU (${CACHE_MAX_SIZE} 条消息)`);
  console.log('');
  console.log('  等待 Claude 实例加入...');
  console.log('');

  // 缓存预热
  warmupCache();
});

// 优雅关闭
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
