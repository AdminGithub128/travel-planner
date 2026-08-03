// 旅游攻略协作应用 —— 零依赖 Node 服务（MVP：房间协作 + 自动导航 + 合并审阅）
// 仅使用 Node 内置模块，无需 npm install，适配受限网络环境。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let rooms = {};
if (fs.existsSync(ROOMS_FILE)) {
  try { rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')); } catch (e) { rooms = {}; }
}

function saveRooms() {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}
function uid() { return crypto.randomBytes(6).toString('hex'); }
function loadSeed() {
  const candidates = [SEED_FILE, path.join(__dirname, 'data', 'seed.json')];
  for (const f of candidates) {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  return { name: '我的旅行', items: [] };
}

// 启动时确保演示房间存在（带种子数据，开箱即跑）
const DEMO_ID = 'macau-2026';
if (!rooms[DEMO_ID]) {
  const seed = loadSeed();
  rooms[DEMO_ID] = {
    id: DEMO_ID,
    name: seed.name || '澳门·珠海·广州 6日游',
    items: (seed.items || []).map(it => ({ ...it, id: uid(), createdAt: Date.now() })),
    createdAt: Date.now()
  };
  saveRooms();
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---------- 静态文件 ----------
  if (req.method === 'GET' && (p === '/' || p.startsWith('/public/'))) {
    let filePath = p === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(__dirname, p);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const headers = {
        'Content-Type': (MIME[ext] || 'text/plain') + '; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate'
      };
      res.writeHead(200, headers);
      res.end(data);
    });
    return;
  }

  // ---------- 创建房间 ----------
  if (req.method === 'POST' && p === '/api/rooms') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const opts = body ? JSON.parse(body) : {};
      const id = opts.id || uid();
      if (!rooms[id]) {
        const seed = opts.seed ? loadSeed() : null;
        rooms[id] = {
          id,
          name: opts.name || '我的旅行',
          items: seed ? seed.items.map(it => ({ ...it, id: uid(), createdAt: Date.now() })) : [],
          createdAt: Date.now()
        };
        saveRooms();
      }
      send(res, 200, rooms[id]);
    });
    return;
  }

  // ---------- 读取房间 ----------
  const roomM = p.match(/^\/api\/rooms\/([\w-]+)$/);
  if (req.method === 'GET' && roomM) {
    const r = rooms[roomM[1]];
    if (!r) return send(res, 404, { error: 'not found' });
    return send(res, 200, r);
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
      saveRooms();
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
        Object.assign(it, patch);
        saveRooms();
        send(res, 200, it);
      });
      return;
    }
    if (req.method === 'DELETE') {
      rooms[rid].items = rooms[rid].items.filter(x => x.id !== iid);
      saveRooms();
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
      send(res, 200, { target: tgt, removed: src.id });
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('Travel Planner 已启动 → http://localhost:' + PORT + '  (演示房间: #' + DEMO_ID + ')');
});
