// 旅游攻略协作应用 —— 零依赖 Node 服务（MVP：房间协作 + 自动导航 + 合并审阅）v=20260807a
// 仅使用 Node 内置模块，无需 npm install，适配受限网络环境。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 小时
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit_log.json');
const AUDIT_MAX_ENTRIES = 10000;
const AUDIT_RETENTION_DAYS = 90;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_DEPLOY_VER = '20260808c';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- 加载 .env（无依赖手动解析，用于注入密钥，避免写死在源码）----
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* ignore */ }
}
loadEnvFile();

// ---- 会话持久化 ----
let sessions = {}; // token -> { name, role, expires }
const NOW = Date.now();
if (fs.existsSync(SESSIONS_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    // 启动时清理过期会话
    for (const [tok, s] of Object.entries(raw)) {
      if (s.expires && s.expires > NOW) sessions[tok] = s;
    }
    if (Object.keys(sessions).length < Object.keys(raw).length) {
      console.log(`会话清理：${Object.keys(raw).length - Object.keys(sessions).length} 条过期已清除`);
    }
  } catch (e) { sessions = {}; }
}
function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch (e) {}
}

// ---- 审计日志 ----
let auditEntries = [];
if (fs.existsSync(AUDIT_LOG_FILE)) {
  try { auditEntries = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, 'utf8')); } catch (e) { auditEntries = []; }
}
function saveAuditLog() {
  try { fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(auditEntries, null, 2)); } catch (e) {}
}
function auditLog(user, action, room, detail, ok, req) {
  const entry = {
    id: uid(),
    ts: Date.now(),
    user: user || '未知',
    action,
    room: room || null,
    detail: detail || {},
    ip: (req && req.socket && req.socket.remoteAddress) || null,
    ok: ok !== false
  };
  auditEntries.push(entry);
  // 超过上限清理最旧 1000 条
  if (auditEntries.length > AUDIT_MAX_ENTRIES) {
    auditEntries = auditEntries.slice(1000);
  }
  // 清理超过保留期的条目
  const cutoff = Date.now() - AUDIT_RETENTION_DAYS * 86400000;
  auditEntries = auditEntries.filter(e => e.ts >= cutoff);
  saveAuditLog();
}

let rooms = {};
if (fs.existsSync(ROOMS_FILE)) {
  try { rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')); } catch (e) { rooms = {}; }
}

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}

// 用户账号（首次启动时自动初始化）
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = {}; }
}
// 把账单里的付款人 / 分摊人归一为出行人标准写法（大小写 / 空格无关）。
// 出行人是唯一权威：账单里的人名若与某出行人"仅大小写/空格不同"，替换为出行人标准写法；
// 若找不到任何匹配（真·陌生人），从分摊剔除 / 付款人置空。
function canonicalizeExpenses(r) {
  const people = r.people || [];
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const canon = {};
  people.forEach(p => { canon[norm(p)] = p; });
  (r.expenses || []).forEach(e => {
    if (e.payer) {
      const c = canon[norm(e.payer)];
      e.payer = c || '';
    }
    if (Array.isArray(e.splitAmong)) {
      e.splitAmong = e.splitAmong.map(p => canon[norm(p)] || null).filter(Boolean);
    }
  });
}
// 迁移已有房间：添加 people / expenses 字段
Object.values(rooms).forEach(r => {
  if (!r.expenses) r.expenses = [];
  // 只有 people 为空时才从已有行程/费用数据自动填充（管理员手动设置的优先）
  if (!r.people || r.people.length === 0) {
    r.people = [];
    (r.items || []).forEach(it => { if (it.creator && it.creator !== '匿名' && !r.people.includes(it.creator)) r.people.push(it.creator); });
    (r.expenses || []).forEach(e => {
      if (e.payer && !r.people.includes(e.payer)) r.people.push(e.payer);
      if (e.createdBy && !r.people.includes(e.createdBy)) r.people.push(e.createdBy);
      (e.splitAmong || []).forEach(p => { if (p && !r.people.includes(p)) r.people.push(p); });
    });
  }
  // 强制不变量：出行人是唯一权威，账单的付款人 / 分摊人必须与出行人标准写法一致（大小写无关）
  canonicalizeExpenses(r);
});

// 已知弱口令（用于一次性升级，避免源码/磁盘上残留 123456 / admin2026）
const LEGACY_WEAK_PASSWORDS = new Set(['admin2026', '123456']);

function ensureDefaultUsers() {
  const defaults = {
    '景杰克': { password: process.env.ADMIN_PASSWORD || 'Admin@2026-ChangeMe', role: 'admin' },
    '张钰杰': { password: process.env.USER_PASSWORD || 'User@2026-ChangeMe', role: 'user' },
    '张钰晨': { password: process.env.USER_PASSWORD || 'User@2026-ChangeMe', role: 'user' }
  };
  let changed = false;
  for (const [name, info] of Object.entries(defaults)) {
    if (!users[name]) { users[name] = info; changed = true; }
  }
  if (changed) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('已初始化默认用户账号');
  }
}

// 用环境变量中的强密码升级仍在使用弱口令的账号（幂等，不会覆盖已改密码）
function upgradeWeakPasswords() {
  const ap = process.env.ADMIN_PASSWORD;
  const up = process.env.USER_PASSWORD;
  let changed = false;
  for (const [name, info] of Object.entries(users)) {
    if (ap && info.role === 'admin' && LEGACY_WEAK_PASSWORDS.has(info.password)) { info.password = ap; changed = true; }
    if (up && info.role === 'user' && LEGACY_WEAK_PASSWORDS.has(info.password)) { info.password = up; changed = true; }
  }
  if (changed) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('已用环境变量密码升级弱口令账号');
  }
}

ensureDefaultUsers();
upgradeWeakPasswords();
function uid() { return crypto.randomBytes(6).toString('hex'); }

function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function addRoomPeople(room, ...names) {
  if (!room.people) room.people = [];
  names.forEach(n => {
    if (n && n !== '匿名' && !room.people.includes(n)) room.people.push(n);
  });
}

function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  const s = sessions[token];
  if (!s || s.expires < Date.now()) { if (s) delete sessions[token]; return null; }
  return s;
}

function requireAdmin(req, res) {
  const s = getSession(req);
  if (!s || s.role !== 'admin') {
    send(res, 403, { error: '需要管理员权限，请先登录管理员账号' });
    return false;
  }
  return true;
}
function loadSeed() {
  const candidates = [SEED_FILE, path.join(__dirname, 'data', 'seed.json')];
  for (const f of candidates) {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return { name: '我的旅行', items: [] };
}

// 启动时确保演示房间存在（带种子数据，开箱即跑）
const DEMO_ID = '2026';
if (!rooms[DEMO_ID]) {
  const seed = loadSeed();
  rooms[DEMO_ID] = {
    id: DEMO_ID,
    name: seed.name || '澳门·珠海·广州 6日游',
    items: (seed.items || []).map(it => ({ ...it, id: uid(), createdAt: Date.now() })),
    expenses: [],
    people: [],
    createdAt: Date.now()
  };
  saveRooms();
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---- 安全响应头（防点击劫持 / MIME 嗅探 / 降低 XSS 攻击面）----
function applySecurityHeaders(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // 注意：应用内大量使用 onclick 内联事件，故 script-src 暂含 'unsafe-inline'；
  // 后续可重构为 addEventListener 以收紧为 'self'。connect-src 限定同源，限制 fetch 外发。
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

// ---- 客户端真实 IP（兼容 CDN/反代 X-Forwarded-For）----
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---- 登录暴力破解防护（内存级滑动窗口限流）----
const loginAttempts = {}; // ip -> { count, first }
const LOGIN_MAX = 10;              // 15 分钟内最多尝试次数
const LOGIN_WINDOW = 15 * 60 * 1000;
function loginRateLimited(ip) {
  const now = Date.now();
  let a = loginAttempts[ip];
  if (!a || now - a.first > LOGIN_WINDOW) { a = { count: 0, first: now }; }
  a.count++;
  loginAttempts[ip] = a;
  // 定期清理，防止内存无限增长
  if (Object.keys(loginAttempts).length > 5000) {
    for (const k of Object.keys(loginAttempts)) {
      if (now - loginAttempts[k].first > LOGIN_WINDOW) delete loginAttempts[k];
    }
  }
  return a.count > LOGIN_MAX;
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.manifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  applySecurityHeaders(res);

  // HEAD 方法：按 GET 路由但丢弃响应体（让 curl -I / 健康检查拿到 200 而非 404）
  if (req.method === 'HEAD') {
    req.method = 'GET';
    const _origEnd = res.end.bind(res);
    res.end = (chunk, ...rest) => _origEnd.call(res, undefined, ...rest);
  }

  // ---------- 天气代理（Open-Meteo，免费无需 API key）----------
  if (req.method === 'GET' && p === '/api/weather') {
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const start = url.searchParams.get('start'); // YYYY-MM-DD
    const end = url.searchParams.get('end');     // YYYY-MM-DD
    if (!lat || !lng) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing lat/lng' })); }
    const https = require('https');

    function fetchWeather(sDate, eDate, callback) {
      const tgt = new URL('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
        '&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max&timezone=Asia/Shanghai' +
        (sDate && eDate ? '&start_date=' + sDate + '&end_date=' + eDate : '&forecast_days=7'));
      const wxReq = https.get(tgt, { headers: { 'User-Agent': 'TravelPlanner/1.0.0' } }, (wxRes) => {
        let body = '';
        wxRes.on('data', c => body += c);
        wxRes.on('end', () => callback(null, body, wxRes.statusCode));
      });
      wxReq.on('error', (e) => callback(e));
      wxReq.setTimeout(8000, () => { wxReq.destroy(); callback(new Error('timeout')); });
    }

    fetchWeather(start, end, (err, body, status) => {
      if (err) {
        if (!res.writableEnded) { res.writeHead(502); res.end(JSON.stringify({ error: 'weather api failed' })); }
        return;
      }
      // 检查是否日期超出 API 预报范围（免费版 16 天），若超出则截断到最远可用日期后重试
      try {
        const parsed = JSON.parse(body);
        if (parsed.error && parsed.reason && parsed.reason.includes('end_date')) {
          // 计算 API 允许的最远日期：今天 + 15 天
          const maxDate = new Date(Date.now() + 15 * 86400000);
          const maxStr = maxDate.toISOString().slice(0, 10);
          if (end > maxStr) {
            const cappedEnd = (start >= maxStr) ? maxStr : (end > maxStr ? maxStr : end);
            if (start >= cappedEnd) {
              // start 已经超出范围，返回最后可用日
              fetchWeather(cappedEnd, cappedEnd, (e2, b2) => {
                if (e2 || !b2) {
                  if (!res.writableEnded) { res.writeHead(502); res.end(JSON.stringify({ error: 'weather out of range' })); }
                  return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(b2);
              });
              return;
            }
            fetchWeather(start, cappedEnd, (e2, b2) => {
              if (e2 || !b2) {
                if (!res.writableEnded) { res.writeHead(502); res.end(JSON.stringify({ error: 'weather out of range' })); }
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(b2);
            });
            return;
          }
        }
      } catch (e) { /* ignore parse error */ }
      res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    });
    return;
  }

  // ---------- 收据照片上传/读取 ----------
  if (req.method === 'POST' && p === '/api/receipt') {
    const s = getSession(req);
    if (!s) return send(res, 401, { error: '未登录或会话已过期' });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.image || !data.image.startsWith('data:image/')) {
          return send(res, 400, { error: '需要 base64 图片数据' });
        }
        // 限制 2MB
        if (data.image.length > 2 * 1024 * 1024 + 100) {
          return send(res, 413, { error: '图片过大，请压缩后重试' });
        }
        const receiptDir = path.join(__dirname, 'data', 'receipts');
        if (!fs.existsSync(receiptDir)) fs.mkdirSync(receiptDir, { recursive: true });
        const id = uid();
        const match = data.image.match(/^data:image\/(\w+);base64,/);
        const ext = match ? match[1] : 'jpg';
        const fname = id + '.' + ext;
        const buf = Buffer.from(data.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(path.join(receiptDir, fname), buf);
        auditLog(s.name, 'receipt.upload', null, { id, size: buf.length }, false, req);
        send(res, 200, { id, url: '/api/receipt/' + fname });
      } catch (e) {
        send(res, 500, { error: '上传失败: ' + e.message });
      }
    });
    return;
  }
  if (req.method === 'GET' && p.startsWith('/api/receipt/')) {
    // 按 ID 前缀匹配，扩展名无关（jpg/png/webp 均可，兼容历史数据）
    const reqId = path.basename(p.replace('/api/receipt/', '')).replace(/\.[^.]+$/, '');
    const receiptDir = path.join(__dirname, 'data', 'receipts');
    if (!fs.existsSync(receiptDir)) { res.writeHead(404); return res.end('not found'); }
    const files = fs.readdirSync(receiptDir).filter(f => f === reqId || f.startsWith(reqId + '.'));
    if (!files.length) { res.writeHead(404); return res.end('not found'); }
    const filePath = path.join(receiptDir, files[0]);
    const ext = path.extname(files[0]);
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  // ---------- 地理编码代理 ----------
  if (req.method === 'GET' && p === '/api/geocode') {
    const q = url.searchParams.get('q');
    if (!q) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing q' })); }
    const https = require('https');
    const tgt = new URL('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=5&accept-language=zh');
    const geoReq = https.get(tgt, { headers: { 'User-Agent': 'TravelPlanner/1.0.0' } }, (geoRes) => {
      let body = '';
      geoRes.on('data', c => body += c);
      geoRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      });
    });
    geoReq.on('error', (e) => {
      if (!res.writableEnded) { res.writeHead(502); res.end(JSON.stringify({ error: 'geocoding failed: ' + e.message })); }
    });
    geoReq.setTimeout(8000, () => {
      geoReq.destroy();
      if (!res.writableEnded) { res.writeHead(504); res.end(JSON.stringify({ error: 'geocoding timeout' })); }
    });
    return;
  }

  // 当前前端部署版本，供客户端自检自愈（穿透微信缓存）
  if (req.method === 'GET' && p === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: APP_DEPLOY_VER }));
  }

  // ---------- 通用旧版本资源 301 重定向（根治微信/WebView 缓存旧 JS）----------
  // 任何旧版本号资源（app.20260807q.js / app.20260807r.js / app.20260808a.js ...）一律 301 跳到当前版。
  // 这样即使微信缓存了再老的 HTML（引用老 JS 文件名），老 JS 也会被 301 牵引到最新 JS，
  // 新代码立即生效，彻底摆脱"改了出行人账单却不同步"的缓存表象问题。
  if (req.method === 'GET') {
    const m = p.match(/^\/public\/(app|i18n|style)\.(\d{8}[a-z])\.(js|css)$/);
    if (m && m[2] !== APP_DEPLOY_VER) {
      res.writeHead(301, { 'Location': '/public/' + m[1] + '.' + APP_DEPLOY_VER + '.' + m[3], 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/public/app.js' || p === '/public/i18n.js' || p === '/public/style.css') {
      const base = p.split('/').pop();
      res.writeHead(301, { 'Location': '/public/' + base.replace(/(\.js|\.css)$/, '.' + APP_DEPLOY_VER + '$1'), 'Cache-Control': 'no-store' });
      return res.end();
    }
  }

  // ---------- 根路径版本化重定向（根治微信/WebView 缓存旧页面）----------
  // 微信按"完整 URL"缓存主文档。所有入口（含任何旧 ?v= 参数）一律 302 跳到当前版，
  // 确保刷新老标签页也会强制重新拉取最新 index.html。
  if (req.method === 'GET' && p === '/' && url.searchParams.get('v') !== APP_DEPLOY_VER) {
    res.writeHead(302, {
      'Location': '/?v=' + APP_DEPLOY_VER,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return res.end();
  }

  // ---------- 静态文件 ----------
  if (req.method === 'GET' && (p === '/' || p.startsWith('/public/'))) {
    let filePath = p === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(__dirname, p);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const isText = ['.js', '.css', '.html', '.json'].includes(ext);
      // 文本资源（HTML/JS/CSS/JSON）彻底禁用缓存，避免部署后旧版本被浏览器/PWA复用
      const headers = {
        'Content-Type': (MIME[ext] || 'text/plain') + (isText ? '; charset=utf-8' : ''),
        'Cache-Control': isText ? 'no-store, no-cache, must-revalidate' : 'public, max-age=3600',
        'Pragma': isText ? 'no-cache' : undefined,
        'Expires': isText ? '0' : undefined,
        'Vary': 'Accept-Encoding'
      };
      // gzip 压缩文本文件（>1KB 才压缩，小文件不划算）
      const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();
      if (acceptEncoding.includes('gzip') && isText && data.length > 1024) {
        zlib.gzip(data, (gzErr, compressed) => {
          if (gzErr) {
            res.writeHead(200, headers);
            res.end(data);
          } else {
            headers['Content-Encoding'] = 'gzip';
            res.writeHead(200, headers);
            res.end(compressed);
          }
        });
      } else {
        res.writeHead(200, headers);
        res.end(data);
      }
    });
    return;
  }

  // ---------- 用户登录（账号名 + 密码）----------
  if (req.method === 'POST' && p === '/api/auth/login') {
    const ip = clientIp(req);
    if (loginRateLimited(ip)) {
      res.setHeader('Retry-After', '900');
      return send(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, password } = JSON.parse(body || '{}');
        if (!name || !password) return send(res, 400, { ok: false, error: '请输入账号和密码' });
        const user = users[name];
        if (!user) { auditLog(name, 'auth.login_fail', null, { reason: '账号不存在' }, false, req); return send(res, 403, { ok: false, error: '账号不存在：' + name }); }
        if (user.password !== password) { auditLog(name, 'auth.login_fail', null, { reason: '密码错误' }, false, req); return send(res, 403, { ok: false, error: '密码错误' }); }
        const token = makeToken();
        sessions[token] = { name, role: user.role, expires: Date.now() + TOKEN_TTL };
        saveSessions();
        auditLog(name, 'auth.login', null, { role: user.role }, true, req);
        send(res, 200, { ok: true, role: user.role, name, token });
      } catch (e) {
        send(res, 400, { ok: false, error: '请求格式错误' });
      }
    });
    return;
  }

  // ---------- 验证当前登录状态 ----------
  if (req.method === 'GET' && p === '/api/me') {
    const s = getSession(req);
    if (!s) return send(res, 401, { error: '未登录或会话已过期' });
    return send(res, 200, { name: s.name, role: s.role });
  }

  // ---------- 创建房间（需管理员权限） ----------
  if (req.method === 'POST' && p === '/api/rooms') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const opts = body ? JSON.parse(body) : {};
      if (!requireAdmin(req, res)) return;
      const id = opts.id || uid();
      if (rooms[id]) {
        return send(res, 409, { error: '房间号「' + id + '」已存在，请使用其他房间号' });
      }
      const seed = opts.seed ? loadSeed() : null;
      const travelers = Array.isArray(opts.travelers) ? opts.travelers.filter(n => n && n !== '匿名') : [];
      rooms[id] = {
        id,
        name: opts.name || '我的旅行',
        items: seed ? seed.items.map(it => ({ ...it, id: uid(), createdAt: Date.now() })) : [],
        expenses: [],
        people: travelers,
        createdAt: Date.now()
      };
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : null, 'room.create', id, { name: opts.name || '我的旅行', seed: !!opts.seed, travelers: travelers.length }, true, req);
      send(res, 200, rooms[id]);
    });
    return;
  }

  // ---------- 读取房间列表（管理员用）----------
  if (req.method === 'GET' && p === '/api/rooms') {
    const list = Object.values(rooms).map(r => ({
      id: r.id,
      name: r.name,
      itemCount: (r.items || []).length,
      createdAt: r.createdAt
    })).sort((a, b) => b.createdAt - a.createdAt);
    return send(res, 200, { total: list.length, rooms: list });
  }

  // 旧房间号重定向
  const ROOM_ALIASES = { 'macau-2026': '2026', '123456': '1234' };

  // ---------- 读取单个房间 ----------
  const roomM = p.match(/^\/api\/rooms\/([\w-]+)$/);
  if (req.method === 'GET' && roomM) {
    const roomId = ROOM_ALIASES[roomM[1]] || roomM[1];
    const r = rooms[roomId];
    if (!r) return send(res, 404, { error: 'not found' });
    return send(res, 200, r);
  }

  // ---------- 更新房间（重命名/设置预算）----------
  if (req.method === 'PATCH' && roomM) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { name, budget, budgetCurrency } = JSON.parse(body || '{}');
      if (!requireAdmin(req, res)) return;
      const r = rooms[roomM[1]];
      if (!r) return send(res, 404, { error: '房间不存在' });
      const changes = [];
      if (name && name.trim()) { r.name = name.trim(); changes.push('rename'); }
      if (budget !== undefined) { r.budget = Number(budget) || null; r.budgetCurrency = budgetCurrency || 'CNY'; if (budget === null) changes.push('budget_clear'); else changes.push('budget_set'); }
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : null, 'room.update', roomM[1], { changes, budget: r.budget, budgetCurrency: r.budgetCurrency }, true, req);
      send(res, 200, r);
    });
    return;
  }

  // ---------- 删除房间 ----------
  if (req.method === 'DELETE' && roomM) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!requireAdmin(req, res)) return;
      const rid = roomM[1];
      if (!rooms[rid]) return send(res, 404, { error: '房间不存在' });
      const deletedRoom = rooms[rid];
      delete rooms[rid];
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : null, 'room.delete', rid, { name: deletedRoom.name, itemCount: (deletedRoom.items || []).length }, true, req);
      send(res, 200, { ok: true });
    });
    return;
  }

  // ---------- 同行人管理（管理员设置）----------
  if (req.method === 'PUT' && p.startsWith('/api/rooms/') && p.endsWith('/travelers')) {
    const rid = p.replace('/api/rooms/', '').replace('/travelers', '');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!requireAdmin(req, res)) return;
      const r = rooms[rid];
      if (!r) return send(res, 404, { error: '房间不存在' });
      const { travelers } = JSON.parse(body || '{}');
      if (!Array.isArray(travelers)) return send(res, 400, { error: 'travelers 必须是数组' });
      const oldPeople = r.people || [];
      const newPeople = travelers.filter(n => n && n !== '匿名');
      r.people = newPeople;
      const oldSet = new Set(oldPeople);
      const newSet = new Set(newPeople);
      const removed = oldPeople.filter(p => !newSet.has(p));
      const added = newPeople.filter(p => !oldSet.has(p));
      // 出行人改名的联动（支持多人同时改名，如整批转小写）：
      // 账单里的付款人 / 分摊人若与某出行人"仅大小写/空格不同"，替换为出行人标准写法；
      // 若找不到任何匹配（真被移除的人），从分摊剔除 / 付款人置空。
      const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
      const canon = {};
      newPeople.forEach(p => { canon[norm(p)] = p; });
      const renames = {};
      let renamed = 0, reconciled = 0, reconciledPayers = 0;
      (r.expenses || []).forEach(e => {
        if (e.payer) {
          const c = canon[norm(e.payer)];
          if (c && c !== e.payer) { renames[e.payer] = c; e.payer = c; renamed++; }
          else if (!c) { e.payer = ''; reconciledPayers++; }
        }
        if (Array.isArray(e.splitAmong)) {
          const before = e.splitAmong.length;
          e.splitAmong = e.splitAmong.map(p => {
            const c = canon[norm(p)];
            if (c && c !== p) { renames[p] = c; renamed++; return c; }
            return c || null;
          }).filter(Boolean);
          if (e.splitAmong.length !== before) reconciled++;
        }
      });
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : null, 'room.travelers', rid,
        { count: r.people.length, travelers: r.people, removed, added, renamed, renames, reconciledExpenses: reconciled, reconciledPayers }, true, req);
      send(res, 200, { ok: true, people: r.people, expenses: r.expenses || [], removed, renamed, renames, reconciledExpenses: reconciled, reconciledPayers });
    });
    return;
  }

  // ---------- 管理员：用户管理 ----------
  if (req.method === 'GET' && p === '/api/admin/users') {
    if (!requireAdmin(req, res)) return;
    const list = Object.entries(users).map(([name, info]) => ({ name, role: info.role }));
    return send(res, 200, { users: list });
  }

  if (req.method === 'POST' && p === '/api/admin/users') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { name, password, role } = JSON.parse(body || '{}');
      if (!requireAdmin(req, res)) return;
      if (!name || !password) return send(res, 400, { error: '用户名和密码不能为空' });
      if (users[name]) return send(res, 409, { error: '用户「' + name + '」已存在' });
      users[name] = { password, role: role || 'user' };
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      const s = getSession(req);
      auditLog(s ? s.name : null, 'user.create', null, { targetUser: name, role: role || 'user' }, true, req);
      send(res, 200, { ok: true, name, role: users[name].role });
    });
    return;
  }

  if (req.method === 'PUT' && p.startsWith('/api/admin/users/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!requireAdmin(req, res)) return;
      const oldName = decodeURIComponent(p.replace('/api/admin/users/', ''));
      if (!users[oldName]) return send(res, 404, { error: '用户不存在' });
      if (oldName === '景杰克') return send(res, 403, { error: '不能修改管理员账号' });
      const { name, password } = JSON.parse(body || '{}');
      const newName = (name && name.trim()) ? name.trim() : null;
      // 重名检查（重命名到已存在的名字）
      if (newName && newName !== oldName && users[newName]) {
        return send(res, 409, { error: '用户「' + newName + '」已存在' });
      }
      const changes = [];
      if (newName && newName !== oldName) {
        users[newName] = users[oldName];
        delete users[oldName];
        changes.push('账号: ' + oldName + ' → ' + newName);
      }
      if (password && password.trim()) {
        const targetName = newName || oldName;
        users[targetName].password = password.trim();
        changes.push('密码已重置');
      }
      if (changes.length === 0) return send(res, 400, { error: '没有需要修改的内容' });
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      const updatedName = newName || oldName;
      const s = getSession(req);
      auditLog(s ? s.name : null, 'user.update', null, { targetUser: updatedName, changes }, true, req);
      send(res, 200, { ok: true, name: updatedName, role: users[updatedName].role, changes });
    });
    return;
  }

  if (req.method === 'DELETE' && p.startsWith('/api/admin/users/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (!requireAdmin(req, res)) return;
      const uname = decodeURIComponent(p.replace('/api/admin/users/', ''));
      if (!users[uname]) return send(res, 404, { error: '用户不存在' });
      if (uname === '景杰克') return send(res, 403, { error: '不能删除管理员账号' });
      delete users[uname];
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      const s = getSession(req);
      auditLog(s ? s.name : null, 'user.delete', null, { targetUser: uname }, true, req);
      send(res, 200, { ok: true });
    });
    return;
  }

  // ---------- 新增行程条目 ----------
  const addM = p.match(/^\/api\/rooms\/([\w-]+)\/items$/);
  if (req.method === 'POST' && addM) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const item = JSON.parse(body);
      item.id = uid();
      item.status = item.status || 'proposed';
      item.createdAt = Date.now();
      rooms[addM[1]].items.push(item);
      // 出行人由管理员手动维护，不因为新增行程而反向把创建人塞进行行人
      saveRooms();
      auditLog(item.creator || '匿名', 'item.add', addM[1], { place: item.place, date: item.date, type: item.type }, true, req);
      send(res, 200, item);
    });
    return;
  }

  // ---------- 更新 / 删除行程条目 ----------
  const itemM = p.match(/^\/api\/rooms\/([\w-]+)\/items\/([\w-]+)$/);
  if (itemM) {
    const [, rid, iid] = itemM;
    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const patch = JSON.parse(body);
        const it = rooms[rid].items.find(x => x.id === iid);
        if (!it) return send(res, 404, { error: 'no item' });
        const oldStatus = it.status;
        Object.assign(it, patch);
        // 出行人不因行程创建人变更而自动变更
        saveRooms();
        const s = getSession(req);
        auditLog(s ? s.name : (patch.creator || '未知'), 'item.update', rid, { place: it.place, date: it.date, status: oldStatus + '→' + it.status }, true, req);
        send(res, 200, it);
      });
      return;
    }
    if (req.method === 'DELETE') {
      const it = rooms[rid].items.find(x => x.id === iid);
      rooms[rid].items = rooms[rid].items.filter(x => x.id !== iid);
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : '未知', 'item.delete', rid, { place: it ? it.place : 'unknown', date: it ? it.date : null }, true, req);
      return send(res, 200, { ok: true });
    }
  }

  // ---------- 合并条目（把 source 并入 target 后，source 从数据彻底移除） ----------
  const mergeM = p.match(/^\/api\/rooms\/([\w-]+)\/items\/([\w-]+)\/merge$/);
  if (req.method === 'POST' && mergeM) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const { targetId } = JSON.parse(body);
      const r = rooms[mergeM[1]];
      const src = r.items.find(x => x.id === mergeM[2]);
      const tgt = r.items.find(x => x.id === targetId);
      if (!src || !tgt || src.id === tgt.id) return send(res, 400, { error: 'invalid merge' });
      const prefix = '（合并自：' + src.place + '）';
      tgt.note = ((tgt.note ? tgt.note + '；' : '') + prefix + (src.note ? src.note : '')).trim();
      r.items = r.items.filter(x => x.id !== src.id); // 合并即真删源条目
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : '未知', 'item.merge', mergeM[1], { source: src.place, target: tgt.place, date: src.date }, true, req);
      send(res, 200, { target: tgt, removed: src.id });
    });
    return;
  }

  // ---------- 费用管理：新增 ----------
  const addExpM = p.match(/^\/api\/rooms\/([\w-]+)\/expenses$/);
  if (req.method === 'POST' && addExpM) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const r = rooms[addExpM[1]];
      if (!r) return send(res, 404, { error: '房间不存在' });
      const exp = JSON.parse(body);
      exp.id = uid();
      exp.createdAt = Date.now();
      if (!r.expenses) r.expenses = [];
      // 出行人是唯一权威：账单的付款人 / 分摊人只能从出行人里选，绝不反向写回出行人
      const expPs = new Set(r.people || []);
      exp.splitAmong = (exp.splitAmong || []).filter(p => expPs.has(p));
      if (exp.payer && !expPs.has(exp.payer)) exp.payer = '';
      r.expenses.push(exp);
      saveRooms();
      auditLog(exp.createdBy || exp.payer || '匿名', 'expense.add', addExpM[1], { category: exp.category, amount: exp.amount, currency: exp.currency, desc: exp.description }, true, req);
      send(res, 200, exp);
    });
    return;
  }

  // ---------- 费用管理：更新 / 删除 ----------
  const expM = p.match(/^\/api\/rooms\/([\w-]+)\/expenses\/([\w-]+)$/);
  if (expM) {
    const [, rid, eid] = expM;
    const r = rooms[rid];
    if (!r) return send(res, 404, { error: '房间不存在' });
    if (!r.expenses) r.expenses = [];
    if (req.method === 'PATCH') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const patch = JSON.parse(body);
        const ex = r.expenses.find(x => x.id === eid);
        if (!ex) return send(res, 404, { error: '费用记录不存在' });
        Object.assign(ex, patch);
        // 出行人是唯一权威：修改后重新校验付款人 / 分摊人必须都在出行人内
        const exPs = new Set(r.people || []);
        if (Array.isArray(ex.splitAmong)) ex.splitAmong = ex.splitAmong.filter(p => exPs.has(p));
        if (ex.payer && !exPs.has(ex.payer)) ex.payer = '';
        saveRooms();
        const s = getSession(req);
        auditLog(s ? s.name : '未知', 'expense.update', rid, { category: ex.category, amount: ex.amount, currency: ex.currency }, true, req);
        send(res, 200, ex);
      });
      return;
    }
    if (req.method === 'DELETE') {
      const ex = r.expenses.find(x => x.id === eid);
      r.expenses = r.expenses.filter(x => x.id !== eid);
      saveRooms();
      const s = getSession(req);
      auditLog(s ? s.name : '未知', 'expense.delete', rid, { category: ex ? ex.category : 'unknown', amount: ex ? ex.amount : 0 }, true, req);
      return send(res, 200, { ok: true });
    }
  }

  // ---------- 批量修复缺失坐标（先查本地 POI 库，后试 Nominatim）----------
  const fixGeoM = p.match(/^\/api\/rooms\/([\w-]+)\/fix-geo$/);
  if (req.method === 'POST' && fixGeoM) {
    const r = rooms[fixGeoM[1]];
    if (!r) return send(res, 404, { error: 'not found' });
    const noGeo = r.items.filter(i => i.place && (!i.lat || !i.lng));
    if (!noGeo.length) return send(res, 200, { fixed: 0, message: '所有条目已有坐标' });

    // 加载本地 POI 库
    const poisPath = path.join(PUBLIC_DIR, 'pois.json');
    let pois = [];
    if (fs.existsSync(poisPath)) {
      try { pois = JSON.parse(fs.readFileSync(poisPath, 'utf8')); } catch (e) { /* ignore */ }
    }

    let fixed = 0;
    noGeo.forEach(it => {
      const name = (it.place || '').trim();
      if (!name) return;

      // 1) 优先精确匹配本地 POI
      let match = pois.find(p => p.name === name);
      // 2) 模糊匹配（开头一致）
      if (!match) match = pois.find(p => p.name.startsWith(name) || name.startsWith(p.name));
      // 3) 包含匹配
      if (!match) match = pois.find(p => p.name.includes(name) || name.includes(p.name));

      if (match) {
        it.lat = match.lat;
        it.lng = match.lng;
        fixed++;
      }
    });
    saveRooms();
    send(res, 200, { fixed, total: noGeo.length, message: '通过本地POI库回填 ' + fixed + ' / ' + noGeo.length + ' 条坐标' });
    return;
  }

  // ---------- 管理员：审计日志 ----------
  if (req.method === 'GET' && p === '/api/admin/audit') {
    if (!requireAdmin(req, res)) return;
    const user = url.searchParams.get('user') || '';
    const action = url.searchParams.get('action') || '';
    const room = url.searchParams.get('room') || '';
    const dateFrom = url.searchParams.get('dateFrom') || '';
    const dateTo = url.searchParams.get('dateTo') || '';
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const size = Math.min(parseInt(url.searchParams.get('size') || '50', 10), 200);

    let filtered = [...auditEntries];

    if (user) filtered = filtered.filter(e => e.user === user);
    if (action) filtered = filtered.filter(e => e.action === action);
    if (room) filtered = filtered.filter(e => e.room === room);
    if (dateFrom) {
      const fromTs = new Date(dateFrom + 'T00:00:00+08:00').getTime();
      filtered = filtered.filter(e => e.ts >= fromTs);
    }
    if (dateTo) {
      const toTs = new Date(dateTo + 'T23:59:59+08:00').getTime();
      filtered = filtered.filter(e => e.ts <= toTs);
    }

    // 按时间倒序
    filtered.sort((a, b) => b.ts - a.ts);

    const total = filtered.length;
    const totalPages = Math.ceil(total / size);
    const start = (page - 1) * size;
    const pageItems = filtered.slice(start, start + size);

    // 收集可用的筛选值
    const allUsers = [...new Set(auditEntries.map(e => e.user))].filter(Boolean);
    const allActions = [...new Set(auditEntries.map(e => e.action))].filter(Boolean);
    const allRooms = [...new Set(auditEntries.map(e => e.room))].filter(Boolean);

    send(res, 200, {
      total, page, size, totalPages,
      entries: pageItems,
      filters: { users: allUsers, actions: allActions, rooms: allRooms }
    });
    return;
  }

  // ---------- 管理员：导出全部数据 ----------
  if (req.method === 'GET' && p === '/api/admin/export') {
    if (!requireAdmin(req, res)) return;
    const exportData = {
      exportedAt: new Date().toISOString(),
      rooms: Object.fromEntries(Object.entries(rooms).map(([id, r]) => [id, {
        id: r.id, name: r.name, items: r.items || [], expenses: r.expenses || [], people: r.people || [],
        budget: r.budget || null, budgetCurrency: r.budgetCurrency || 'CNY', createdAt: r.createdAt
      }])),
      users: Object.fromEntries(Object.entries(users).map(([name, info]) => [name, { role: info.role }]))
    };
    const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="travel-planner-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
      'Content-Length': jsonBuffer.length
    });
    res.end(jsonBuffer);
    const s = getSession(req);
    auditLog(s ? s.name : null, 'admin.export', null, { rooms: Object.keys(rooms).length }, true, req);
    return;
  }

  // ---------- 心跳 ----------
  const hbM = p.match(/^\/api\/rooms\/([\w-]+)\/heartbeat$/);
  if (req.method === 'POST' && hbM) {
    const r = rooms[hbM[1]];
    if (!r) return send(res, 404, { error: 'not found' });
    const s = getSession(req);
    if (!s) return send(res, 200, { online: [] });
    if (!r.online) r.online = [];
    // 更新或添加在线记录
    const idx = r.online.findIndex(o => o.name === s.name);
    const now = Date.now();
    if (idx >= 0) r.online[idx].ts = now;
    else r.online.push({ name: s.name, ts: now });
    // 清理 60 秒未心跳的离线
    r.online = r.online.filter(o => now - o.ts < 60000);
    return send(res, 200, { online: r.online.map(o => o.name) });
  }

  res.writeHead(404);
  res.end('not found');
});

// 仅监听本机回环：外部直连 :PORT 会被拒绝，所有流量必须经 nginx 反代进入（方案1收口）
server.listen(PORT, '127.0.0.1', () => {
  console.log('Travel Planner 已启动(本机内网) → http://127.0.0.1:' + PORT + '  (演示房间: #' + DEMO_ID + ')');
});
