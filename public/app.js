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
  const f = e.target;
  const item = {
    date: f.date.value,
    time: f.time.value || '',
    place: f.place.value,
    lat: parseFloat(f.lat.value) || null,
    lng: parseFloat(f.lng.value) || null,
    type: f.type.value,
    note: f.note.value || '',
    creator: f.creator.value || '我',
    status: 'proposed'
  };
  await fetch('/api/rooms/' + state.roomId + '/items', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
  }).then(r => r.json());
  f.reset();
  f.date.value = item.date; f.time.value = '10:00';
  await refresh();
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
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === tab));
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
    '<div class="item-time">' + (it.time || '--:--') + '</div>' +
    '<div class="item-main">' +
      '<div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
      '<div class="item-meta">' + (it.note ? it.note + ' · ' : '') + 'by ' + it.creator + ' ' + statusPill(it.status) + '</div>' +
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
      '<div class="item-time">' + (it.time || '--:--') + '</div>' +
      '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
      '<div class="item-meta">' + (it.note || '') + '</div>' +
      '<a class="nav-link" href="' + amapNav(it.lat, it.lng, it.place) + '" target="_blank">🚗 高德导航</a></div>' +
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
}

function selectNavDay(d) { state.navDay = d; state.navOptimized = null; renderNav(); }

function optimizeRoute() {
  const items = state.room.items.filter(i => i.date === state.navDay && (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng);
  if (items.length < 3) { alert('当天点太少，无需优化'); return; }
  // 最近邻：从最早有坐标的点出发，依次选最近的下一个
  const rest = items.slice();
  const ordered = [rest.shift()];
  while (rest.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0, bd = Infinity;
    rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
    ordered.push(rest.splice(bi, 1)[0]);
  }
  state.navOptimized = ordered;
  renderNav();
}

function renderReview() {
  const items = state.room.items;
  const days = [...new Set(items.map(i => i.date))].sort();
  if (!items.length) { $('#reviewList').innerHTML = '<div class="empty">暂无行程可审阅</div>'; return; }

  // 冲突检测：同日期同时间出现多个不同地点
  const byKey = {};
  items.forEach(it => { if (it.time) { const k = it.date + '|' + it.time; (byKey[k] = byKey[k] || []).push(it); } });
  const conflictIds = new Set();
  Object.values(byKey).forEach(arr => {
    if (arr.length > 1 && new Set(arr.map(x => x.place)).size > 1) arr.forEach(x => conflictIds.add(x.id));
  });

  let html = '';
  days.forEach(day => {
    const list = items.filter(i => i.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!list.length) return;
    html += '<div class="day-group"><div class="day-head">📅 ' + day + ' · 共 ' + list.length + ' 条</div>';
    list.forEach(it => {
      const conflict = conflictIds.has(it.id) ? ' conflict' : '';
      html += '<div class="item-row' + conflict + '">' +
        '<div class="item-time">' + (it.time || '--:--') + '</div>' +
        '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + ' ' + statusPill(it.status) + '</div>' +
        '<div class="item-meta">' + (it.note ? it.note + ' · ' : '') + 'by ' + it.creator + '</div>' +
        '<div class="review-actions">' +
          '<button class="b-keep" onclick="setStatus(\'' + it.id + '\',\'kept\')">保留</button>' +
          '<button class="b-merge" onclick="mergeItem(\'' + it.id + '\')">合并</button>' +
          '<button class="b-drop" onclick="deleteItem(\'' + it.id + '\')">删除</button>' +
        '</div></div></div>';
    });
    html += '</div>';
  });
  $('#reviewList').innerHTML = html;
}

// ---------------- 地点联想（输入即自动填经纬度） ----------------
let POIS = [];
async function loadPois() {
  try { POIS = await fetch('/public/pois.json').then(r => r.ok ? r.json() : []); }
  catch (e) { POIS = []; }
}

function fillCoords(p) {
  const f = $('#addForm');
  if (!f) return;
  f.lat.value = p.lat;
  f.lng.value = p.lng;
  if (p.type && f.type.querySelector('option[value="' + p.type + '"]')) f.type.value = p.type;
}

function onPlaceInput() {
  const inp = $('#placeInput');
  const box = $('#poiSuggestions');
  const v = inp.value.trim();
  if (!v) { box.style.display = 'none'; return; }
  const matches = POIS.filter(p => p.name.includes(v) || p.city.includes(v)).slice(0, 8);
  if (!matches.length) { box.style.display = 'none'; return; }
  box.innerHTML = matches.map((p, i) =>
    '<li data-i="' + i + '"><span class="poi-name">' + p.name + '</span>' +
    '<span class="poi-city">' + p.city + ' · ' + (p.type || '') + '</span>' +
    '<span class="poi-coord">' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) + '</span></li>'
  ).join('');
  box._matches = matches;
  box.style.display = 'block';
  const exact = matches.find(p => p.name === v);
  if (exact) fillCoords(exact); // 完全匹配自动填充
}

function selectPoi(i) {
  const box = $('#poiSuggestions');
  const p = box._matches && box._matches[i];
  if (!p) return;
  $('#placeInput').value = p.name;
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
