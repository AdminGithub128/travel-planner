// 旅游攻略协作应用 —— 前端逻辑（房间协作 + 自动导航 + 合并审阅）
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const state = {
  roomId: null,
  room: null,
  activeTab: 'plan',
  navDay: null,
  navOptimized: null // 智能排序后的预览顺序（不持久化）
};

// ---------------- 用户昵称 ----------------
const NICK_KEY = 'travel_nickname';

function getNickname() {
  return localStorage.getItem(NICK_KEY) || '';
}

function setNickname(name, silent) {
  const n = (name || '').trim().slice(0, 10);
  localStorage.setItem(NICK_KEY, n);
  refreshUserBadge();
  if (!silent) {
    const c = $('#addForm')?.creator;
    if (c && !c.dataset.manual) c.value = n;
  }
}

function refreshUserBadge() {
  const n = getNickname();
  const b = $('#userBadge');
  if (b) b.textContent = n ? '👤 ' + n : '👤 --';
}

function changeNickname() {
  const old = getNickname();
  const n = prompt('修改你的名字（最多 10 字）：', old);
  if (n === null) return;
  if (!n.trim()) { alert('名字不能为空'); return; }
  setNickname(n.trim());
}

function initNickname() {
  const nick = getNickname();
  refreshUserBadge();
  if (nick) {
    // 有昵称 → auto-fill 创建人
    const c = $('#addForm')?.creator;
    if (c) c.value = nick;
    return;
  }
  // 首次 → 弹窗
  const overlay = $('#nickOverlay');
  const input = $('#nickInput');
  const confirmBtn = $('#nickConfirm');
  overlay.classList.remove('hidden');
  input.focus();

  function doConfirm() {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    setNickname(v);
    overlay.classList.add('hidden');
    // 卸载事件
    confirmBtn.removeEventListener('click', doConfirm);
    input.removeEventListener('keydown', onKey);
  }

  function onKey(e) { if (e.key === 'Enter') doConfirm(); }

  confirmBtn.addEventListener('click', doConfirm);
  input.addEventListener('keydown', onKey);
}

// 标记创建人框是否被手动改过
(function bindCreatorTracking() {
  const c = $('#addForm')?.creator;
  if (!c) return;
  c.addEventListener('input', () => { c.dataset.manual = '1'; });
})();

// ---------------- 房间 ----------------
async function ensureRoom() {
  let id = location.hash.slice(1);
  if (!id) { id = 'macau-2026'; location.hash = id; }
  state.roomId = id;
  let r = await fetch('/api/rooms/' + id).then(res => res.ok ? res.json() : null);
  if (!r) {
    r = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: '澳门·珠海·广州 6日游', seed: id === 'macau-2026' })
    }).then(res => res.json());
  }
  state.room = r;
  render();
}

async function createRoom() {
  const name = prompt('房间名称：', '我的旅行') || '我的旅行';
  const id = Math.random().toString(36).slice(2, 8);
  const r = await fetch('/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, seed: false })
  }).then(res => res.json());
  location.hash = id;
  state.roomId = id; state.room = r; state.navOptimized = null;
  render();
}

async function joinRoom() {
  const id = prompt('输入房间号：');
  if (!id) return;
  location.hash = id.trim();
  await ensureRoom();
}

function copyShare() {
  const url = location.origin + '/#' + state.roomId;
  navigator.clipboard?.writeText(url).then(
    () => alert('邀请链接已复制：\n' + url),
    () => prompt('复制失败，请手动复制：', url)
  );
}

async function refresh() {
  state.room = await fetch('/api/rooms/' + state.roomId).then(r => r.json());
  state.navOptimized = null;
  render();
}

// ---------------- 行程条目 ----------------
async function addItem(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
  const f = e.target;
  const item = {
    date: f.date.value,
    time: f.time.value || '',
    place: f.place.value,
    lat: parseFloat(f.lat.value) || null,
    lng: parseFloat(f.lng.value) || null,
    type: f.type.value,
    note: f.note.value || '',
    creator: f.creator.value.trim() || getNickname() || '匿名',
    status: 'proposed'
  };

  // ==== 时间冲突检测 ====
  if (item.time) {
    const conflicts = state.room.items.filter(i =>
      i.date === item.date && i.time === item.time &&
      i.place !== item.place && i.status !== 'dropped'
    );
    if (conflicts.length > 0) {
      if (btn) { btn.disabled = false; btn.textContent = '添加'; }
      const names = conflicts.map(c => '• ' + c.place + '（' + (c.creator || '?') + '）').join('\n');
      if (!confirm('⚠️ 时间冲突提醒\n\n' + item.date + ' ' + item.time + ' 已有：\n' + names + '\n\n是否仍要添加？')) {
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
    }
  }

  try {
    const resp = await fetch('/api/rooms/' + state.roomId + '/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
    });
    if (!resp.ok) throw new Error('服务器返回 ' + resp.status);
    f.reset();
    f.date.value = item.date; f.time.value = '10:00';
    await refresh();
  } catch (err) {
    alert('添加失败：' + err.message + '\n\n请确认服务器已启动（端口 3000）。');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '添加'; }
  }
}

async function deleteItem(id) {
  if (!confirm('删除该行程？')) return;
  await fetch('/api/rooms/' + state.roomId + '/items/' + id, { method: 'DELETE' });
  await refresh();
}

async function setStatus(id, status) {
  await fetch('/api/rooms/' + state.roomId + '/items/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
  });
  await refresh();
}

// 合并：把本条并入同日期另一条，本条从行程视图隐藏（审阅页保留「已合并」记录）
async function mergeItem(id) {
  const src = state.room.items.find(i => i.id === id);
  if (!src) return;
  const cands = state.room.items.filter(i =>
    i.id !== id && i.status !== 'dropped' && i.status !== 'merged' && i.date === src.date);
  if (!cands.length) {
    if (confirm('当天没有其他可合并的条目，是否直接删除本条？')) {
      await fetch('/api/rooms/' + state.roomId + '/items/' + id, { method: 'DELETE' });
      await refresh();
    }
    return;
  }
  const list = cands.map((c, i) => (i + 1) + '. ' + (c.time || '--:--') + ' ' + c.place + ' [' + c.type + ']').join('\n');
  const ans = prompt('把「' + src.place + '」合并到哪一条？（输入序号）\n' + list, '1');
  if (!ans) return;
  const idx = parseInt(ans, 10) - 1;
  if (isNaN(idx) || !cands[idx]) { alert('无效选择'); return; }
  await fetch('/api/rooms/' + state.roomId + '/items/' + id + '/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId: cands[idx].id })
  }).then(r => r.json());
  await refresh();
}

// ---------------- 导航计算 ----------------
function haversine(a, b) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function segTime(km) {
  // 市内约 25km/h，跨城(>40km)约 70km/h，每段加 8 分钟停留缓冲
  const speed = km > 40 ? 70 : 25;
  return km / speed * 60 + 8;
}
function amapNav(lat, lng, place) {
  return 'https://uri.amap.com/navigation?to=' + lng + ',' + lat + ',' +
    encodeURIComponent(place) + '&mode=car&coordinate=gaode&callnative=1';
}

// ---------------- 渲染 ----------------
function switchTab(tab) {
  state.activeTab = tab;
  state.navOptimized = null;
  $$('.tab').forEach(t => t.classList[t.dataset.tab === tab ? 'add' : 'remove']('active'));
  $$('.panel').forEach(p => p.classList[p.id === tab ? 'add' : 'remove']('active'));
  render();
}

function render() {
  if (!state.room) return;
  $('#roomName').textContent = state.room.name;
  $('#roomId').textContent = '房间号: ' + state.roomId;
  renderPlan();
  if (state.activeTab === 'nav') renderNav();
  if (state.activeTab === 'review') renderReview();
}

function tagHtml(type) { return '<span class="tag ' + type + '">' + type + '</span>'; }
function statusPill(s) {
  const map = { kept: '保留', proposed: '提议', dropped: '删除', merged: '已合并' };
  return '<span class="status-pill ' + s + '">' + (map[s] || s) + '</span>';
}

function renderPlan() {
  const items = state.room.items;
  const days = [...new Set(items.map(i => i.date))].sort();
  if (!items.length) { $('#planList').innerHTML = '<div class="empty">还没有行程，先在上方添加吧 ✍️</div>'; return; }
  let html = '';
  days.forEach(day => {
    const list = items.filter(i => i.date === day && (i.status === 'kept' || i.status === 'proposed'))
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!list.length) return;
    html += '<div class="day-group"><div class="day-head">📅 ' + day + '</div>';
    list.forEach(it => {
      html += itemRowHtml(it);
    });
    html += '</div>';
  });
  $('#planList').innerHTML = html;
}

function itemRowHtml(it) {
  return '<div class="item-row">' +
    '<div class="item-top">' +
      '<div class="item-time">' + (it.time || '--:--') + '</div>' +
      '<div class="item-main">' +
        '<div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
        '<div class="item-meta">' +
          (it.note ? '<span class="item-note">' + it.note + '</span>' : '') +
          '<span class="creator-badge">' + it.creator + '</span>' +
          statusPill(it.status) +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="item-btns"><button class="del" onclick="deleteItem(\'' + it.id + '\')">删</button></div>' +
  '</div>';
}

function renderNav() {
  const items = state.room.items.filter(i => (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng);
  const days = [...new Set(items.map(i => i.date))].sort();
  if (!days.length) { $('#navDayBar').innerHTML = ''; $('#navResult').innerHTML = '<div class="empty">无带坐标的行程</div>'; return; }

  if (!state.navDay || !days.includes(state.navDay)) state.navDay = days[0];
  $('#navDayBar').innerHTML = days.map(d =>
    '<button class="' + (d === state.navDay ? 'active' : '') + '" onclick="selectNavDay(\'' + d + '\')">' + d + '</button>'
  ).join('');

  let list = items.filter(i => i.date === state.navDay)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (state.navOptimized) list = state.navOptimized;

  const dayName = state.navOptimized ? '（智能排序预览）' : '';
  let html = '<div class="route-card"><h4>🗺️ ' + state.navDay + ' 导航路线' + dayName + '</h4>';
  let totalKm = 0, totalMin = 0;

  list.forEach((it, idx) => {
    if (idx > 0 && list[idx - 1].lat && it.lat) {
      const d = haversine(list[idx - 1], it);
      const t = segTime(d);
      totalKm += d; totalMin += t;
      html += '<div class="seg"><span>↓ ' + d.toFixed(1) + ' km · 约 ' + Math.round(t) + ' 分钟</span><span class="line"></span></div>';
    }
    html += '<div class="item-row">' +
      '<div class="item-top">' +
        '<div class="item-time">' + (it.time || '--:--') + '</div>' +
        '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
        '<div class="item-meta">' + (it.note || '') + '<span class="creator-badge" style="margin-left:4px">' + it.creator + '</span></div>' +
        '<a class="nav-link" href="' + amapNav(it.lat, it.lng, it.place) + '" target="_blank">🚗 高德导航</a></div>' +
      '</div>' +
    '</div>';
  });

  if (list.length > 1) {
    html += '<div class="summary">全程约 <b>' + totalKm.toFixed(1) + ' km</b> · 预计行驶/移动 <b>' +
      Math.round(totalMin) + ' 分钟</b>（不含游玩停留）。跨城段已按较高车速估算，实际以地图为准。</div>';
  } else {
    html += '<div class="summary">当天仅 1 个带坐标的点，无法生成路段路线。</div>';
  }
  html += '</div>';
  $('#navResult').innerHTML = html;

  // ==== Canvas 路线地图 ====
  drawNavMap(list, totalKm);
}

function drawNavMap(list, totalKm) {
  const canvas = $('#navMap');
  if (!canvas) return;
  const validPts = list.filter(p => p.lat && p.lng);
  if (validPts.length < 2) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';

  const container = canvas.parentElement;
  const W = canvas.width = Math.min(container.clientWidth - 24, 600);
  const H = canvas.height = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const lats = validPts.map(p => p.lat);
  const lngs = validPts.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latPad = (maxLat - minLat) * 0.15 || 0.005;
  const lngPad = (maxLng - minLng) * 0.15 || 0.005;

  const pad = 35;
  const toX = lng => pad + (lng - (minLng - lngPad)) / ((maxLng + lngPad) - (minLng - lngPad)) * (W - pad * 2);
  const toY = lat => H - pad - (lat - (minLat - latPad)) / ((maxLat + latPad) - (minLat - latPad)) * (H - pad * 2);

  // 背景
  ctx.fillStyle = '#fafbfc';
  ctx.fillRect(0, 0, W, H);

  // 网格
  ctx.strokeStyle = '#e8ecf0'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const x = pad + i * (W - pad * 2) / 4;
    ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, H - pad); ctx.stroke();
    const y = pad + i * (H - pad * 2) / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }

  // 路线连线
  ctx.strokeStyle = '#F7931E'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.beginPath();
  validPts.forEach((p, i) => {
    const x = toX(p.lng), y = toY(p.lat);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 路线箭头（每段中间）
  for (let i = 1; i < validPts.length; i++) {
    const a = validPts[i - 1], b = validPts[i];
    const x1 = toX(a.lng), y1 = toY(a.lat), x2 = toX(b.lng), y2 = toY(b.lat);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.translate(mx, my); ctx.rotate(angle);
    ctx.fillStyle = '#F7931E';
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -3.5); ctx.lineTo(-4, 3.5); ctx.closePath(); ctx.fill();
    ctx.restore();

    // 距离标签
    const d = haversine(a, b);
    ctx.fillStyle = '#64748b'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(d.toFixed(1) + 'km', mx + 4, my - 8);
  }

  // 标注点
  validPts.forEach((p, i) => {
    const x = toX(p.lng), y = toY(p.lat);

    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.beginPath(); ctx.arc(x + 1, y + 2, 9, 0, Math.PI * 2); ctx.fill();

    // 圆点
    const isHotel = p.type === '住宿';
    ctx.fillStyle = isHotel ? '#6366f1' : '#FF6B35';
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();

    // 编号
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(i + 1, x, y);

    // 名称标签
    const label = (p.place || '').slice(0, 5);
    ctx.fillStyle = '#1e293b'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left';
    const lx = i % 2 === 0 ? x + 12 : x - 12 - ctx.measureText(label).width;
    ctx.fillText(label, lx, y - 2);
  });

  // 图例
  ctx.fillStyle = '#94a3b8'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('路线总距 ' + totalKm.toFixed(1) + ' km  |  🟠 景点/餐饮  🟣 住宿', pad, 14);
}

function selectNavDay(d) { state.navDay = d; state.navOptimized = null; renderNav(); }

function optimizeRoute() {
  const items = state.room.items.filter(i => i.date === state.navDay && (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng);
  if (items.length < 3) { alert('当天点太少，无需优化'); return; }

  // 分离酒店（住宿）和其他点
  const hotels = items.filter(i => i.type === '住宿');
  const others = items.filter(i => i.type !== '住宿');

  let ordered;
  if (hotels.length > 0 && others.length >= 2) {
    // 酒店锚点模式：从酒店出发 → 最近邻遍历所有景点 → 回到酒店（如有第二个酒店）
    const start = hotels[0];
    const rest = [...others];
    ordered = [start];
    while (rest.length) {
      const last = ordered[ordered.length - 1];
      let bi = 0, bd = Infinity;
      rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
      ordered.push(rest.splice(bi, 1)[0]);
    }
    // 如果有第二个酒店（如次日酒店），作为终点
    if (hotels.length > 1) ordered.push(hotels[1]);
  } else {
    // 无酒店：标准最近邻
    const rest = items.slice();
    ordered = [rest.shift()];
    while (rest.length) {
      const last = ordered[ordered.length - 1];
      let bi = 0, bd = Infinity;
      rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
      ordered.push(rest.splice(bi, 1)[0]);
    }
  }
  state.navOptimized = ordered;
  renderNav();
}

function renderReview() {
  const items = state.room.items;
  const days = [...new Set(items.map(i => i.date))].sort();
  if (!items.length) { $('#reviewList').innerHTML = '<div class="empty">暂无行程可审阅</div>'; return; }

  // ===== 贡献统计 =====
  const byCreator = {};
  items.forEach(it => {
    const c = it.creator || '匿名';
    byCreator[c] = (byCreator[c] || 0) + 1;
  });
  const myNick = getNickname();
  const statHtml = Object.entries(byCreator)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) =>
      '<span class="stat-item' + (name === myNick ? ' current' : '') + '">' +
      '👤 ' + name + ' <span class="stat-count">' + count + '条</span>' +
      '</span>'
    ).join('');

  // ===== 冲突检测 =====
  const byKey = {};
  items.forEach(it => { if (it.time) { const k = it.date + '|' + it.time; (byKey[k] = byKey[k] || []).push(it); } });
  const conflictIds = new Set();
  Object.values(byKey).forEach(arr => {
    if (arr.length > 1 && new Set(arr.map(x => x.place)).size > 1) arr.forEach(x => conflictIds.add(x.id));
  });

  let html = '<div class="review-stats"><h4>📊 贡献统计</h4><div class="stat-list">' + statHtml + '</div></div>';
  days.forEach(day => {
    const list = items.filter(i => i.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!list.length) return;
    html += '<div class="day-group"><div class="day-head">📅 ' + day + ' · 共 ' + list.length + ' 条</div>';
    list.forEach(it => {
      const conflict = conflictIds.has(it.id) ? ' conflict' : '';
      html += '<div class="item-row' + conflict + '">' +
        '<div class="item-top">' +
          '<div class="item-time">' + (it.time || '--:--') + '</div>' +
          '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + ' ' + statusPill(it.status) + '</div>' +
          '<div class="item-meta">' +
            (it.note ? '<span class="item-note">' + it.note + '</span>' : '') +
            '<span class="creator-badge">' + it.creator + '</span>' +
          '</div>' +
        '</div></div>' +
        '<div class="review-actions">' +
          '<button class="b-keep" onclick="setStatus(\'' + it.id + '\',\'kept\')">保留</button>' +
          '<button class="b-merge" onclick="mergeItem(\'' + it.id + '\')">合并</button>' +
          '<button class="b-drop" onclick="deleteItem(\'' + it.id + '\')">删除</button>' +
        '</div></div>';
    });
    html += '</div>';
  });
  $('#reviewList').innerHTML = html;
}

// ---------------- 地点联想（本地 POI + 在线地理编码兜底）----------------
let POIS = [];
let geocodeQueryId = 0;
let geocodeTimer = null;

async function loadPois() {
  try { POIS = await fetch('/public/pois.json').then(r => r.ok ? r.json() : []); }
  catch (e) { POIS = []; }
}

async function geocodeNominatim(query) {
  try {
    const resp = await fetch('https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(query) + '&format=json&limit=5&accept-language=zh');
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.slice(0, 5).map(d => ({
      name: d.display_name.split(',')[0],
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      type: '其他'
    }));
  } catch (e) { return []; }
}

function fillCoords(p) {
  const f = $('#addForm');
  if (!f) return;
  f.lat.value = p.lat || '';
  f.lng.value = p.lng || '';
  if (p.type && f.type.querySelector('option[value="' + p.type + '"]')) f.type.value = p.type;
}

// 模糊匹配分数：名称完全匹配 > 开头匹配 > 包含 > 城市匹配
function matchScore(poi, query) {
  const q = query.toLowerCase();
  const name = poi.name.toLowerCase();
  const city = poi.city.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (city.includes(q)) return 30;
  // 逐字匹配（输入"大三巴"能匹配"大三巴牌坊"）
  let chars = 0;
  for (const c of q) { if (name.includes(c)) chars++; }
  if (chars >= q.length && q.length >= 2) return 20 + chars;
  return 0;
}

function onPlaceInput() {
  const inp = $('#placeInput');
  const box = $('#poiSuggestions');
  const v = inp.value.trim();
  if (!v) { box.style.display = 'none'; box._matches = []; box._geoMatches = []; return; }

  // ---- 本地 POI 打分排序 ----
  const scored = POIS
    .map(p => ({ p, s: matchScore(p, v) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map(x => x.p);

  const exact = POIS.find(p => p.name === v);
  if (exact) fillCoords(exact);

  // ---- 构建下拉 HTML ----
  let html = scored.map((p, i) =>
    '<li data-i="' + i + '">' +
      '<div class="poi-left">' +
        '<div class="poi-name">' + p.name + '</div>' +
        '<div class="poi-sub">' + p.city + '</div>' +
      '</div>' +
      '<div class="poi-right">' +
        '<span class="poi-type ' + (p.type || '其他') + '">' + (p.type || '') + '</span>' +
        '<span class="poi-coord">' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + '</span>' +
      '</div>' +
    '</li>'
  ).join('');

  // 本地无结果 → 先显示"在线搜索中"
  if (!scored.length) {
    html += '<li class="poi-geo-loading">🌐 正在在线搜索…</li>';
  }
  // 有结果但不完全匹配 → 保留手动回退
  if (!exact && v.length >= 1) {
    html += '<li class="poi-fallback" data-i="-1">' +
      '<div class="poi-left"><div class="poi-name">使用「' + v + '」</div>' +
      '<div class="poi-sub">手动填写坐标</div></div></li>';
  }

  box.innerHTML = html;
  box._matches = scored;
  box._geoMatches = [];
  box.style.display = 'block';

  // ---- 异步在线地理编码（本地未精确匹配时触发）----
  if (!exact && v.length >= 2) {
    clearTimeout(geocodeTimer);
    geocodeTimer = setTimeout(async () => {
      const qid = ++geocodeQueryId;
      const geoResults = await geocodeNominatim(v);
      if (qid !== geocodeQueryId) return; // 过期查询，丢弃

      const box2 = $('#poiSuggestions');
      if (!box2 || box2.style.display === 'none') return;

      // 重建 HTML（本地结果 + 在线结果）
      let newHtml = scored.map((p, i) =>
        '<li data-i="' + i + '">' +
          '<div class="poi-left"><div class="poi-name">' + p.name + '</div>' +
          '<div class="poi-sub">' + p.city + '</div></div>' +
          '<div class="poi-right"><span class="poi-type ' + (p.type || '其他') + '">' + (p.type || '') + '</span>' +
          '<span class="poi-coord">' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + '</span></div>' +
        '</li>'
      ).join('');

      if (geoResults.length > 0) {
        newHtml += '<li class="poi-divider">🌐 在线匹配</li>';
        geoResults.forEach((p, i) => {
          const idx = -(i + 2); // -2, -3, ...
          newHtml += '<li class="poi-geo" data-i="' + idx + '">' +
            '<div class="poi-left"><div class="poi-name">' + p.name + '</div>' +
            '<div class="poi-sub">经纬度 ' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + '</div></div>' +
            '<div class="poi-right"><span class="poi-type 其他">在线</span></div></li>';
        });
      } else if (!scored.length) {
        newHtml += '<li class="poi-fallback" data-i="-1">' +
          '<div class="poi-left"><div class="poi-name">使用「' + v + '」</div>' +
          '<div class="poi-sub">在线也未匹配到，需手动填写坐标</div></div></li>';
      }

      if (!exact && v.length >= 1 && geoResults.length > 0) {
        newHtml += '<li class="poi-fallback" data-i="-1">' +
          '<div class="poi-left"><div class="poi-name">使用「' + v + '」</div>' +
          '<div class="poi-sub">以我输入的为准</div></div></li>';
      }

      box2.innerHTML = newHtml;
      box2._matches = scored;
      box2._geoMatches = geoResults;
    }, 350);
  }
}

function selectPoi(i) {
  const box = $('#poiSuggestions');
  const inp = $('#placeInput');

  if (i === -1) {
    // 回退：以用户输入为准，清空坐标让用户手动填
    fillCoords({ lat: '', lng: '', type: '' });
    box.style.display = 'none';
    return;
  }

  // 在线地理编码结果（负下标 -2, -3, ...）
  if (i < -1 && box._geoMatches) {
    const geoIdx = -(i + 2);
    const p = box._geoMatches[geoIdx];
    if (p) {
      inp.value = p.name;
      fillCoords(p);
      box.style.display = 'none';
      return;
    }
  }

  // 本地 POI 结果
  const p = box._matches && box._matches[i];
  if (!p) { box.style.display = 'none'; return; }
  inp.value = p.name;
  fillCoords(p);
  box.style.display = 'none';
}

function hidePoi() { const box = $('#poiSuggestions'); if (box) box.style.display = 'none'; }

// 多人协作：每 10 秒静默拉取他人最新改动（有人正在输入框聚焦时跳过，避免打断）
setInterval(async () => {
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
  if (!state.roomId || !state.room) return;
  try { await refresh(); } catch (e) { /* 离线/只读时静默 */ }
}, 10000);

// 启动
initNickname();
ensureRoom();
window.addEventListener('hashchange', ensureRoom);
loadPois();
(function bindPoi() {
  const inp = $('#placeInput');
  const box = $('#poiSuggestions');
  if (!inp || !box) return;
  inp.addEventListener('input', onPlaceInput);
  inp.addEventListener('focus', onPlaceInput);
  box.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); selectPoi(+li.dataset.i); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.input-wrap')) hidePoi(); });
})();
