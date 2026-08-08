// 旅游攻略协作应用 —— 前端逻辑（房间协作 + 自动导航 + 合并审阅） v=20260808c
const APP_VERSION = '20260808c';

// 版本自愈：加载后询问服务端最新版本，不一致则整页跳转到当前版入口（穿透微信缓存）
(function(){
  try {
    fetch('/api/version', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.version && d.version !== APP_VERSION) { location.href = '/?v=' + d.version; }
    }).catch(function(){});
  } catch (e) {}
})();
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ---- 外部脚本按需加载（避免阻塞首屏渲染）----
const _loadedScripts = {};
function loadScript(url) {
  if (_loadedScripts[url]) return _loadedScripts[url];
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Script load failed: ' + url));
    document.head.appendChild(s);
  });
  _loadedScripts[url] = p;
  return p;
}
async function ensureExportLibs() {
  await Promise.all([
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js')
  ]);
}

const state = {
  roomId: null,
  room: null,
  activeTab: 'overview',
  navDay: null,
  navOptimized: null,
  myLocation: null,   // { lat, lng, name } — 用户 GPS 位置
  isViewOnly: false,  // 未设昵称时仅查看模式
  isLoggedIn: false,  // 是否已登录
  userName: null,     // 登录用户名
  userRole: null,      // 'admin' | 'user' | null
  editingItemId: null,   // 正在编辑的行程 ID
  editingExpenseId: null, // 正在编辑的费用 ID
  lastSync: 0,            // 上次同步时间戳
  weather: null,          // 概览页天气数据缓存
  consecutiveFails: 0,    // 连续刷新失败计数
  planSearch: '',         // 行程搜索关键词
  planFilterType: '',     // 行程类型筛选
  planFilterMine: false,  // 仅看我创建的
  planMapMode: false,     // 行程地图视图开关
  reviewSelected: new Set(), // 审阅批量选中
  poiSelectedIndex: -1,       // POI 键盘导航选中下标
  splitMode: 'equal',         // 费用分摊模式: 'equal' | 'custom'
  splitCustomManual: new Set(), // 自定义分摊中已手动修改的人名
  splitCustomValues: {},       // 自定义分摊持久金额 { 人名: 金额 }（内存级，不依赖 DOM）
  receiptData: null,          // 待上传收据 { dataUrl }
  editingReceiptId: null      // 编辑费用时保留的已有收据 ID（未重新上传则沿用）
};

// ---------------- 用户登录系统 ----------------
const AUTH_KEY = 'travel_auth';  // { name, role }

// Toast 轻提示
function showToast(msg, type) {
  type = type || 'info';
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 2400);
}

function loadAuth() {
  // 恢复登录态：已登录用户刷新后保持登录（满足"刷新不用重新登录"，回归清单 #2）
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (raw) {
      const auth = JSON.parse(raw);
      if (auth.name && auth.role) {
        state.userName = auth.name;
        state.userRole = auth.role;
        state.isLoggedIn = true;
        state.authToken = auth.token || null;
      }
    }
  } catch (e) { /* ignore */ }

  // 无论是否登录，游客默认【可见】所有功能入口，操作时再弹登录提示（而非直接隐藏）
  state.isViewOnly = false;
  updateUserBadge();

  // 向服务端校验 token 是否仍有效；失效（如服务端重启清库）则回退为游客，避免"假登录"
  if (state.authToken) {
    fetch('/api/me', { headers: getAuthHeaders() })
      .then(r => {
        if (!r.ok) {
          clearAuth();
          state.isViewOnly = false;
          updateUserBadge();
        }
      })
      .catch(() => { /* 网络不通时保留本地状态 */ });
  }
}

function saveAuth(name, role, token) {
  const auth = { name, role, token };
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
  state.userName = name;
  state.userRole = role;
  state.isLoggedIn = true;
  state.authToken = token || null;
  // 同步到昵称
  localStorage.setItem(NICK_KEY, name);
}

function getAuthHeaders() {
  if (state.authToken) {
    return { 'Authorization': 'Bearer ' + state.authToken };
  }
  return {};
}

function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(NICK_KEY);
  state.userName = null;
  state.userRole = null;
  state.isLoggedIn = false;
  state.authToken = null;
}

function updateUserBadge() {
  const badge = $('#userBadge');
  if (!badge) return;
  const countBadge = $('#roomCountBadge');

  const joinBtn = $('#btnJoinRoom');
  if (state.isLoggedIn) {
    const roleIcon = state.userRole === 'admin' ? '🔓' : '👤';
    badge.textContent = roleIcon + ' ' + state.userName;
    badge.title = state.userRole === 'admin' ? '管理员 · 点击退出登录' : '已登录 · 点击退出登录';
    badge.className = 'user-badge ' + (state.userRole === 'admin' ? 'is-admin' : 'is-logged-in');
    if (countBadge) countBadge.style.display = (state.userRole === 'admin') ? '' : 'none';
    if (joinBtn) joinBtn.style.display = '';
    const tabReview = $('#tabReview');
    if (tabReview) tabReview.style.display = (state.userRole === 'admin') ? '' : 'none';
  } else {
    badge.textContent = '👤 未登录';
    badge.title = '点击登录';
    badge.className = 'user-badge';
    if (countBadge) countBadge.style.display = 'none';
    if (joinBtn) joinBtn.style.display = 'none';
    const tabReview = $('#tabReview');
    if (tabReview) tabReview.style.display = 'none';
  }
}

function showLogin() {
  if (state.isLoggedIn) {
    showInputModal({
      title: '退出登录',
      icon: '🚪',
      hint: '当前账号：' + state.userName + '\n\n确定要退出登录吗？',
      confirmOnly: true
    }, (confirmed) => {
      if (confirmed) {
        clearAuth();
        updateUserBadge();
        // 退出登录后回到仅查看模式
        state.isViewOnly = true;
        const formWrap = document.querySelector('.add-form-wrap');
        if (formWrap) formWrap.style.display = 'none';
        const banner = $('#viewOnlyBanner');
        if (banner) banner.classList.remove('hidden');
      }
    });
    return;
  }

  const overlay = $('#loginOverlay');
  const nameInput = $('#loginName');
  const passInput = $('#loginPass');
  const errDiv = $('#loginError');
  const submitBtn = $('#loginSubmit');
  const cancelBtn = $('#loginCancel');

  overlay.classList.remove('hidden');
  nameInput.value = '';
  passInput.value = '';
  errDiv.classList.add('hidden');
  nameInput.focus();

  function cleanup() {
    submitBtn.removeEventListener('click', doLogin);
    cancelBtn.removeEventListener('click', doCancel);
    nameInput.removeEventListener('keydown', onKey);
    passInput.removeEventListener('keydown', onKey);
  }

  function doCancel() {
    overlay.classList.add('hidden');
    cleanup();
  }

  async function doLogin() {
    const name = nameInput.value.trim();
    const pass = passInput.value;
    if (!name) { nameInput.focus(); return; }
    if (!pass) { passInput.focus(); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    errDiv.classList.add('hidden');

    try {
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password: pass })
      });
      const data = await resp.json();
      if (data.ok) {
        saveAuth(data.name, data.role, data.token);
        updateUserBadge();
        overlay.classList.add('hidden');
        cleanup();
        // 确保协作模式打开
        state.isViewOnly = false;
        const formWrap = document.querySelector('.add-form-wrap');
        if (formWrap) formWrap.style.display = '';
        const banner = $('#viewOnlyBanner');
        if (banner) banner.classList.add('hidden');
        // 同步 creator 字段
        const c = $('#addForm')?.creator;
        if (c) c.value = data.name;
      } else {
        errDiv.textContent = data.error || '登录失败';
        errDiv.classList.remove('hidden');
      }
    } catch (e) {
      errDiv.textContent = '服务器连接失败，请稍后重试';
      errDiv.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      if (document.activeElement === nameInput) passInput.focus();
      else doLogin();
    }
  }

  submitBtn.addEventListener('click', doLogin);
  cancelBtn.addEventListener('click', doCancel);
  nameInput.addEventListener('keydown', onKey);
  passInput.addEventListener('keydown', onKey);
}

// ---------------- 用户昵称 & 欢迎流程 ----------------
// ---------------- 天气数据 ----------------
const WEATHER_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌧️', 53: '🌧️', 55: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '❄️', 73: '❄️', 75: '❄️',
  80: '🌦️', 81: '🌧️', 82: '🌧️',
  95: '⛈️', 96: '⛈️', 99: '⛈️'
};
const WEATHER_TEXT = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  71: '小雪', 73: '中雪', 75: '大雪',
  80: '阵雨', 81: '中阵雨', 82: '大阵雨',
  95: '雷暴', 96: '雷暴+冰雹', 99: '强雷暴+冰雹'
};

let weatherCache = { data: null, ts: 0 };
const WEATHER_CACHE_TTL = 30 * 60 * 1000; // 30 分钟缓存

async function fetchWeather() {
  // 取所有行程坐标的「中心点」作为预报定位（澳门珠海广州多地游的折中，比只取第一个点更准）
  let lat = 22.2, lng = 113.55;
  const allItems = (state.room && state.room.items || []).filter(i => i.status !== 'dropped');
  const itemsWithCoords = allItems.filter(i => i.lat && i.lng);
  if (itemsWithCoords.length > 0) {
    lat = itemsWithCoords.reduce((s, i) => s + i.lat, 0) / itemsWithCoords.length;
    lng = itemsWithCoords.reduce((s, i) => s + i.lng, 0) / itemsWithCoords.length;
  }
  const days = [...new Set(allItems.map(i => i.date))].sort();
  const start = days[0] || null;
  const end = days[days.length - 1] || null;

  if (!start || !end) return null;

  const cacheKey = lat.toFixed(2) + ',' + lng.toFixed(2) + '|' + start + '|' + end;
  const now = Date.now();
  if (weatherCache.data && weatherCache.key === cacheKey && (now - weatherCache.ts) < WEATHER_CACHE_TTL) {
    return weatherCache.data;
  }

  try {
    const resp = await fetch('/api/weather?lat=' + lat + '&lng=' + lng + '&start=' + start + '&end=' + end);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.daily) return null;
    weatherCache = { data, key: cacheKey, ts: now };
    return data;
  } catch (e) {
    return null;
  }
}

function renderWeatherHTML(data, items) {
  if (!data || !data.daily || !data.daily.time || !data.daily.time.length) return '';
  const times = data.daily.time;
  const maxTemps = data.daily.temperature_2m_max || [];
  const minTemps = data.daily.temperature_2m_min || [];
  const codes = data.daily.weathercode || [];
  const precips = data.daily.precipitation_probability_max || [];
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // 为每天匹配地点：取当天第一个行程的地点名
  const dateToPlace = {};
  if (items && items.length > 0) {
    items.forEach(it => {
      if (it.date && it.place && !dateToPlace[it.date]) {
        dateToPlace[it.date] = it.place;
      }
    });
  }

  let cards = '';
  for (let i = 0; i < times.length; i++) {
    const d = new Date(times[i] + 'T00:00:00+08:00');
    const dayLabel = dayNames[d.getDay()];
    const dateLabel = (d.getMonth() + 1) + '/' + d.getDate();
    const code = codes[i] ?? 0;
    const icon = WEATHER_ICONS[code] || '🌡️';
    const text = WEATHER_TEXT[code] || '未知';
    const maxT = Math.round(maxTemps[i] ?? 0);
    const minT = Math.round(minTemps[i] ?? 0);
    const precip = precips[i] != null ? precips[i] : null;
    const placeName = dateToPlace[times[i]] || null;

    cards += '<div class="dash-cd-wx-card">';
    cards += '<div class="dash-cd-wx-row">';
    cards += '<div class="dash-cd-wx-left">';
    cards += '<div class="dash-cd-wx-date">' + dateLabel + ' ' + dayLabel + '</div>';
    if (placeName) cards += '<div class="dash-cd-wx-loc">📍 ' + escHtml(placeName) + '</div>';
    cards += '</div>';
    cards += '<div class="dash-cd-wx-icon">' + icon + '</div>';
    cards += '<div class="dash-cd-wx-mid">';
    cards += '<div class="dash-cd-wx-text">' + text + '</div>';
    if (precip !== null) cards += '<div class="dash-cd-wx-precip">💧 降雨 ' + precip + '%</div>';
    cards += '</div>';
    cards += '<div class="dash-cd-wx-temp">' + maxT + '°<span class="dash-cd-wx-lo">/' + minT + '°</span></div>';
    cards += '</div>';
    cards += '</div>';
  }

  // 纵向轮播：轨道 + 圆点指示器（逻辑见 startWeatherCarousel）
  return '<div class="dash-cd-wx-carousel-wrap">' +
           '<div class="dash-cd-wx-carousel" id="dashWxCarousel">' +
             '<div class="dash-cd-wx-track" id="dashWxTrack">' + cards + '</div>' +
           '</div>' +
           '<div class="dash-cd-wx-dots" id="dashWxDots"></div>' +
         '</div>';
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function initWeather() {
  // 避免重复请求：已经有数据或正在请求中
  if (state.weather) return;
  state.weather = 'loading';
  render(); // 显示 loading

  const data = await fetchWeather();
  state.weather = data || null;
  render(); // 渲染天气
}

// ---------------- 天气纵向轮播 ----------------
let wxCarouselTimer = null;
let wxCarouselIdx = 0;
function startWeatherCarousel() {
  if (wxCarouselTimer) { clearInterval(wxCarouselTimer); wxCarouselTimer = null; }
  const carousel = document.getElementById('dashWxCarousel');
  const track = document.getElementById('dashWxTrack');
  const dotsBox = document.getElementById('dashWxDots');
  if (!carousel || !track) return;
  const cards = track.children;
  const n = cards.length;
  if (n <= 1) return; // 单张无需轮播

  // 圆点指示器
  if (dotsBox) {
    dotsBox.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const dot = document.createElement('span');
      dot.className = 'dash-cd-wx-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', () => goTo(i));
      dotsBox.appendChild(dot);
    }
  }
  // 固定可视高度 = 单张卡片高度（不含间距），只露一张 + 下一张微露
  function cardStep() { return cards[0].offsetHeight + 8; } // 8 = track 的 gap
  function goTo(i) {
    wxCarouselIdx = (i + n) % n;
    carousel.style.height = cards[wxCarouselIdx].offsetHeight + 'px';
    track.style.transform = 'translateY(' + (-wxCarouselIdx * cardStep()) + 'px)';
    if (dotsBox) {
      Array.prototype.forEach.call(dotsBox.children, (d, k) => d.classList.toggle('active', k === wxCarouselIdx));
    }
  }
  goTo(0);
  const step = () => goTo(wxCarouselIdx + 1);
  wxCarouselTimer = setInterval(step, 3200);
  carousel.onmouseenter = () => { if (wxCarouselTimer) { clearInterval(wxCarouselTimer); wxCarouselTimer = null; } };
  carousel.onmouseleave = () => { if (!wxCarouselTimer) wxCarouselTimer = setInterval(step, 3200); };
}

const NICK_KEY = 'travel_nickname';

function getNickname() {
  return localStorage.getItem(NICK_KEY) || '';
}

function setNickname(name, silent) {
  const n = (name || '').trim().slice(0, 10);
  localStorage.setItem(NICK_KEY, n);
  refreshUserBadge();
  // 自动填入隐藏的创建人字段
  if (!silent) {
    const c = $('#addForm')?.creator;
    if (c) c.value = n;
  }
}

function refreshUserBadge() {
  if (state.isLoggedIn) {
    updateUserBadge();
    return;
  }
  // 未登录 → 永远显示"未登录"，不再读取 localStorage 昵称
  const b = $('#userBadge');
  if (b) {
    b.textContent = '👤 未登录';
    b.title = '点击登录';
  }
}

async function changeNickname() {
  if (!state.isLoggedIn) {
    // 未登录用户不能改昵称，引导登录
    showInputModal({
      title: '需要登录',
      icon: '🔒',
      hint: '你当前是游客身份。\n\n请先登录账号后参与协作。',
      confirmOnly: true
    }, (confirmed) => {
      if (confirmed) showLogin();
    });
    return;
  }
  // 已登录用户不可改名，提示退出登录
  const ok = await promptInput({
    title: '退出登录',
    icon: '🚪',
    hint: '你当前以「' + state.userName + '」身份登录。\n要使用其他名字，请先退出登录。\n\n是否退出登录？',
    confirmOnly: true
  });
  if (ok) {
    clearAuth();
    updateUserBadge();
    state.isViewOnly = true;
    const formWrap = document.querySelector('.add-form-wrap');
    if (formWrap) formWrap.style.display = 'none';
    const banner = $('#viewOnlyBanner');
    if (banner) banner.classList.remove('hidden');
  }
}

// 欢迎弹窗 — 显示房间信息 + 引导登录
function showWelcome() {
  const overlay = $('#welcomeOverlay');
  const input = $('#nickInput');
  const confirmBtn = $('#nickConfirm');
  const skipBtn = $('#nickSkip');
  const title = $('#welcomeTitle');
  const info = $('#welcomeInfo');

  if (!overlay) return;

  // 填充房间信息
  const r = state.room;
  if (r) {
    title.textContent = '欢迎来到「' + (r.name || '旅行攻略') + '」';
    const items = r.items || [];
    const creators = new Set(items.map(i => i.creator || '匿名'));
    const days = [...new Set(items.map(i => i.date))].sort();
    info.innerHTML =
      '<span>👥 ' + creators.size + ' 人参与</span>' +
      '<span>📍 ' + items.length + ' 条行程</span>' +
      (days.length ? '<span>📅 ' + days[0] + ' ~ ' + days[days.length - 1] + '</span>' : '');
  } else {
    title.textContent = '创建新的旅行攻略';
    info.innerHTML = '<span>📝 还没有行程，来创建第一条吧</span>';
  }

  // 隐藏昵称输入框，改为提示文字
  input.style.display = 'none';
  confirmBtn.textContent = '🔑 登录账号';
  skipBtn.textContent = '👀 仅浏览';

  overlay.classList.remove('hidden');

  function doSkip() {
    state.isViewOnly = true;
    overlay.classList.add('hidden');
    updateRoomInfo();
    render();
    const formWrap = document.querySelector('.add-form-wrap');
    if (formWrap) formWrap.style.display = 'none';
    const banner = $('#viewOnlyBanner');
    if (banner) banner.classList.remove('hidden');
    cleanup();
  }

  function doConfirm() {
    overlay.classList.add('hidden');
    cleanup();
    showLogin();
  }

  function onKey(e) { if (e.key === 'Enter') doConfirm(); if (e.key === 'Escape') doSkip(); }

  function cleanup() {
    confirmBtn.removeEventListener('click', doConfirm);
    skipBtn.removeEventListener('click', doSkip);
    document.removeEventListener('keydown', onKey);
  }

  confirmBtn.addEventListener('click', doConfirm);
  skipBtn.addEventListener('click', doSkip);
  document.addEventListener('keydown', onKey);
  confirmBtn.focus();
}

function initNickname() {
  // 已登录用户 → 使用登录名
  if (state.isLoggedIn && state.userName) {
    state.isViewOnly = false;
    const c = $('#addForm')?.creator;
    if (c) c.value = state.userName;
    refreshUserBadge();
    return;
  }

  // 未登录（游客）→ 可见所有功能入口，但任何写操作都会被 !isLoggedIn 守卫拦截并要求登录
  state.isViewOnly = false;
  refreshUserBadge();
}

// 房间信息卡片
function updateRoomInfo() {
  const card = $('#roomInfoCard');
  if (!card || !state.room) return;
  const r = state.room;
  const items = r.items || [];
  const creators = new Set(items.map(i => i.creator || '匿名'));
  const days = [...new Set(items.map(i => i.date))].sort();
  const kept = items.filter(i => i.status === 'kept' || i.status === 'proposed');

  card.classList.remove('hidden');

  $('#riName').textContent = '🏠 ' + (r.name || '旅行攻略');
  $('#riRoomId').textContent = '#' + state.roomId;
  let stats = '👥 ' + (r.people || []).length + '人 · 📍 ' + kept.length + '条行程';
  if (days.length) stats += ' · 📅 ' + days[0];
  if (days.length > 1) stats += '~' + days[days.length - 1];
  $('#riStats').textContent = stats;

  // 在线人数
  const online = (r.online || []);
  const elOnline = $('#riOnline');
  if (elOnline) {
    elOnline.textContent = online.length + '人';
    // 更新小圆点颜色（有人在线绿色，无人灰色）
    const elHint = elOnline.closest('.ri-hint');
    if (elHint) elHint.textContent = elHint.textContent.replace(/^[🟢⚪]\s*/, (online.length > 0 ? '🟢 ' : '⚪ '));
  }
  const travelersDiv = $('#riTravelers');
  if (travelersDiv && (r.people || []).length > 0) {
    travelersDiv.style.display = '';
    $('#riTravelerList').textContent = (r.people || []).join('、');
    // 管理员可见编辑按钮
    const btn = $('#btnEditTravelers');
    if (btn) btn.style.display = (state.userRole === 'admin') ? '' : 'none';
  } else if (travelersDiv) {
    travelersDiv.style.display = 'none';
  }
}

// ---------------- 备注折叠 ----------------
function toggleNote() {
  const field = $('#noteField');
  const input = field.querySelector('textarea');
  const toggle = field.querySelector('.note-toggle');
  if (input.style.display === 'none') {
    input.style.display = '';
    toggle.style.display = 'none';
    input.focus();
  } else {
    input.style.display = 'none';
    input.value = '';
    toggle.style.display = '';
  }
}

// ---------------- 费用模块（独立） ----------------
const EXPENSE_CATEGORIES = {
  '餐饮': '🍜', '交通': '🚗', '门票': '🎫', '住宿': '🏨', '购物': '🛍️', '其他': '💡'
};

function getExpensePeople() {
  // 出行人是唯一权威：费用表单的人选严格等于出行人列表，与登录账号无关（登录账号不会出现在账单人选里）
  return [...(state.room.people || [])];
}

function refreshExpenseFormOptions() {
  const f = $('#expenseForm');
  if (!f) return;
  // 付款人下拉
  const people = getExpensePeople();
  const payerSel = f.payer;
  const curPayer = payerSel.value;
  payerSel.innerHTML = '<option value="">选择付款人</option>' + people.map(p => '<option value="' + p + '">' + p + '</option>').join('');
  if (curPayer) payerSel.value = curPayer;
  // 不自动设置默认付款人，由用户手动选择

  // 关联行程下拉
  const items = (state.room.items || []).filter(i => i.status === 'kept' || i.status === 'proposed');
  const linkedSel = f.linkedItemId;
  const curLink = linkedSel.value;
  linkedSel.innerHTML = '<option value="">不关联</option>' + items.map(it =>
    '<option value="' + it.id + '">' + it.date + ' ' + (it.time || '') + ' ' + it.place + '</option>'
  ).join('');
  linkedSel.value = curLink;

  // 分摊人列表
  refreshSplitPeople();
}

let _cachedSplitPeople = '';  // 缓存上次的分摊人员列表，避免不必要的 DOM 重建

function refreshSplitPeople() {
  const box = $('#splitPeople');
  if (!box) return;
  const people = getExpensePeople();
  const peopleKey = people.join(',');
  const f = $('#expenseForm');
  const checked = new Set();
  box.querySelectorAll('input:checked').forEach(c => checked.add(c.value));
  // 默认全选
  if (checked.size === 0) people.forEach(p => checked.add(p));
  box.innerHTML = people.map(p =>
    '<label class="split-person"><input type="checkbox" value="' + p + '" ' + (checked.has(p) ? 'checked' : '') + ' onchange="updateSplitCustomAmounts()" /><span>' + p + '</span></label>'
  ).join('');
  // 只在人员列表真正变化时才重建自定义分摊金额（避免每次 render 都销毁用户正在输入的 DOM）
  if (state.splitMode === 'custom' && peopleKey !== _cachedSplitPeople) {
    _cachedSplitPeople = peopleKey;
    updateSplitCustomAmounts();
  }
}

function switchSplitMode(mode) {
  // 只在真正切换模式时清空手动标记（同模式不重复清空）
  if (state.splitMode !== mode) {
    state.splitCustomManual = new Set();
    state.splitCustomValues = {};
  }
  state.splitMode = mode;
  const btnEq = $('#splitModeEqual');
  const btnCustom = $('#splitModeCustom');
  const box = $('#splitCustomAmounts');
  if (btnEq) btnEq.classList.toggle('active', mode === 'equal');
  if (btnCustom) btnCustom.classList.toggle('active', mode === 'custom');
  if (box) box.classList.toggle('hidden', mode !== 'custom');
  if (mode === 'custom') updateSplitCustomAmounts();
}

// ──── 自定义分摊核心：提取公共分发逻辑 ────
// 返回 { manualPeople, unsetPeople } 两个数组
function _calcSplitDistribution() {
  const amount = parseFloat($('#expenseForm').amount.value) || 0;
  const checked = [];
  $$('#splitPeople input:checked').forEach(c => checked.push(c.value));

  const ms = state.splitCustomManual;

  // 1. 清理 manualSet：移除非勾选的人，并同步清理持久值
  [...ms].forEach(p => {
    if (!checked.includes(p)) {
      ms.delete(p);
      delete state.splitCustomValues[p];
    }
  });

  // 2. 分类：手动 vs 未手动
  const manualPeople = [];
  const unsetPeople = [];
  let manualTotal = 0;

  checked.forEach(p => {
    if (ms.has(p)) {
      // 优先从持久化内存中读取（不依赖 DOM）
      const val = state.splitCustomValues[p] || 0;
      manualTotal += val;
      manualPeople.push({ name: p, value: val });
    } else {
      unsetPeople.push(p);
    }
  });

  // 3. 只有当手动总和超过总额时才回退到均分；
  //    如果手动金额刚好分完、又新增/减人了，保留手动值，把剩余（可能为 0）均分给未手动的人
  const remaining = Math.max(0, amount - manualTotal);
  if (manualTotal > amount) {
    ms.clear();
    state.splitCustomValues = {};
    // 全部归为未手动
    for (const mp of manualPeople) unsetPeople.push(mp.name);
    return { manualPeople: [], unsetPeople, unsetPeopleNew: checked, amount };
  }

  // 4. 计算均分份额
  let eqShare = 0;
  if (unsetPeople.length > 0) eqShare = remaining / unsetPeople.length;

  return { manualPeople, unsetPeople, eqShare, amount };
}

// 自定义分摊金额输入框（全量重建 HTML）
function updateSplitCustomAmounts() {
  const box = $('#splitCustomAmounts');
  if (!box || state.splitMode !== 'custom') return;

  const dist = _calcSplitDistribution();

  // 全重置：手动总和 > 总额，或新增人选且全部手动已分完
  if (dist.unsetPeopleNew) {
    const eqShare = (dist.amount / dist.unsetPeopleNew.length).toFixed(2);
    buildSplitHTML(dist.unsetPeopleNew.map(p => ({ name: p, value: parseFloat(eqShare) })));
    return;
  }

  // 无勾选的人
  if (dist.manualPeople.length === 0 && dist.unsetPeople.length === 0) {
    box.innerHTML = '<div class="split-custom-check">请先选择分摊人</div>';
    return;
  }

  // 合并手动 + 未手动，构建完整列表
  const all = [];
  dist.manualPeople.forEach(mp => all.push(mp));
  dist.unsetPeople.forEach(p => all.push({ name: p, value: dist.eqShare }));

  buildSplitHTML(all);
}

function buildSplitHTML(allPeople) {
  const box = $('#splitCustomAmounts');
  if (!box) return;

  const currency = 'CNY';
  const sym = '¥';
  const amount = parseFloat($('#expenseForm').amount.value) || 0;

  let html = '';
  allPeople.forEach(item => {
    const person = item.name || item;
    const val = typeof item.value === 'number' ? item.value.toFixed(2) : item.value;
    html += '<div class="split-custom-row">' +
      '<span class="split-custom-name">' + person + '</span>' +
      '<input type="number" class="split-custom-input" data-person="' + person + '" value="' + val + '" step="0.01" min="0" oninput="onSplitCustomChange(this)" onfocus="this.select()" />' +
      '<span class="split-custom-currency">' + sym + '</span>' +
    '</div>';
  });
  html += '<div class="split-custom-check">✅ 总和: <span id="splitCustomSum">' + sym + amount.toFixed(2) + '</span> / 总额: <span id="splitCustomTarget">' + sym + amount.toFixed(2) + '</span></div>';
  box.innerHTML = html;
  updateSplitCustomSum();
}

function updateSplitCustomSum() {
  const sumEl = $('#splitCustomSum');
  if (!sumEl) return;
  let sum = 0;
  const inputs = $$('#splitCustomAmounts .split-custom-input');
  inputs.forEach(inp => sum += parseFloat(inp.value) || 0);
  const currency = 'CNY';
  const sym = '¥';
  const target = parseFloat($('#expenseForm').amount.value) || 0;
  sumEl.textContent = sym + sum.toFixed(2);
  sumEl.className = Math.abs(sum - target) < 0.01 ? 'split-sum-ok' : 'split-sum-mismatch';
  const targetEl = $('#splitCustomTarget');
  if (targetEl) targetEl.textContent = sym + target.toFixed(2);
}

// 自定义分摊金额手动变更 —— 标记该人，剩余金额自动均分给未手动设置的人
function onSplitCustomChange(input) {
  const person = input.dataset.person;
  if (!person) return;
  state.splitCustomManual.add(person);
  // 持久化当前输入值
  state.splitCustomValues[person] = parseFloat(input.value) || 0;

  // 用统一的分发逻辑，然后只更新未手动者的 DOM（不重建 HTML，保留输入焦点）
  const dist = _calcSplitDistribution();

  // 全重置 → 直接调用 updateSplitCustomAmounts 重建
  if (dist.unsetPeopleNew) { updateSplitCustomAmounts(); return; }
  if (dist.manualPeople.length === 0 && dist.unsetPeople.length === 0) return;

  dist.unsetPeople.forEach(p => {
    const inp = $('#splitCustomAmounts [data-person="' + p + '"]');
    if (inp) inp.value = dist.eqShare !== undefined ? dist.eqShare.toFixed(2) : '0.00';
  });

  updateSplitCustomSum();
}

// 金额变更时联动更新自定义分摊（仅在金额字段变更时触发，不在 render 时触发）
// 注：不再 hook refreshExpenseFormOptions，避免每次 render() 都销毁重建自定义分摊 DOM
(function hookExpenseAmount() {
  const f = $('#expenseForm');
  if (!f || !f.amount) return;
  f.amount.addEventListener('input', function() {
    if (state.splitMode === 'custom') updateSplitCustomAmounts();
  });
  // 分摊人选变更也联动
  const splitBox = $('#splitPeople');
  if (splitBox) {
    splitBox.addEventListener('change', function(e) {
      if (e.target.type === 'checkbox' && state.splitMode === 'custom') {
        updateSplitCustomAmounts();
      }
    });
  }
})();

function initExpenseForm() {
  const f = $('#expenseForm');
  if (!f) return;
  f.date.value = new Date().toISOString().slice(0, 10);
  const now = new Date();
  f.time.value = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  f.createdBy.value = state.userName || '';
  clearReceipt();
  refreshExpenseFormOptions();
}

// ---------------- 收据照片 ----------------
function pickReceipt() {
  const inp = $('#receiptFile');
  if (inp) inp.click();
}

function handleReceiptSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    showToast('图片不能超过 2MB', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(ev) {
    state.receiptData = { dataUrl: ev.target.result };
    const img = $('#receiptImg');
    const preview = $('#receiptPreview');
    const btn = $('#btnPickReceipt');
    if (img) img.src = ev.target.result;
    if (preview) preview.classList.remove('hidden');
    if (btn) btn.classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

function clearReceipt() {
  state.receiptData = null;
  state.editingReceiptId = null; // 清除时同时放弃已有收据（编辑场景=移除）
  const preview = $('#receiptPreview');
  const btn = $('#btnPickReceipt');
  const inp = $('#receiptFile');
  if (preview) preview.classList.add('hidden');
  if (btn) btn.classList.remove('hidden');
  if (inp) inp.value = '';
}

async function uploadReceipt() {
  if (!state.receiptData) return null;
  try {
    const resp = await fetch('/api/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ image: state.receiptData.dataUrl })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '上传失败');
    }
    const result = await resp.json();
    return result.id; // receipt ID
  } catch (err) {
    showToast('收据上传失败: ' + err.message, 'error');
    return null;
  }
}

function viewReceipt(receiptId) {
  const url = '/api/receipt/' + receiptId; // 服务端按 ID 前缀解析，扩展名无关
  showImageModal(url);
}

function showImageModal(url) {
  // 移除已有弹窗
  const existing = $('.img-viewer-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'img-viewer-overlay';
  overlay.innerHTML = '<div class="img-viewer-content"><img src="' + url + '" loading="eager" /><button class="img-viewer-close" onclick="this.closest(\'.img-viewer-overlay\').remove()">✕</button></div>';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  // ESC 关闭
  const onEsc = function(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
}

// ---------------- 行程提醒（Browser Notification） ----------------
let reminderInterval = null;
let remindersEnabled = false;
let notifiedSet = new Set(); // 已通知的 item 集合（日期+时间+地点 hash）

function initReminders() {
  remindersEnabled = localStorage.getItem('travel_reminders') === '1';
  updateReminderButton();
  if (remindersEnabled) {
    requestReminderPermission(true); // 静默模式，不弹 toast
  }
}

function toggleReminders() {
  remindersEnabled = !remindersEnabled;
  localStorage.setItem('travel_reminders', remindersEnabled ? '1' : '0');
  updateReminderButton();
  if (remindersEnabled) {
    requestReminderPermission();
  } else {
    stopReminders();
    showToast('行程提醒已关闭', 'info');
  }
}

function updateReminderButton() {
  const btn = $('#btnReminder');
  if (!btn) return;
  btn.textContent = remindersEnabled ? '🔔' : '🔕';
  btn.title = remindersEnabled ? '行程提醒已开启' : '行程提醒已关闭';
  btn.style.opacity = remindersEnabled ? '1' : '0.4';
}

function requestReminderPermission(silent) {
  if (!('Notification' in window)) {
    if (!silent) showToast('当前浏览器不支持通知功能', 'error');
    remindersEnabled = false;
    localStorage.setItem('travel_reminders', '0');
    updateReminderButton();
    return;
  }
  if (Notification.permission === 'granted') {
    startReminders();
  } else if (Notification.permission === 'denied') {
    if (!silent) showToast('通知权限已被拒绝，请在浏览器设置中开启', 'error');
    remindersEnabled = false;
    localStorage.setItem('travel_reminders', '0');
    updateReminderButton();
  } else {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') {
        startReminders();
        if (!silent) showToast('行程提醒已开启 ✅', 'success');
      } else {
        if (!silent) showToast('需要允许通知才能使用提醒功能', 'error');
        remindersEnabled = false;
        localStorage.setItem('travel_reminders', '0');
        updateReminderButton();
      }
    });
  }
}

function startReminders() {
  if (reminderInterval) return;
  checkUpcomingReminders();
  reminderInterval = setInterval(checkUpcomingReminders, 60000); // 每分钟检查
}

function stopReminders() {
  if (reminderInterval) { clearInterval(reminderInterval); reminderInterval = null; }
  notifiedSet.clear();
}

function checkUpcomingReminders() {
  if (!remindersEnabled || !state.room) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const now = new Date();
  const items = (state.room.items || []).filter(i =>
    (i.status === 'kept' || i.status === 'proposed') && i.time && i.date);
  
  items.forEach(it => {
    const [h, m] = (it.time || '').split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return;
    const itemTime = new Date(it.date + 'T' + it.time + ':00');
    if (isNaN(itemTime.getTime())) return;
    
    const diffMin = (itemTime - now) / 60000;
    // 提前 5-35 分钟提醒（因为每分钟检查一次）
    if (diffMin > 1 && diffMin <= 35) {
      const key = it.date + '|' + it.time + '|' + it.place;
      if (notifiedSet.has(key)) return;
      notifiedSet.add(key);
      
      const typeIcon = { '景点': '🏛️', '餐饮': '🍜', '住宿': '🏨', '交通': '🚗' }[it.type] || '📌';
      const minAway = Math.round(diffMin);
      new Notification('⏰ 行程提醒', {
        body: typeIcon + ' ' + it.place + '\n' + it.time + ' · 还有 ' + minAway + ' 分钟',
        icon: '/public/icon-192.png',
        tag: key,
        requireInteraction: true
      });
    }
  });
}

// 每天重置已通知列表（跨天）
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) notifiedSet.clear();
}, 60000);

async function addExpense(e) {
  e.preventDefault();
  if (!state.isLoggedIn) {
    promptInput({ title: '权限不足', icon: '🔒', hint: '你当前是游客身份，无法记录费用。\n请先登录账号。', confirmOnly: true });
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = '记录中…'; }
  const f = e.target;

  // 上传收据照片
  let receiptId = null;
  if (state.receiptData) {
    if (btn) btn.textContent = '上传收据…';
    receiptId = await uploadReceipt();
  } else if (state.editingExpenseId && state.editingReceiptId) {
    // 编辑模式且未重新上传 → 保留原有收据
    receiptId = state.editingReceiptId;
  }

  const typeRadio = f.querySelector('input[name="category"]:checked');
  const splitPeople = [];
  f.querySelectorAll('#splitPeople input:checked').forEach(c => splitPeople.push(c.value));

  // 付款人必须从出行人里选（与登录账号无关，不允许默认成登录账号）
  if (!f.payer.value) {
    promptInput({ title: '请选择付款人', icon: '⚠️', hint: '付款人必须是出行人之一，请在下拉框选择一个出行人。', confirmOnly: true });
    if (btn) { btn.disabled = false; btn.textContent = '记录费用'; }
    return;
  }

  // 自定义分摊金额（从持久化内存读取，只保留已勾选的人）
  let splitAmounts = null;
  if (state.splitMode === 'custom') {
    splitAmounts = {};
    const keys = Object.keys(state.splitCustomValues);
    if (keys.length > 0) {
      keys.forEach(k => {
        if (splitPeople.includes(k)) splitAmounts[k] = state.splitCustomValues[k];
      });
    } else {
      // 兜底：从 DOM 读取
      const inputs = $$('#splitCustomAmounts .split-custom-input');
      inputs.forEach(inp => {
        if (inp.dataset.person && splitPeople.includes(inp.dataset.person)) {
          splitAmounts[inp.dataset.person] = parseFloat(inp.value) || 0;
        }
      });
    }
  }

  const exp = {
    date: f.date.value,
    time: f.time.value || '',
    category: typeRadio ? typeRadio.value : '其他',
    description: f.description.value.trim(),
    amount: parseFloat(f.amount.value) || 0,
    currency: 'CNY',
    payer: f.payer.value || '',
    splitAmong: splitPeople.length > 0 ? splitPeople : getExpensePeople(),
    splitAmounts: splitAmounts,
    linkedItemId: f.linkedItemId.value || null,
    createdBy: f.createdBy.value.trim() || state.userName || '匿名',
    receiptId: receiptId
  };

  try {
    if (state.editingExpenseId) {
      const resp = await fetch('/api/rooms/' + state.roomId + '/expenses/' + state.editingExpenseId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(exp)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || '服务器返回 ' + resp.status);
      }
      cancelEditExpense();
      await refresh();
      showToast('费用已更新 ✅', 'success');
    } else {
      const resp = await fetch('/api/rooms/' + state.roomId + '/expenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(exp)
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || '服务器返回 ' + resp.status);
      }
      cancelEditExpense();
      await refresh();
      showToast('费用已记录 ✅', 'success');
    }
  } catch (err) {
    promptInput({ title: '操作失败', icon: '❌', hint: err.message || '网络异常', confirmOnly: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = state.editingExpenseId ? '💾 保存修改' : '＋ 记一笔'; }
  }
}

function editExpense(id) {
  if (!state.isLoggedIn) {
    promptInput({ title: '权限不足', icon: '🔒', hint: '请先登录账号。', confirmOnly: true });
    return;
  }
  const expenses = state.room.expenses || [];
  const exp = expenses.find(e => e.id === id);
  if (!exp) return;

  // 只有管理员和费用创建者可以编辑
  if (state.userRole !== 'admin' && state.userName !== exp.createdBy) {
    promptInput({ title: '权限不足', icon: '🔒', hint: '只能编辑自己创建的费用记录。', confirmOnly: true });
    return;
  }
  state.editingExpenseId = id;
  state.editingReceiptId = exp.receiptId || null; // 保留已有收据

  // 展示已有收据（可查看，✕ 可移除）
  const recvImg = $('#receiptImg');
  const recvPrev = $('#receiptPreview');
  const recvBtn = $('#btnPickReceipt');
  if (state.editingReceiptId && recvImg && recvPrev) {
    recvImg.src = '/api/receipt/' + state.editingReceiptId;
    recvPrev.classList.remove('hidden');
    if (recvBtn) recvBtn.classList.add('hidden');
  } else if (recvPrev && recvBtn) {
    recvPrev.classList.add('hidden');
    recvBtn.classList.remove('hidden');
  }

  const f = $('#expenseForm');
  refreshExpenseFormOptions();
  f.date.value = exp.date || new Date().toISOString().slice(0, 10);
  f.time.value = exp.time || '';
  f.description.value = exp.description || '';
  f.amount.value = exp.amount || '';
  f.payer.value = exp.payer || '';
  f.linkedItemId.value = exp.linkedItemId || '';

  // 分类选择
  const catRadio = f.querySelector('input[name="category"][value="' + exp.category + '"]');
  if (catRadio) catRadio.checked = true;

  // 分摊人
  if (exp.splitAmong && exp.splitAmong.length > 0) {
    refreshSplitPeople();
    f.querySelectorAll('#splitPeople input').forEach(c => {
      c.checked = exp.splitAmong.includes(c.value);
    });
  }

  // 自定义分摊金额
  if (exp.splitAmounts && Object.keys(exp.splitAmounts).length > 0) {
    switchSplitMode('custom');
    // 先把值写入持久化状态
    Object.keys(exp.splitAmounts).forEach(p => {
      state.splitCustomManual.add(p);
      state.splitCustomValues[p] = exp.splitAmounts[p];
    });
    // 延迟一帧等 DOM 渲染完成后填值
    setTimeout(() => {
      $$('#splitCustomAmounts .split-custom-input').forEach(inp => {
        const val = exp.splitAmounts[inp.dataset.person];
        if (val !== undefined) inp.value = val;
      });
      updateSplitCustomSum();
    }, 50);
  } else {
    switchSplitMode('equal');
  }

  f.createdBy.value = exp.createdBy || state.userName || '';
  $('#btnSubmitExpense').textContent = '💾 保存修改';
  $('#expenseFormTitle').classList.add('editing');
  $('#expEditCancel').classList.remove('hidden');
  // 若表单默认收起，编辑时自动展开
  const ewrap = document.getElementById('expenseFormWrap');
  if (ewrap) ewrap.classList.remove('collapsed');
  document.querySelector('.expense-form-wrap').scrollIntoView({ behavior: 'smooth' });
  f.amount.focus();
}

function cancelEditExpense() {
  state.editingExpenseId = null;
  state.editingReceiptId = null;
  state.splitMode = 'equal';
  state.splitCustomManual = new Set();
  state.splitCustomValues = {};
  switchSplitMode('equal');
  const f = $('#expenseForm');
  f.reset();
  initExpenseForm();
  $('#btnSubmitExpense').textContent = '＋ 记一笔';
  $('#expenseFormTitle').classList.remove('editing');
  $('#expEditCancel').classList.add('hidden');
}

async function deleteExpense(id) {
  const expenses = state.room.expenses || [];
  const exp = expenses.find(e => e.id === id);
  if (!exp) return;
  const desc = exp.description || exp.category;
  const ok = await promptInput({
    title: '删除费用记录',
    icon: '🗑️',
    hint: '确定删除「' + desc + ' · ' + (exp.currency === 'MOP' ? 'MOP$' : '¥') + Number(exp.amount).toFixed(2) + '」吗？',
    confirmOnly: true
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rooms/' + state.roomId + '/expenses/' + id, { method: 'DELETE', headers: getAuthHeaders() });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '服务器返回 ' + resp.status);
    }
    if (state.editingExpenseId === id) cancelEditExpense();
    await refresh();
    showToast('费用已删除', 'info');
  } catch (err) {
    promptInput({ title: '删除失败', icon: '❌', hint: err.message, confirmOnly: true });
  }
}

// ---------------- 费用预算管理 ----------------
function updateBudgetDisplay() {
  const r = state.room;
  const wrap = $('#budgetProgressWrap');
  const btnSet = $('#btnSetBudget');
  const btnClear = $('#btnClearBudget');
  if (!r.budget) {
    if (wrap) wrap.style.display = 'none';
    if (btnClear) btnClear.style.display = 'none';
    if (btnSet) btnSet.textContent = '设定';
    return;
  }
  if (btnClear) btnClear.style.display = '';
  if (btnSet) btnSet.textContent = '更新';
  if (wrap) wrap.style.display = '';
  const MOP_RATE = 0.9;
  const expenses = r.expenses || [];
  let totalCNY = 0;
  expenses.forEach(e => {
    totalCNY += e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
  });
  const budgetCNY = r.budgetCurrency === 'MOP' ? r.budget * MOP_RATE : r.budget;
  const pct = Math.min(100, (totalCNY / budgetCNY * 100));
  const overBudget = totalCNY > budgetCNY;
  const fill = $('#budgetProgressFill');
  if (fill) {
    fill.style.width = pct.toFixed(1) + '%';
    fill.className = 'budget-progress-fill' + (overBudget ? ' over' : '');
  }
  const text = $('#budgetProgressText');
  if (text) {
    text.textContent = '已花 ¥' + totalCNY.toFixed(0) + ' / 预算 ¥' + budgetCNY.toFixed(0) + ' (' + pct.toFixed(0) + '%)' + (overBudget ? ' ⚠️ 超预算！' : ' 剩 ¥' + (budgetCNY - totalCNY).toFixed(0));
    text.className = 'budget-progress-text' + (overBudget ? ' over' : '');
  }
  $('#budgetInput').value = r.budget;
  $('#budgetCurrency').value = r.budgetCurrency || 'CNY';
}

async function setBudget() {
  const val = parseFloat($('#budgetInput').value);
  const cur = $('#budgetCurrency').value;
  if (!val || val < 0) { showToast('请输入有效预算金额', 'error'); return; }
  try {
    const resp = await fetch('/api/rooms/' + state.roomId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ budget: val, budgetCurrency: cur })
    });
    if (!resp.ok) throw new Error('更新失败');
    state.room = await resp.json();
    updateBudgetDisplay();
    showToast('预算已设定 ✅', 'success');
  } catch (e) { showToast('设定失败: ' + e.message, 'error'); }
}

async function clearBudget() {
  showInputModal({ title: '清除预算', icon: '🗑️', hint: '确定要清除旅行预算设置吗？', confirmOnly: true }, async (ok) => {
    if (!ok) return;
    try {
      const resp = await fetch('/api/rooms/' + state.roomId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ budget: null })
      });
      if (!resp.ok) throw new Error('更新失败');
      state.room = await resp.json();
      updateBudgetDisplay();
      showToast('预算已清除', 'info');
    } catch (e) { showToast('操作失败', 'error'); }
  });
}

// ---------------- 二维码分享 ----------------
async function showQRCode() {
  if (!state.roomId) return;
  const overlay = $('#qrOverlay');
  const box = $('#qrCodeBox');
  const linkInput = $('#qrLinkText');
  const url = location.origin + '/?room=' + state.roomId;

  // 清空旧二维码
  box.innerHTML = '<div style="color:#94a3b8;font-size:13px;">加载中…</div>';
  overlay.classList.remove('hidden');

  // 按需加载 qrcodejs
  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
    box.innerHTML = '';
    new QRCode(box, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) {
    box.innerHTML = '<div style="color:#94a3b8;font-size:13px;">二维码加载失败</div>';
  }

  linkInput.value = url;
}

function closeQRCode() {
  $('#qrOverlay').classList.add('hidden');
}

function copyRoomLink() {
  const input = $('#qrLinkText');
  input.select();
  try {
    document.execCommand('copy');
    const btn = $('#qrCopyBtn');
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    input.focus();
  }
}

// 复制结算清单到剪贴板（带降级方案）
function copySettlement() {
  const txt = state._settleText || '';
  if (!txt) { showToast('暂无结算数据', 'info'); return; }
  const done = () => showToast('结算清单已复制，去微信发吧 💬', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
  } else {
    fallbackCopy(txt, done);
  }
}
function fallbackCopy(txt, cb) {
  const ta = document.createElement('textarea');
  ta.value = txt;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); if (cb) cb(); } catch (e) {}
  document.body.removeChild(ta);
}

// ---------------- 同行人编辑 ----------------
function renderTravelerChecklist() {
  const box = $('#travelerCheckList');
  if (!box) return;
  const curPeople = new Set(state.room.people || []);
  // 收集所有已知用户：从已注册用户 + 房间已有同行人
  const known = [...new Set([...state._allUsers || [], ...(state.room.people || [])])];
  box.innerHTML = known.map(u =>
    '<label class="traveler-check-item">' +
      '<input type="checkbox" value="' + u + '" ' + (curPeople.has(u) ? 'checked' : '') + ' />' +
      '<span>' + u + '</span>' +
      '<button class="traveler-remove-btn" onclick="removeTravelerItem(\'' + u + '\')" title="从列表中移除">×</button>' +
    '</label>'
  ).join('');
}

function addNewTraveler() {
  const input = $('#newTravelerName');
  const name = (input.value || '').trim();
  if (!name) return;
  if (name === '匿名') { input.value = ''; return; }
  // 避免重复
  if (!state._allUsers) state._allUsers = [];
  if (state._allUsers.includes(name)) { input.value = ''; return; }
  state._allUsers.push(name);
  // 自动勾选
  if (!state.room.people.includes(name)) state.room.people.push(name);
  input.value = '';
  renderTravelerChecklist();
  // 输入框回车也触发
  input.focus();
}

function removeTravelerItem(name) {
  if (!state._allUsers) return;
  state._allUsers = state._allUsers.filter(u => u !== name);
  state.room.people = (state.room.people || []).filter(p => p !== name);
  renderTravelerChecklist();
}

async function showTravelerEditor() {
  if (state.userRole !== 'admin') {
    promptInput({ title: '权限不足', icon: '🔒', hint: '只有管理员可以编辑同行人。', confirmOnly: true });
    return;
  }
  // 获取所有注册用户
  try {
    const resp = await fetch('/api/admin/users', { headers: getAuthHeaders() });
    const data = await resp.json();
    state._allUsers = (data.users || []).map(u => u.name);
  } catch (e) {
    state._allUsers = [...(state.room.people || [])];
  }

  renderTravelerChecklist();
  $('#newTravelerName').value = '';

  const overlay = $('#travelerOverlay');
  overlay.classList.remove('hidden');
  // ESC 关闭
  const onEsc = (ev) => { if (ev.key === 'Escape') { closeTravelerEditor(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  // 点击遮罩关闭
  overlay.onclick = (ev) => { if (ev.target === overlay) closeTravelerEditor(); };
  // 聚焦输入框
  setTimeout(() => $('#newTravelerName').focus(), 100);
}

function closeTravelerEditor() {
  $('#travelerOverlay').classList.add('hidden');
}

async function saveTravelers() {
  const checks = document.querySelectorAll('#travelerCheckList input:checked');
  const travelers = Array.from(checks).map(c => c.value);
  if (travelers.length === 0) {
    promptInput({ title: '提示', icon: '⚠️', hint: '至少选择一位同行人。', confirmOnly: true });
    return;
  }

  const btn = $('#btnSaveTravelers');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

  try {
    const resp = await fetch('/api/rooms/' + state.roomId + '/travelers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ travelers })
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.error || '保存失败');
    }
    const data = await resp.json();
    state.room.people = travelers;
    // 同步服务端已重算过的费用分摊（被移除的同行人已从各费用 splitAmong 剔除）
    if (data.expenses) state.room.expenses = data.expenses;
    closeTravelerEditor();
    updateRoomInfo();
    // 刷新费用表单人员选项
    refreshExpenseFormOptions();
    // 整体重渲染：让费用卡片 / 预算按人汇总立即反映分摊变化
    render();
    // 反馈：若改名 / 移除同行人影响了既有费用分摊 / 付款人，给个轻提示
    const renameKeys = Object.keys(data.renames || {});
    if ((data.renamed || 0) > 0) {
      const detail = renameKeys.map(k => '「' + k + '」→「' + data.renames[k] + '」').join('、');
      promptInput({
        title: '已同步改名到账单',
        icon: '🔄',
        hint: '已将 ' + data.renamed + ' 处账单的付款人 / 分摊人跟随同行人改名：' + detail + '。',
        confirmOnly: true
      });
    } else if (data.reconciledExpenses > 0 || (data.reconciledPayers || 0) > 0) {
      const names = (data.removed || []).join('、');
      const parts = [];
      if (data.reconciledExpenses > 0) parts.push('从 ' + data.reconciledExpenses + ' 笔费用的分摊名单中移除：' + names);
      if ((data.reconciledPayers || 0) > 0) parts.push('清除了 ' + data.reconciledPayers + ' 笔费用的付款人（' + names + ' 已退出行程）');
      promptInput({
        title: '已同步分摊与付款人',
        icon: '🔄',
        hint: parts.join('；') + '。',
        confirmOnly: true
      });
    }
  } catch (err) {
    promptInput({ title: '保存失败', icon: '❌', hint: err.message, confirmOnly: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 保存'; }
  }
}

// ---------------- 通用输入模态框（替代 prompt，移动端不被拦截） ----------------
function showInputModal(opts, onConfirm) {
  const { title, icon, hint, placeholder, placeholder2, value, value2, confirmOnly, twoFields } = opts;
  const overlay = $('#inputModal');
  const input = $('#inputModalField');
  const input2 = $('#inputModalField2');
  const err = $('#inputModalError');
  const confirmBtn = $('#inputModalConfirm');
  const cancelBtn = $('#inputModalCancel');
  const titleEl = $('#inputModalTitle');
  const iconEl = $('#inputModalIcon');
  const hintEl = $('#inputModalHint');

  titleEl.textContent = title || '输入';
  iconEl.textContent = icon || '📝';
  hintEl.textContent = hint || '';

  if (confirmOnly) {
    input.style.display = 'none';
    input2.style.display = 'none';
    confirmBtn.textContent = '确定';
    cancelBtn.textContent = '取消';
  } else if (twoFields) {
    input.style.display = '';
    input2.style.display = '';
    confirmBtn.textContent = '确认';
    cancelBtn.textContent = '取消';
    input.placeholder = placeholder || '房间号';
    input2.placeholder = placeholder2 || '房间名称';
    input.value = value || '';
    input2.value = value2 || '';
    input.type = 'text';
    input2.type = 'text';
  } else {
    input.style.display = '';
    input2.style.display = 'none';
    confirmBtn.textContent = '确认';
    cancelBtn.textContent = '取消';
    input.placeholder = placeholder || '';
    input.value = value || '';
    input.type = opts.isPassword ? 'password' : 'text';
  }
  err.classList.add('hidden');
  overlay.classList.remove('hidden');
  if (!confirmOnly) (twoFields ? input : input).focus();

  let resolved = false;

  function cleanup() {
    confirmBtn.removeEventListener('click', doConfirm);
    cancelBtn.removeEventListener('click', doCancel);
    input.removeEventListener('keydown', onKey);
    input2.removeEventListener('keydown', onKey);
  }

  function doCancel() {
    if (resolved) return; resolved = true;
    overlay.classList.add('hidden');
    cleanup();
  }

  function doConfirm() {
    if (resolved) return;
    if (confirmOnly) {
      resolved = true;
      overlay.classList.add('hidden');
      cleanup();
      onConfirm(true);
      return;
    }
    const v = input.value.trim();
    if (!v) {
      err.textContent = '请输入内容';
      err.classList.remove('hidden');
      input.focus();
      return;
    }
    if (twoFields) {
      const v2 = input2.value.trim();
      if (!v2) {
        err.textContent = '请填写房间名称';
        err.classList.remove('hidden');
        input2.focus();
        return;
      }
      resolved = true;
      overlay.classList.add('hidden');
      cleanup();
      onConfirm(v, v2);
      return;
    }
    resolved = true;
    overlay.classList.add('hidden');
    cleanup();
    onConfirm(v);
  }

  function onKey(e) {
    if (e.key === 'Enter') doConfirm();
    if (e.key === 'Escape') doCancel();
  }

  confirmBtn.addEventListener('click', doConfirm);
  cancelBtn.addEventListener('click', doCancel);
  input.addEventListener('keydown', onKey);
  input2.addEventListener('keydown', onKey);
}
async function createRoomById(id, name) {
  const r = await fetch('/api/rooms', {
    method: 'POST',     headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id, name: name || '我的旅行', seed: id === '2026' })
  }).then(res => {
    if (!res.ok) return res.json().then(d => { throw new Error(d.error || '创建失败'); });
    return res.json();
  });
  return r;
}

// Promise 封装的输入模态框（用于需要 await 的场景）
function promptInput(opts) {
  return new Promise(resolve => {
    showInputModal(opts, resolve);
  });
}

// 旧房间号重定向映射
const ROOM_REDIRECTS = { 'macau-2026': '2026', '123456': '1234' };

async function ensureRoom() {
  let id = location.hash.slice(1);
  // 支持 ?room=xxxx 形式分享链接（部分聊天软件会截断 # 锚点）
  if (!id) {
    const qp = new URLSearchParams(location.search);
    id = qp.get('room') || '';
  }
  // 旧房间号自动跳转
  if (ROOM_REDIRECTS[id]) { location.hash = ROOM_REDIRECTS[id]; id = ROOM_REDIRECTS[id]; }
  if (!id) { id = '2026'; location.hash = id; }
  state.roomId = id;
  // 同步 hash，保证后续 hashchange 行为一致
  if (!location.hash.slice(1)) history.replaceState(null, '', '#' + id);
  let r = await fetch('/api/rooms/' + id).then(res => res.ok ? res.json() : null);

  if (!r) {
    // 房间不存在
    if (state.userRole === 'admin') {
      // 管理员：询问是否创建
      const name = await promptInput({
        title: '房间「' + id + '」不存在',
        icon: '🆕',
        hint: '输入房间名称即可创建\n按 Esc 或点取消返回默认房间',
        placeholder: '我的旅行'
      });
      if (name) {
        try {
          r = await createRoomById(id.toLowerCase(), name);
        } catch (err) {
          promptInput({ title: '创建失败', icon: '❌', hint: err.message, confirmOnly: true });
        }
      }
      if (!r) {
        location.hash = '2026';
        await ensureRoom();
        return;
      }
    } else {
      // 非管理员：提示联系管理员
      promptInput({
        title: '房间不存在',
        icon: '❌',
        hint: '房间「' + id + '」不存在。\n\n请联系管理员创建房间，或让管理员分享正确链接。\n即将跳转到默认房间 2026。',
        confirmOnly: true
      });
      location.hash = '2026';
      await ensureRoom();
      return;
    }
  }

  state.room = r;
  _cachedSplitPeople = '';  // 切换房间时重置分摊缓存
  updateRoomInfo();
  render();

  // 初始化费用表单
  initExpenseForm();
  // 游客模式隐藏费用表单
  const expFormWrap = $('#expenseFormWrap');
  if (expFormWrap) expFormWrap.style.display = state.isViewOnly ? 'none' : '';

  // 管理员登录后拉取房间总数
  if (state.userRole === 'admin') fetchRoomCount();

  // 新用户（无昵称）→ 显示欢迎弹窗（仅首次，避免每次刷新都弹）
  if (!getNickname() && !state.isLoggedIn && !localStorage.getItem('travel_welcome_seen')) {
    localStorage.setItem('travel_welcome_seen', '1');
    showWelcome();
  }

  // 仅查看模式 → 隐藏添加表单、显示提示条
  if (state.isViewOnly) {
    const formWrap = document.querySelector('.add-form-wrap');
    if (formWrap) formWrap.style.display = 'none';
    const banner = $('#viewOnlyBanner');
    if (banner) banner.classList.remove('hidden');
  } else {
    const banner2 = $('#viewOnlyBanner');
    if (banner2) banner2.classList.add('hidden');
  }
}

async function createRoom() {
  if (state.userRole !== 'admin') {
    showInputModal({ title: '权限不足', icon: '🔒', hint: '只有管理员可以创建房间。\n请先登录管理员账号。', confirmOnly: true }, () => {});
    return;
  }
  showInputModal({
    title: '创建新房间',
    icon: '🏠',
    hint: '请输入房间号和房间名称',
    placeholder: '房间号（4位数字）',
    placeholder2: '房间名称',
    twoFields: true
  }, async (roomId, roomName) => {
    if (!/^\d{4}$/.test(roomId)) {
      promptInput({ title: '格式错误', icon: '⚠️', hint: '房间号必须是 4 位数字（如 1234、2026）。', confirmOnly: true });
      return;
    }
    try {
      await createRoomById(roomId, roomName || '我的旅行');
      location.hash = roomId;
      state.roomId = roomId;
      await ensureRoom();
      // 创建后自动弹出同行人选择
      setTimeout(() => showTravelerEditor(), 500);
    } catch (err) {
      promptInput({ title: '创建失败', icon: '❌', hint: err.message, confirmOnly: true });
    }
  });
}

async function fetchRoomCount() {
  try {
    const resp = await fetch('/api/rooms');
    const data = await resp.json();
    const el = $('#roomCountBadge');
    if (el) {
      el.textContent = '🏠 ' + data.total + ' 个房间';
      el.title = data.rooms.map(r => r.id + '「' + r.name + '」' + r.itemCount + '条').join('\n');
    }
  } catch (e) { /* ignore */ }
}

function joinRoom() {
  showInputModal({
    title: '加入房间',
    icon: '🚪',
    hint: '输入管理员分享给你的4位房间号',
    placeholder: '如 1234'
  }, async (rid) => {
    rid = rid.trim();
    // 旧房间号自动跳转
    if (ROOM_REDIRECTS[rid]) rid = ROOM_REDIRECTS[rid];
    // 先查房间是否存在
    try {
      const check = await fetch('/api/rooms/' + rid);
      if (!check.ok) {
        // 管理员：询问是否直接创建
        if (state.userRole === 'admin') {
          showInputModal({
            title: '房间不存在',
            icon: '🏠',
            hint: '房间「' + rid + '」不存在。\n\n是否立即创建？',
            confirmOnly: true
          }, async (confirmed) => {
            if (!confirmed) return;
            showInputModal({
              title: '创建房间「' + rid + '」',
              icon: '🏠',
              hint: '请输入房间名称',
              placeholder: '深圳、珠海、澳门5日游'
            }, async (name) => {
              try {
                await createRoomById(rid, name);
                location.hash = rid;
                await ensureRoom();
              } catch (err) {
                promptInput({ title: '创建失败', icon: '❌', hint: err.message, confirmOnly: true });
              }
            });
          });
        } else {
          showInputModal({
            title: '房间不存在',
            icon: '❌',
            hint: '房间「' + rid + '」不存在。\n\n请联系管理员创建房间。',
            confirmOnly: true
          }, () => {});
        }
        return;
      }
      location.hash = rid;
      await ensureRoom();
    } catch (e) {
      showInputModal({
        title: '网络错误',
        icon: '🔌',
        hint: '无法验证房间是否存在。\n请检查网络后重试。',
        confirmOnly: true
      }, () => {});
    }
  });
}

function copyShare() {
  const url = location.origin + '/?room=' + state.roomId;
  navigator.clipboard?.writeText(url).then(
    () => promptInput({ title: '已复制', icon: '📋', hint: '邀请链接已复制到剪贴板\n\n' + url, confirmOnly: true }),
    async () => {
      const u = await promptInput({ title: '复制失败', icon: '❌', hint: '请手动复制以下链接', value: url });
    }
  );
}

async function refresh() {
  const sync = $('#riSync');
  if (sync) { sync.textContent = '🔄 同步中…'; sync.classList.add('syncing'); }
  try {
    state.room = await fetch('/api/rooms/' + state.roomId).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    state.navOptimized = null;
    state.lastSync = Date.now();
    state.consecutiveFails = 0;
    if (sync) { sync.textContent = '🔄 刚刚同步'; sync.classList.remove('syncing'); }
    updateNetStatus();
    render();
  } catch (e) {
    state.consecutiveFails++;
    if (sync) { sync.textContent = '⚠️ 同步失败'; sync.classList.remove('syncing'); }
    updateNetStatus();
    render();
  }
}

// ---------------- 网络状态条 ----------------
function updateNetStatus() {
  const bar = $('#netStatusBar');
  if (!bar) return;
  if (state.consecutiveFails >= 2) {
    bar.classList.remove('hidden');
    const timeEl = bar.querySelector('.net-status-time');
    if (timeEl && state.lastSync) {
      const secs = Math.floor((Date.now() - state.lastSync) / 1000);
      timeEl.textContent = '最后同步: ' + (secs < 60 ? secs + '秒前' : Math.floor(secs/60) + '分钟前');
    }
  } else if (state.consecutiveFails === 0) {
    bar.classList.add('hidden');
  }
}

// ---------------- 行程条目 ----------------
async function addItem(e) {
  e.preventDefault();

  // 游客（未登录）→ 提示登录
  if (!state.isLoggedIn) {
    const ok = await promptInput({
      title: '需要登录',
      icon: '🔒',
      hint: '你当前是游客身份，无法添加行程。\n\n请先登录账号参与协作。',
      confirmOnly: true
    });
    if (ok) showLogin();
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
  const f = e.target;
  // 获取选中的类型 radio
  const typeRadio = f.querySelector('input[name="type"]:checked');
  const selType = typeRadio ? typeRadio.value : '景点';

  const item = {
    date: f.date.value,
    time: f.time.value || '',
    place: f.place.value.trim(),
    lat: parseFloat(f.lat.value) || null,
    lng: parseFloat(f.lng.value) || null,
    type: selType,
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
      const ok = await promptInput({
        title: '时间冲突提醒',
        icon: '⚠️',
        hint: item.date + ' ' + item.time + ' 已有：\n' + names + '\n\n是否仍要添加？',
        confirmOnly: true
      });
      if (!ok) return;
      if (btn) { btn.disabled = true; btn.textContent = '添加中…'; }
    }
  }

  // ==== 自动地理编码（经纬度字段已隐藏，每次都自动查）====
  if (item.place) {
    // 1. 先查本地 POI
    const localPOI = POIS.find(p => p.name === item.place);
    if (localPOI) {
      item.lat = localPOI.lat;
      item.lng = localPOI.lng;
    } else {
      // 2. 本地没找到 → 在线查
      if (btn) btn.textContent = '正在定位…';
      try {
        const geoResults = await geocodeNominatim(item.place);
        if (geoResults.length > 0) {
          item.lat = geoResults[0].lat;
          item.lng = geoResults[0].lng;
        }
      } catch (e) { /* 在线查不到就算了 */ }
    }

    // 3. 智能类型检测：如果当前选的是"其他"或没匹配到 POI 类型，根据名称推测
    if (selType === '其他' || selType === '景点') {
      const guessed = guessType(item.place);
      if (guessed && guessed !== '景点') {
        item.type = guessed;
        // 同步更新 radio
        const radio = document.querySelector('input[name="type"][value="' + guessed + '"]');
        if (radio) radio.checked = true;
      }
    }
  }

  try {
    // 编辑模式 vs 新增模式
    if (state.editingItemId) {
      const resp = await fetch('/api/rooms/' + state.roomId + '/items/' + state.editingItemId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
      });
      if (!resp.ok) throw new Error('服务器返回 ' + resp.status);
      cancelEdit();
      await refresh();
      showToast('行程已更新 ✅', 'success');
    } else {
      const resp = await fetch('/api/rooms/' + state.roomId + '/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item)
      });
      if (!resp.ok) throw new Error('服务器返回 ' + resp.status);
      f.reset();
      f.date.value = item.date; f.time.value = '10:00';
      // 重置备注折叠
      const noteInput = f.note;
      const noteToggle = document.querySelector('#noteField .note-toggle');
      if (noteInput.style.display !== 'none') {
        noteInput.style.display = 'none';
        noteInput.value = '';
        if (noteToggle) noteToggle.style.display = '';
      }
      // 类型重置为景点
      const defRadio = f.querySelector('input[name="type"][value="景点"]');
      if (defRadio) defRadio.checked = true;
      await refresh();
      showToast('行程已添加 ✅', 'success');
      // 坐标获取失败 → 提示用户导航路线将不显示此行程
      if (!item.lat || !item.lng) {
        promptInput({
          title: '坐标获取失败',
          icon: '⚠️',
          hint: '未能获取「' + item.place + '」的坐标。\n\n导航路线将无法计算此行程的距离。\n你可以稍后编辑此行程，在"地点"输入框选择匹配的地点来补充坐标。',
          confirmOnly: true
        });
      }
    }
  } catch (err) {
    promptInput({
      title: '操作失败',
      icon: '❌',
      hint: err.message || '网络异常，请稍后重试',
      confirmOnly: true
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = state.editingItemId ? '💾 保存修改' : '添加';
    }
  }
}

// ---------------- 编辑行程 ----------------
function toggleAddForm() {
  const w = document.getElementById('addFormWrap');
  if (w) w.classList.toggle('collapsed');
}

function toggleExpenseForm() {
  const w = document.getElementById('expenseFormWrap');
  if (w) w.classList.toggle('collapsed');
}

function editItem(id) {
  if (!state.isLoggedIn) {
    promptInput({ title: '权限不足', icon: '🔒', hint: '你当前是游客身份，无法编辑行程。\n请先登录账号后参与协作。', confirmOnly: true });
    return;
  }
  const item = state.room.items.find(i => i.id === id);
  if (!item) return;
  state.editingItemId = id;

  // 若表单默认收起，编辑时自动展开
  const wrap = document.getElementById('addFormWrap');
  if (wrap) wrap.classList.remove('collapsed');

  const f = $('#addForm');
  f.place.value = item.place;
  f.date.value = item.date;
  f.time.value = item.time || '10:00';
  f.lat.value = item.lat || '';
  f.lng.value = item.lng || '';
  if (item.note) {
    f.note.value = item.note;
    f.note.style.display = '';
    const noteToggle = $('#noteField').querySelector('.note-toggle');
    if (noteToggle) noteToggle.style.display = 'none';
  }
  // 选择类型
  const typeRadio = f.querySelector('input[name="type"][value="' + item.type + '"]');
  if (typeRadio) typeRadio.checked = true;
  f.creator.value = item.creator || getNickname();

  $('#btnSubmitItem').textContent = '💾 保存修改';
  $('#addFormTitle').classList.add('editing');
  $('#editCancelBtn').classList.remove('hidden');

  // 滚动到表单
  document.querySelector('.add-form-wrap').scrollIntoView({ behavior: 'smooth' });
  f.place.focus();
}

function cancelEdit() {
  state.editingItemId = null;
  const f = $('#addForm');
  f.reset();
  f.date.value = new Date().toISOString().slice(0, 10);
  f.time.value = '10:00';
  f.creator.value = getNickname();
  f.note.value = '';
  f.note.style.display = 'none';
  const noteToggle = $('#noteField').querySelector('.note-toggle');
  if (noteToggle) noteToggle.style.display = '';
  const defRadio = f.querySelector('input[name="type"][value="景点"]');
  if (defRadio) defRadio.checked = true;
  f.lat.value = '';
  f.lng.value = '';

  $('#btnSubmitItem').textContent = '＋ 添加行程';
  $('#addFormTitle').classList.remove('editing');
  $('#editCancelBtn').classList.add('hidden');
}

async function deleteItem(id) {
  if (!state.isLoggedIn) {
    promptInput({ title: '权限不足', icon: '🔒', hint: '你当前是游客身份，无法删除行程。\n请先登录账号后参与协作。', confirmOnly: true });
    return;
  }
  showInputModal({
    title: '删除确认',
    icon: '🗑️',
    hint: '确定删除该行程吗？\n此操作不可撤销。',
    confirmOnly: true
  }, async (confirmed) => {
    if (!confirmed) return;
    await fetch('/api/rooms/' + state.roomId + '/items/' + id, { method: 'DELETE' });
    await refresh();
    showToast('行程已删除', 'info');
  });
}

async function setStatus(id, status) {
  await fetch('/api/rooms/' + state.roomId + '/items/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
  });
  await refresh();
  const labels = { confirmed: '已确认 ✅', proposed: '待定', done: '已完成 🎉' };
  showToast(labels[status] || '状态已更新', 'success');
}

// 合并：把本条并入同日期另一条，本条从行程视图隐藏（审阅页保留「已合并」记录）
async function mergeItem(id) {
  const src = state.room.items.find(i => i.id === id);
  if (!src) return;
  const cands = state.room.items.filter(i =>
    i.id !== id && i.status !== 'dropped' && i.status !== 'merged' && i.date === src.date);
  if (!cands.length) {
    showInputModal({
      title: '合并确认',
      icon: '🔄',
      hint: '当天没有其他可合并的条目，是否直接删除本条？',
      confirmOnly: true
    }, async (ok) => {
      if (ok) {
        await fetch('/api/rooms/' + state.roomId + '/items/' + id, { method: 'DELETE' });
        await refresh();
      }
    });
    return;
  }
  // 显示卡片列表选择
  let cardHtml = '<div class="merge-cards">';
  cands.forEach((c, i) => {
    cardHtml += '<label class="merge-card' + (i === 0 ? ' selected' : '') + '" onclick="selectMergeCard(this)">' +
      '<input type="radio" name="mergeTarget" value="' + c.id + '"' + (i === 0 ? ' checked' : '') + ' />' +
      '<div class="merge-card-body">' +
        '<div class="merge-card-time">' + (c.time || '--:--') + '</div>' +
        '<div class="merge-card-place">' + c.place + '</div>' +
        '<div class="merge-card-meta">' + c.type + ' · ' + (c.creator || '匿名') + ' ' + statusPill(c.status) + '</div>' +
      '</div>' +
    '</label>';
  });
  cardHtml += '</div>';

  const mergeOverlay = $('#inputModal');
  const icon = $('#inputModalIcon');
  const title = $('#inputModalTitle');
  const hint = $('#inputModalHint');
  const field1 = $('#inputModalField');
  const field2 = $('#inputModalField2');
  const confirmBtn = $('#inputModalConfirm');
  const cancelBtn = $('#inputModalCancel');
  const errDiv = $('#inputModalError');

  const oldIcon = icon.textContent;
  const oldTitle = title.textContent;
  const oldHint = hint.innerHTML;
  const oldDisp1 = field1.style.display;
  const oldDisp2 = field2.style.display;

  icon.textContent = '🔄';
  title.textContent = '选择合并目标';
  hint.innerHTML = '把「<b>' + src.place + '</b>」合并到哪一条？' + cardHtml;
  field1.style.display = 'none';
  field2.style.display = 'none';
  errDiv.classList.add('hidden');
  confirmBtn.textContent = '确认合并';
  mergeOverlay.classList.remove('hidden');

  window._mergeResolver = async (targetId) => {
    if (!targetId) return;
    const resp = await fetch('/api/rooms/' + state.roomId + '/items/' + id + '/merge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId })
    });
    await resp.json();
    await refresh();
    showToast('行程已合并 ✅', 'success');
  };

  window._mergeCleanup = () => {
    icon.textContent = oldIcon;
    title.textContent = oldTitle;
    hint.innerHTML = oldHint;
    field1.style.display = oldDisp1;
    field2.style.display = oldDisp2;
    confirmBtn.textContent = '确认';
    mergeOverlay.classList.add('hidden');
    delete window._mergeResolver;
    delete window._mergeCleanup;
    delete window._mergeCancelSetup;
  };

  const doMerge = () => {
    const selected = document.querySelector('input[name="mergeTarget"]:checked');
    if (selected && window._mergeResolver) {
      window._mergeResolver(selected.value);
      window._mergeCleanup();
    }
  };
  const doCancel = () => {
    if (window._mergeCleanup) window._mergeCleanup();
  };

  // Replace input modal's confirm/cancel behavior
  window._mergeCancelSetup = { doMerge, doCancel };
  confirmBtn.onclick = doMerge;
  cancelBtn.onclick = doCancel;
}

function selectMergeCard(label) {
  const cards = label.parentElement.querySelectorAll('.merge-card');
  cards.forEach(c => c.classList.remove('selected'));
  label.classList.add('selected');
  label.querySelector('input[type="radio"]').checked = true;
}

// ---------------- 用户 GPS 定位 ----------------
function getMyLocation() {
  if (!navigator.geolocation) {
    promptInput({ title: '不支持定位', icon: '📍', hint: '你的浏览器不支持定位功能。', confirmOnly: true });
    return;
  }

  const btn = document.querySelector('.nav-actions button');
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在定位…'; }

  navigator.geolocation.getCurrentPosition(
    pos => {
      state.myLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        name: '📍 我的位置'
      };
      const badge = $('#myLocBadge');
      const text = $('#myLocText');
      text.textContent = state.myLocation.lat.toFixed(4) + ', ' + state.myLocation.lng.toFixed(4);
      badge.classList.remove('hidden');
      if (btn) { btn.disabled = false; btn.textContent = '📍 重新定位'; }
      renderNav(); // 刷新地图
    },
    err => {
      if (btn) { btn.disabled = false; btn.textContent = origText || '📍 获取我的位置'; }
      const msg = { 1: '定位被拒绝，请在浏览器设置中允许定位', 2: '定位超时，请检查 GPS 是否开启', 3: '定位超时' };
      promptInput({ title: '定位失败', icon: '📍', hint: msg[err.code] || err.message, confirmOnly: true });
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function clearMyLocation() {
  state.myLocation = null;
  $('#myLocBadge').classList.add('hidden');
  const btn = document.querySelector('.nav-actions button');
  if (btn) btn.textContent = '📍 获取我的位置';
  renderNav();
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

// ---------------- 导出 PDF ----------------
async function exportPDF() {
  if (!state.room || !state.room.items) {
    promptInput({ title: '无数据', icon: '⚠️', hint: '当前没有行程数据可导出', confirmOnly: true });
    return;
  }

  const btn = document.querySelector('.ri-export');
  if (btn) { btn.disabled = true; btn.textContent = '📄 加载中…'; }

  // 按需加载 PDF 组件
  try {
    await ensureExportLibs();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '📄 导出PDF'; }
    promptInput({ title: '加载失败', icon: '⚠️', hint: 'PDF 组件加载失败，请检查网络后重试', confirmOnly: true });
    return;
  }

  if (btn) { btn.textContent = '📄 生成中…'; }

  try {
    const r = state.room;
    const items = (r.items || []).filter(i => i.status === 'kept' || i.status === 'proposed');
    const days = [...new Set(items.map(i => i.date))].sort();
    const creators = [...new Set(items.map(i => i.creator || '匿名'))];
    const typeEmoji = { '景点': '🏛️', '餐饮': '🍜', '住宿': '🏨', '交通': '🚗', '其他': '📌' };

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageW = 210, pageH = 297;
    const cssW = 800;
    const pxToMm = pageW / cssW;  // CSS px → mm

    // 离屏渲染容器
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + cssW + 'px;background:#fff;';
    document.body.appendChild(container);

    const baseFont = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1e293b;';

    // 生成二维码 data URL（用于 PDF 封面）
    let qrDataUrl = '';
    if (typeof QRCode !== 'undefined') {
      const qrDiv = document.createElement('div');
      new QRCode(qrDiv, { text: location.origin + '/?room=' + state.roomId, width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M });
      const qrCanvas = qrDiv.querySelector('canvas') || qrDiv.querySelector('img');
      if (qrCanvas) {
        qrDataUrl = qrCanvas.tagName === 'CANVAS' ? qrCanvas.toDataURL('image/png') : qrCanvas.src;
      }
    }

    // ===== 封面页 =====
    let coverHtml = '<div style="padding:40px 50px;' + baseFont + 'background:#fff;">';
    coverHtml += '<div style="text-align:center;padding:30px 0 20px;border-bottom:3px solid #F7931E;margin-bottom:30px;">';
    coverHtml += '<div style="font-size:48px;margin-bottom:8px;">🌴</div>';
    coverHtml += '<h1 style="font-size:28px;color:#F7931E;margin:0 0 8px;">' + esc(r.name || '旅行攻略') + '</h1>';
    if (days.length) {
      coverHtml += '<p style="font-size:15px;color:#64748b;margin:0;">' + days[0] + ' ~ ' + days[days.length - 1] + ' · 共 ' + days.length + ' 天</p>';
    }
    coverHtml += '</div>';
    coverHtml += '<div style="display:flex;gap:20px;margin-bottom:30px;padding:16px 20px;background:#FFF7ED;border-radius:12px;">';
    coverHtml += '<div style="flex:1;text-align:center;"><div style="font-size:24px;font-weight:700;color:#F7931E;">' + items.length + '</div><div style="font-size:12px;color:#9A3412;">行程条数</div></div>';
    coverHtml += '<div style="flex:1;text-align:center;"><div style="font-size:24px;font-weight:700;color:#F7931E;">' + creators.length + '</div><div style="font-size:12px;color:#9A3412;">协作人数</div></div>';
    coverHtml += '<div style="flex:1;text-align:center;"><div style="font-size:24px;font-weight:700;color:#F7931E;">' + days.length + '</div><div style="font-size:12px;color:#9A3412;">行程天数</div></div>';
    coverHtml += '<div style="flex:1;text-align:center;"><div style="font-size:15px;font-weight:700;color:#F7931E;">#' + esc(state.roomId) + '</div><div style="font-size:12px;color:#9A3412;">房间号</div></div>';
    coverHtml += '</div>';
    coverHtml += '<div style="margin-bottom:25px;font-size:13px;color:#64748b;">👥 协作人员：' + creators.map(c => esc(c)).join(' · ') + '</div>';
    // 二维码
    if (qrDataUrl) {
      coverHtml += '<div style="text-align:center;margin:20px 0;">';
      coverHtml += '<img src="' + qrDataUrl + '" style="width:120px;height:120px;" />';
      coverHtml += '<p style="font-size:12px;color:#94a3b8;margin-top:6px;">📱 扫码加入在线协作</p>';
      coverHtml += '</div>';
    }
    coverHtml += '<div style="margin-top:30px;padding-top:16px;border-top:2px solid #E5E7EB;text-align:center;font-size:11px;color:#94a3b8;">';
    coverHtml += '<p>📱 在线协作：' + location.origin + '/?room=' + state.roomId + '</p>';
    coverHtml += '<p>生成时间：' + new Date().toLocaleString('zh-CN') + '</p>';
    coverHtml += '</div>';
    coverHtml += '</div>';

    container.innerHTML = coverHtml;
    let canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    let imgData = canvas.toDataURL('image/jpeg', 0.92);
    let imgH = canvas.height * pageW / canvas.width;

    if (imgH <= pageH) {
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);
    } else {
      let heightLeft = imgH, position = 0;
      pdf.addImage(imgData, 'JPEG', 0, position, pageW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = -(imgH - heightLeft);
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, position, pageW, imgH);
        heightLeft -= pageH;
      }
    }

    // ===== 每天单独一页 =====
    for (const day of days) {
      const list = items.filter(i => i.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));

      let dayHtml = '<div style="padding:30px 40px;' + baseFont + 'background:#fff;">';
      dayHtml += '<h2 style="font-size:20px;color:#fff;background:#F7931E;padding:10px 16px;border-radius:8px;margin:0 0 16px;">📅 ' + day + ' · ' + list.length + ' 个行程</h2>';

      dayHtml += '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
      dayHtml += '<thead><tr style="background:#FEF3C7;">';
      dayHtml += '<th style="padding:8px 10px;border:1px solid #FCD34D;text-align:left;width:70px;">时间</th>';
      dayHtml += '<th style="padding:8px 10px;border:1px solid #FCD34D;text-align:left;">地点</th>';
      dayHtml += '<th style="padding:8px 10px;border:1px solid #FCD34D;text-align:center;width:60px;">类型</th>';
      dayHtml += '<th style="padding:8px 10px;border:1px solid #FCD34D;text-align:left;">备注</th>';
      dayHtml += '<th style="padding:8px 10px;border:1px solid #FCD34D;text-align:center;width:70px;">添加人</th>';
      dayHtml += '</tr></thead><tbody>';

      list.forEach((it, idx) => {
        const bg = idx % 2 === 0 ? '#fff' : '#FFFBEB';
        dayHtml += '<tr style="background:' + bg + ';">';
        dayHtml += '<td style="padding:8px 10px;border:1px solid #E5E7EB;font-weight:600;">' + (it.time || '--:--') + '</td>';
        // 地点列 — 有坐标的带蓝色链接样式 + 🧭 图标
        if (it.lat && it.lng) {
          dayHtml += '<td id="place-' + idx + '" style="padding:8px 10px;border:1px solid #E5E7EB;font-weight:600;">';
          dayHtml += '<span style="color:#2563EB;text-decoration:underline;">' + esc(it.place) + '</span>';
          dayHtml += ' <span style="color:#2563EB;font-size:11px;">🧭导航</span>';
          dayHtml += '</td>';
        } else {
          dayHtml += '<td style="padding:8px 10px;border:1px solid #E5E7EB;font-weight:600;color:#94a3b8;">' + esc(it.place) + ' <span style="font-size:11px;">⚠️无坐标</span></td>';
        }
        dayHtml += '<td style="padding:8px 10px;border:1px solid #E5E7EB;text-align:center;">' + (typeEmoji[it.type] || '📌') + ' ' + esc(it.type || '其他') + '</td>';
        dayHtml += '<td style="padding:8px 10px;border:1px solid #E5E7EB;color:#64748b;">' + (it.note ? esc(it.note).replace(/\n/g, '<br>') : '—') + '</td>';
        dayHtml += '<td style="padding:8px 10px;border:1px solid #E5E7EB;text-align:center;color:#64748b;">' + esc(it.creator || '匿名') + '</td>';
        dayHtml += '</tr>';
      });

      dayHtml += '</tbody></table>';

      // 当天路线概要
      const geoItems = list.filter(i => i.lat && i.lng);
      if (geoItems.length > 1) {
        let totalKm = 0, totalMin = 0;
        for (let i = 1; i < geoItems.length; i++) {
          const d = haversine(geoItems[i - 1], geoItems[i]);
          totalKm += d;
          totalMin += segTime(d);
        }
        dayHtml += '<p style="font-size:12px;color:#94a3b8;margin:10px 0 0;padding-left:4px;">🚗 路线总距约 ' + totalKm.toFixed(1) + ' km · 预计移动约 ' + Math.round(totalMin) + ' 分钟</p>';
      }

      // 导航链接区 — 作为 HTML 渲染到 canvas 里（中文不乱码）
      const navItems = list.filter(i => i.lat && i.lng);
      if (navItems.length > 0) {
        dayHtml += '<div style="margin-top:16px;padding:14px 16px;background:#EFF6FF;border-radius:10px;">';
        dayHtml += '<div style="font-size:13px;font-weight:700;color:#1E40AF;margin-bottom:10px;">🧭 导航链接（点击可打开高德地图）</div>';
        navItems.forEach((it, idx) => {
          dayHtml += '<div class="navlink-row" style="padding:6px 10px;margin-bottom:4px;background:#fff;border-radius:6px;font-size:13px;">';
          dayHtml += '<span style="color:#64748b;">' + (it.time || '--:--') + '</span> ';
          dayHtml += '<span style="color:#2563EB;text-decoration:underline;font-weight:600;">' + esc(it.place) + '</span>';
          dayHtml += ' <span style="color:#94a3b8;font-size:11px;">→ 点击导航</span>';
          dayHtml += '</div>';
        });
        dayHtml += '</div>';
      }

      dayHtml += '</div>';

      container.innerHTML = dayHtml;

      canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      imgData = canvas.toDataURL('image/jpeg', 0.92);
      imgH = canvas.height * pageW / canvas.width;
      const dayPage = pdf.internal.pages.length + 1; // 当前日期的起始页码

      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);

      // 如果图片超过一页，分页切片
      if (imgH > pageH) {
        let heightLeft = imgH - pageH;
        let position = -pageH;
        while (heightLeft > 0) {
          pdf.addPage();
          pdf.addImage(imgData, 'JPEG', 0, position, pageW, imgH);
          heightLeft -= pageH;
          position -= pageH;
        }
      }

      // 用 getBoundingClientRect 精确计算可点击链接坐标
      if (navItems.length > 0) {
        const containerRect = container.getBoundingClientRect();
        const linkEls = container.querySelectorAll('.navlink-row');
        linkEls.forEach((el, idx) => {
          try {
            const rect = el.getBoundingClientRect();
            const cssY = rect.top - containerRect.top;
            const cssH = rect.height;
            const yMm = cssY * pxToMm;
            const hMm = Math.max(cssH * pxToMm, 3);
            const imgEnd = yMm + hMm;
            if (imgEnd <= 0) return; // 在图片区域之前（不可能）

            const url = amapNav(navItems[idx].lat, navItems[idx].lng, navItems[idx].place);
            // 遍历该链接可能跨越的所有页面
            for (let cur = yMm; cur < imgEnd; cur += pageH) {
              const pageIdx = Math.floor(cur / pageH);
              const pdfPage = dayPage + pageIdx;
              const pdfY = cur - pageIdx * pageH;
              const pdfH = Math.min(pageH - pdfY, imgEnd - cur);
              if (pdfPage >= dayPage && pdfPage <= pdf.internal.pages.length) {
                pdf.setPage(pdfPage);
                pdf.link(0, pdfY, pageW, pdfH, { url: url });
              }
            }
          } catch (e) { /* 单个链接失败不影响整体 */ }
        });
      }
    }

    // ===== 费用汇总页 =====
    const allExpenses = (r.expenses || []).slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '').localeCompare(b.time || '');
    });
    if (allExpenses.length > 0) {
      const MOP_RATE = 0.9;
      const expPeople = [...new Set(allExpenses.map(e => e.payer || '未知'))];
      const totalsByCur = {};
      allExpenses.forEach(e => {
        const cur = e.currency || 'CNY';
        if (!totalsByCur[cur]) totalsByCur[cur] = 0;
        totalsByCur[cur] += Number(e.amount || 0);
      });
      const totalCNY = Object.entries(totalsByCur).reduce((s, [cur, val]) => s + (cur === 'MOP' ? val * MOP_RATE : val), 0);

      // 付款人统计
      const expPayerStats = {};
      allExpenses.forEach(e => {
        const p = e.payer || '未知';
        const amtCNY = e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
        if (!expPayerStats[p]) expPayerStats[p] = { paid: 0, count: 0 };
        expPayerStats[p].paid += amtCNY;
        expPayerStats[p].count++;
      });

      // 分摊净值
      const expBalances = {};
      expPeople.forEach(p => expBalances[p] = 0);
      allExpenses.forEach(e => {
        const amtCNY = e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
        const split = (e.splitAmong && e.splitAmong.length > 0) ? e.splitAmong : expPeople;
        const share = amtCNY / split.length;
        expBalances[e.payer] = (expBalances[e.payer] || 0) + amtCNY;
        split.forEach(p => { expBalances[p] = (expBalances[p] || 0) - share; });
      });

      const totalStr = Object.entries(totalsByCur).map(([cur, val]) => cur === 'MOP' ? 'MOP$' + val.toFixed(2) : '\u00A5' + val.toFixed(2)).join(' + ');

      let expHtml = '<div style="padding:40px 50px;' + baseFont + 'background:#fff;">';
      expHtml += '<div style="text-align:center;background:linear-gradient(135deg,#F7931E,#F97316);color:#fff;border-radius:12px;padding:24px;margin-bottom:24px;">';
      expHtml += '<div style="font-size:36px;font-weight:800;">' + esc(totalStr) + '</div>';
      expHtml += '<div style="font-size:14px;opacity:.9;margin-top:4px;">总费用 \u00B7 ' + allExpenses.length + ' 笔 \u00B7 ' + expPeople.length + ' 人参与 \u00B7 折合 \u00A5' + totalCNY.toFixed(2) + '</div>';
      expHtml += '</div>';

      // 付款明细表
      expHtml += '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">';
      expHtml += '<thead><tr style="background:#FEF3C7;"><th style="padding:8px 10px;border:1px solid #FCD34D;text-align:left;">付款人</th><th style="padding:8px 10px;border:1px solid #FCD34D;text-align:right;">已付(折CNY)</th><th style="padding:8px 10px;border:1px solid #FCD34D;text-align:right;">笔数</th><th style="padding:8px 10px;border:1px solid #FCD34D;text-align:right;">净值</th></tr></thead><tbody>';
      Object.entries(expPayerStats).sort((a, b) => b[1].paid - a[1].paid).forEach(([name, st]) => {
        const bal = expBalances[name] || 0;
        const balColor = bal > 0.01 ? '#16A34A' : bal < -0.01 ? '#DC2626' : '#94a3b8';
        const balStr = (bal > 0 ? '+' : '') + '\u00A5' + bal.toFixed(2);
        expHtml += '<tr><td style="padding:8px 10px;border:1px solid #E5E7EB;font-weight:600;">' + esc(name) + '</td><td style="padding:8px 10px;border:1px solid #E5E7EB;text-align:right;">\u00A5' + st.paid.toFixed(2) + '</td><td style="padding:8px 10px;border:1px solid #E5E7EB;text-align:right;">' + st.count + '</td><td style="padding:8px 10px;border:1px solid #E5E7EB;text-align:right;color:' + balColor + ';font-weight:600;">' + balStr + '</td></tr>';
      });
      expHtml += '</tbody></table>';

      // 结算建议
      const expDebts = Object.entries(expBalances).map(([name, diff]) => ({ name, diff })).filter(d => Math.abs(d.diff) > 0.01);
      const expCreditors = expDebts.filter(d => d.diff > 0).sort((a, b) => b.diff - a.diff);
      const expDebtors = expDebts.filter(d => d.diff < 0).sort((a, b) => a.diff - b.diff);
      if (expCreditors.length > 0 && expDebtors.length > 0) {
        expHtml += '<div style="background:#F0FDF4;border-radius:10px;padding:14px 16px;">';
        expHtml += '<div style="font-size:14px;font-weight:700;color:#16A34A;margin-bottom:10px;">\u{1F504} 结算建议</div>';
        let ci = 0, di = 0;
        let c = expCreditors[ci], d = expDebtors[di];
        while (ci < expCreditors.length && di < expDebtors.length) {
          const amt = Math.min(c.diff, -d.diff);
          expHtml += '<div style="padding:6px 0;font-size:13px;border-bottom:1px solid #DCFCE7;">';
          expHtml += '<span style="color:#DC2626;font-weight:600;">' + esc(d.name) + '</span> \u2192 <span style="color:#16A34A;font-weight:600;">' + esc(c.name) + '</span>';
          expHtml += ' <span style="float:right;font-weight:700;">\u00A5' + amt.toFixed(2) + '</span></div>';
          c.diff -= amt; d.diff += amt;
          if (c.diff < 0.01) { ci++; if (ci < expCreditors.length) c = expCreditors[ci]; }
          if (d.diff > -0.01) { di++; if (di < expDebtors.length) d = expDebtors[di]; }
        }
        expHtml += '</div>';
      }

      // 按天费用明细
      const expDays = [...new Set(allExpenses.map(e => e.date))].sort();
      const catEmoji = { '\u9910\u996E': '\u{1F35C}', '\u4EA4\u901A': '\u{1F697}', '\u95E8\u7968': '\u{1F3AB}', '\u4F4F\u5BBF': '\u{1F3E8}', '\u8D2D\u7269': '\u{1F6CD}\uFE0F', '\u5176\u4ED6': '\u{1F4A1}' };
      expDays.forEach(day => {
        const dayList = allExpenses.filter(e => e.date === day);
        const dayTotal = dayList.reduce((s, e) => s + (e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount)), 0);
        expHtml += '<div style="margin-top:16px;padding:10px 14px;background:#FFF7ED;border-radius:8px;">';
        expHtml += '<div style="font-size:14px;font-weight:700;color:#9A3412;margin-bottom:6px;">\u{1F4C5} ' + day + ' \u00B7 \u00A5' + dayTotal.toFixed(2) + '</div>';
        dayList.forEach(e => {
          const icon = catEmoji[e.category] || '\u{1F4A1}';
          const linked = e.linkedItemId ? (items.find(i => i.id === e.linkedItemId) || {}).place : '';
          expHtml += '<div style="padding:4px 0;font-size:12px;color:#475569;border-bottom:1px solid #FEF3C7;">';
          expHtml += icon + ' ' + esc(e.description || e.category);
          if (linked) expHtml += ' <span style="color:#2563EB;">\u{1F517}' + esc(linked) + '</span>';
          expHtml += ' <span style="float:right;font-weight:600;">' + (e.currency === 'MOP' ? 'MOP$' : '\u00A5') + Number(e.amount).toFixed(2) + '</span>';
          expHtml += ' <span style="color:#94a3b8;font-size:11px;">(' + esc(e.payer || '未知') + ')</span>';
          expHtml += '</div>';
        });
        expHtml += '</div>';
      });

      expHtml += '</div>';

      container.innerHTML = expHtml;
      canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      imgData = canvas.toDataURL('image/jpeg', 0.92);
      imgH = canvas.height * pageW / canvas.width;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, 0, pageW, imgH);
    }

    document.body.removeChild(container);

    const fname = (r.name || '旅行攻略') + '_' + (days[0] || '') + '.pdf';
    pdf.save(fname);

  } catch (err) {
    promptInput({ title: '导出失败', icon: '❌', hint: err.message || '生成 PDF 时出错', confirmOnly: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 导出PDF'; }
  }
}

// HTML 转义（PDF 用）
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------- 渲染 ----------------
function switchTab(tab) {
  state.activeTab = tab;
  state.navOptimized = null;
  $$('.tab').forEach(t => t.classList[t.dataset.tab === tab ? 'add' : 'remove']('active'));
  $$('.panel').forEach(p => p.classList[p.id === tab ? 'add' : 'remove']('active'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

// 防御性归一：显示前把账单里的付款人 / 分摊人按出行人标准写法对齐（大小写 / 空格无关）。
// 出行人是唯一权威，账单不得出现与出行人"仅大小写不同"的写法（如出行人是 jack，账单里就不该显示 JACK）。
// 注意：仅修正展示用数据，不改写服务端；服务端在出行人变更 / 启动时也会做同样归一。
function normalizeExpenseNames() {
  const people = state.room && state.room.people;
  if (!people || !people.length || !state.room.expenses) return;
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const canon = {};
  people.forEach(p => { if (!canon[norm(p)]) canon[norm(p)] = p; });
  state.room.expenses.forEach(e => {
    if (e.payer && canon[norm(e.payer)]) e.payer = canon[norm(e.payer)];
    if (Array.isArray(e.splitAmong)) {
      e.splitAmong = e.splitAmong.map(p => canon[norm(p)] || p);
    }
  });
}

function render() {
  if (!state.room) return;

  // 出行人改名后，账单展示立即跟随（大小写对齐），无需重新记账
  normalizeExpenseNames();

  // 保存自定义分摊状态（防止 render 过程中的 DOM 重建丢失数据）
  const savedSplitMode = state.splitMode;
  const savedSplitManual = state.splitCustomManual;
  const savedSplitValues = { ...state.splitCustomValues };

  updateRoomInfo();
  if (state.activeTab === 'overview') renderOverview();
  renderPlan();
  refreshExpenseFormOptions();
  if (state.activeTab === 'nav') renderNav();
  if (state.activeTab === 'expense') renderExpense();
  if (state.activeTab === 'review') renderReview();
  updateBudgetDisplay();

  // 天气纵向轮播（天气数据就绪后 DOM 已存在，重渲染时自动重绑）
  startWeatherCarousel();

  // 恢复分摊状态（如果 render 中某处误重置了）
  if (savedSplitMode === 'custom') {
    state.splitMode = 'custom';
    state.splitCustomManual = savedSplitManual;
    state.splitCustomValues = savedSplitValues;
    // 确保自定义面板可见
    const box = $('#splitCustomAmounts');
    if (box && box.classList.contains('hidden')) {
      box.classList.remove('hidden');
    }
    const btnEq = $('#splitModeEqual');
    const btnCustom = $('#splitModeCustom');
    if (btnEq) btnEq.classList.toggle('active', false);
    if (btnCustom) btnCustom.classList.toggle('active', true);
  }
}

// ---------------- 概览仪表盘 ----------------
function renderOverview() {
  const r = state.room;
  const items = (r.items || []).filter(i => i.status !== 'dropped');
  const expenses = r.expenses || [];
  const box = $('#overviewContent');
  if (!box) return;

  const days = [...new Set(items.map(i => i.date))].sort();
  const allPeople = r.people || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = days.length > 0 ? new Date(days[0] + 'T00:00:00') : null;
  const daysUntil = firstDay ? Math.ceil((firstDay - today) / 86400000) : null;

  const MOP_RATE = 0.9;
  let totalCNY = 0;
  expenses.forEach(e => {
    totalCNY += e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
  });

  // 0. 今日行程 + 进行中/下一站
  let html = '';
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const todayItems = items.filter(i => i.date === todayStr).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (todayItems.length > 0) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const toMin = t => { const p = (t || '00:00').split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); };
    let current = null, next = null;
    for (const it of todayItems) { if (toMin(it.time) <= nowMin) current = it; else { next = it; break; } }
    if (!next) next = todayItems[todayItems.length - 1];
    html += '<div class="dash-today">';
    html += '<div class="dash-today-header">📍 今日行程 · ' + todayStr + ' · ' + todayItems.length + ' 站</div>';
    if (current && current !== next) {
      html += '<div class="dash-now"><span class="dash-now-badge">🔵 进行中</span><span class="dash-now-place">' + current.place + '</span><span class="dash-now-time">' + (current.time || '') + '</span></div>';
    }
    if (next) {
      const distTxt = (current && current.lat && next.lat && current.lng && next.lng) ? ' · 距上一站 ' + haversine(current, next).toFixed(1) + 'km' : '';
      const navBtn = (next.lat && next.lng) ? ' <a class="dash-next-go" href="' + amapNav(next.lat, next.lng, next.place) + '" target="_blank">🧭 导航</a>' : '';
      html += '<div class="dash-next"><span class="dash-next-badge">⏭️ 下一站</span><span class="dash-next-place">' + next.place + '</span>' + distTxt + navBtn + '</div>';
    }
    html += '<div class="dash-today-list">';
    todayItems.forEach(it => {
      const typeIcon = { '景点':'🏛️','餐饮':'🍜','住宿':'🏨','交通':'🚗' }[it.type] || '📌';
      const isNow = it === current && current !== next;
      const isNext = it === next;
      html += '<div class="dash-today-item' + (isNow ? ' dash-item-now' : '') + (isNext ? ' dash-item-next' : '') + '"><span class="dash-today-time">' + (it.time || '--:--') + '</span><span class="dash-today-icon">' + typeIcon + '</span><span class="dash-today-place">' + it.place + '</span></div>';
    });
    html += '</div></div>';
  } else if (days.length > 0) {
    // 无今日行程但有时程 → 下方显示明日预告
  }

  // 天气预警（针对有行程的天）
  if (state.weather && state.weather !== 'loading' && state.weather.daily) {
    const wxData = state.weather.daily;
    const wxTimes = wxData.time || [];
    const wxMax = wxData.temperature_2m_max || [];
    const wxMin = wxData.temperature_2m_min || [];
    const wxPrecip = wxData.precipitation_probability_max || [];
    const alerts = [];
    for (let i = 0; i < wxTimes.length; i++) {
      const d = wxTimes[i];
      const hasItems = items.some(it => it.date === d);
      if (!hasItems) continue;
      const precip = wxPrecip[i] != null ? wxPrecip[i] : 0;
      const maxT = Math.round(wxMax[i] || 0);
      const minT = Math.round(wxMin[i] || 0);
      if (precip > 50) alerts.push({ date: d, type: 'rain', msg: '☔ 降水概率 ' + precip + '%，记得带伞！' });
      if (maxT > 35) alerts.push({ date: d, type: 'hot', msg: '🔥 高温 ' + maxT + '°C，注意防暑防晒！' });
      if (maxT - minT > 15) alerts.push({ date: d, type: 'temp', msg: '🌡️ 温差 ' + (maxT - minT) + '°C，建议带件外套' });
    }
    if (alerts.length > 0) {
      html += '<div class="dash-alerts">';
      alerts.slice(0, 3).forEach(a => {
        html += '<div class="dash-alert dash-alert-' + a.type + '"><span class="dash-alert-date">' + a.date + '</span> ' + a.msg + '</div>';
      });
      html += '</div>';
    }
  }

  // 明日预告（如有）
  if (days.length > 0 && todayItems.length > 0) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const tomorrowItems = items.filter(i => i.date === tomorrowStr).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (tomorrowItems.length > 0) {
      html += '<div class="dash-tomorrow">';
      html += '<div class="dash-tomorrow-header" onclick="toggleTomorrow()">🔮 明日预告 · ' + tomorrowStr + ' <span class="dash-tomorrow-toggle">展开 ▼</span></div>';
      html += '<div class="dash-tomorrow-body" style="display:none">';
      tomorrowItems.forEach(it => {
        const typeIcon = { '景点':'🏛️','餐饮':'🍜','住宿':'🏨','交通':'🚗' }[it.type] || '📌';
        html += '<div class="dash-today-item"><span class="dash-today-time">' + (it.time || '--:--') + '</span><span class="dash-today-icon">' + typeIcon + '</span><span class="dash-today-place">' + it.place + '</span></div>';
      });
      html += '</div></div>';
    }
  }

  // 1. 倒计时
  html += '<div class="dash-countdown">';
  html += '<div class="dash-cd-icon">&#x1F3DD;&#xFE0F;</div>';
  html += '<div class="dash-cd-body">';
  if (daysUntil !== null && daysUntil > 0) {
    html += '<div class="dash-cd-num">' + daysUntil + '</div>';
    html += '<div class="dash-cd-label">天后出发</div>';
    html += '<div class="dash-cd-date">' + days[0] + ' ~ ' + days[days.length - 1] + '</div>';
  } else if (daysUntil !== null && daysUntil === 0) {
    html += '<div class="dash-cd-num">&#x1F389;</div>';
    html += '<div class="dash-cd-label">今天出发！</div>';
    html += '<div class="dash-cd-date">' + days[0] + ' ~ ' + days[days.length - 1] + '</div>';
  } else if (daysUntil !== null && daysUntil < 0) {
    html += '<div class="dash-cd-num">&#x2708;&#xFE0F;</div>';
    html += '<div class="dash-cd-label">旅行进行中</div>';
    html += '<div class="dash-cd-date">' + days[0] + ' ~ ' + days[days.length - 1] + '</div>';
  } else {
    html += '<div class="dash-cd-num">--</div>';
    html += '<div class="dash-cd-label">等待添加行程</div>';
  }
  html += '</div>';

  // 1.5 天气融入倒计时卡片
  html += '<div id="dashWeather" class="dash-cd-weather">';
  if (state.weather && state.weather !== 'loading') {
    html += renderWeatherHTML(state.weather, items);
  } else if (state.weather === 'loading') {
    html += '<div style="padding:8px;text-align:center;opacity:.7;font-size:var(--fs-xs)">🌤️ 正在获取天气…</div>';
  }
  html += '</div>';

  html += '</div>';

  // 2. 关键数据
  html += '<div class="dash-stats">';
  html += '<div class="dash-stat"><div class="dash-stat-val">' + days.length + '</div><div class="dash-stat-label">行程天数</div></div>';
  html += '<div class="dash-stat"><div class="dash-stat-val">' + items.length + '</div><div class="dash-stat-label">行程条目</div></div>';
  html += '<div class="dash-stat"><div class="dash-stat-val">\u00A5' + totalCNY.toFixed(0) + '</div><div class="dash-stat-label">总费用(估)</div></div>';
  html += '<div class="dash-stat"><div class="dash-stat-val">' + allPeople.length + '</div><div class="dash-stat-label">同行人数</div></div>';
  html += '</div>';

  // 2.5 触发天气数据加载（只会在没有数据时请求一次）
  initWeather();

  // 3. 费用分类环形图
  if (expenses.length > 0) {
    const catStats = {};
    expenses.forEach(e => {
      const cat = e.category || '其他';
      if (!catStats[cat]) catStats[cat] = 0;
      catStats[cat] += e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
    });

    const catColors = { '餐饮':'#EF4444', '交通':'#0891B2', '门票':'#8B5CF6', '住宿':'#F59E0B', '购物':'#10B981', '其他':'#64748B' };
    const sorted = Object.entries(catStats).sort((a, b) => b[1] - a[1]);

    const cx = 60, cy = 60, r = 48, strokeW = 20;
    const circumference = 2 * Math.PI * r;
    let offset = 0;
    let ringPath = '';
    sorted.forEach(([cat, amt]) => {
      const pct = amt / totalCNY;
      const dashLen = pct * circumference;
      const color = catColors[cat] || '#94A3B8';
      ringPath += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-dasharray="' + dashLen.toFixed(1) + ' ' + (circumference - dashLen).toFixed(1) + '" stroke-dashoffset="' + (-offset).toFixed(1) + '" stroke-linecap="butt" transform="rotate(-90 ' + cx + ' ' + cy + ')" />';
      offset += dashLen;
    });

    html += '<div class="dash-card">';
    html += '<div class="dash-card-title">\u{1F4CA} 费用分布</div>';
    html += '<div class="dash-ring-row">';
    html += '<svg class="dash-ring-svg" width="120" height="120" viewBox="0 0 120 120">';
    html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#F1F5F9" stroke-width="' + strokeW + '" />';
    html += ringPath;
    html += '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" font-size="14" font-weight="800" fill="#1E293B">\u00A5' + totalCNY.toFixed(0) + '</text>';
    html += '<text x="' + cx + '" y="' + (cy + 12) + '" text-anchor="middle" font-size="9" fill="#94A3B8">' + expenses.length + '笔</text>';
    html += '</svg>';
    html += '<div class="dash-legend">';
    sorted.forEach(([cat, amt]) => {
      const pct = (amt / totalCNY * 100).toFixed(0);
      html += '<div class="dash-legend-item"><span class="dash-legend-dot" style="background:' + (catColors[cat] || '#94A3B8') + '"></span><span class="dash-legend-name">' + cat + '</span><span class="dash-legend-amt">\u00A5' + amt.toFixed(0) + '</span></div>';
    });
    html += '</div></div></div>';
  }

  // 4. 结算待付款
  if (expenses.length > 0) {
    const balances = {};
    allPeople.forEach(p => balances[p] = 0);
    expenses.forEach(e => {
      const amtCNY = e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
      const split = (e.splitAmong && e.splitAmong.length > 0) ? e.splitAmong : allPeople;
      const share = amtCNY / split.length;
      balances[e.payer] = (balances[e.payer] || 0) + amtCNY;
      split.forEach(p => { balances[p] = (balances[p] || 0) - share; });
    });
    const debts = Object.entries(balances).map(([name, diff]) => ({ name, diff }))
      .filter(d => Math.abs(d.diff) > 0.01);
    const creditors = debts.filter(d => d.diff > 0).sort((a, b) => b.diff - a.diff);
    const debtors = debts.filter(d => d.diff < 0).sort((a, b) => a.diff - b.diff);

    html += '<div class="dash-card">';
    html += '<div class="dash-card-title">\u{1F504} 结算待付款</div>';
    if (creditors.length === 0 || debtors.length === 0) {
      html += '<div class="dash-settle-empty">\u2705 全部已结清，无需付款</div>';
    } else {
      let ci = 0, di = 0;
      let c = { ...creditors[ci] }, d = { ...debtors[di] };
      let settleCount = 0;
      while (ci < creditors.length && di < debtors.length && settleCount < 5) {
        const amt = Math.min(c.diff, -d.diff);
        html += '<div class="dash-settle-row"><span class="dash-settle-from">' + d.name + '</span><span class="dash-settle-arrow">\u2192</span><span class="dash-settle-to">' + c.name + '</span><span class="dash-settle-amt">\u00A5' + amt.toFixed(2) + '</span></div>';
        c.diff -= amt; d.diff += amt;
        if (c.diff < 0.01) { ci++; if (ci < creditors.length) c = { ...creditors[ci] }; }
        if (d.diff > -0.01) { di++; if (di < debtors.length) d = { ...debtors[di] }; }
        settleCount++;
      }
    }
    html += '</div>';
  }

  // 5. 行程时间线预览
  if (items.length > 0) {
    html += '<div class="dash-card">';
    html += '<div class="dash-card-title">\u{1F4C5} 行程预览</div>';
    // 最多展示最近3天的行程
    const previewDays = days.slice(0, 3);
    previewDays.forEach(day => {
      const list = items.filter(i => i.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      if (!list.length) return;
      html += '<div class="dash-day-group">';
      html += '<div class="dash-day-head">\u{1F4C5} ' + day + ' \u00B7 ' + list.length + '条</div>';
      list.slice(0, 4).forEach(it => {
        html += '<div class="dash-day-item">';
        html += '<span class="dash-day-time">' + (it.time || '--:--') + '</span>';
        html += '<span class="dash-day-place">' + it.place + '</span>';
        html += '<span class="dash-day-type">' + it.type + '</span>';
        html += '</div>';
      });
      if (list.length > 4) {
        html += '<div class="dash-day-item" style="justify-content:center;color:var(--text-muted)">还有 ' + (list.length - 4) + ' 条行程…</div>';
      }
      html += '</div>';
    });
    if (days.length > 3) {
      html += '<div style="text-align:center;color:var(--text-muted);font-size:var(--fs-xs);padding:4px 0">还有 ' + (days.length - 3) + ' 天行程，切换到"行程"Tab查看全部</div>';
    }
    html += '</div>';
  }

  box.innerHTML = html;
}

function tagHtml(type) { return '<span class="tag ' + type + '">' + type + '</span>'; }
function formatNote(n) { return n ? n.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g, '<br>') : ''; }
function statusPill(s) {
  const map = { kept: '已保留', proposed: '待审阅', dropped: '已删除', merged: '已合并' };
  return '<span class="status-pill ' + s + '">' + (map[s] || s) + '</span>';
}

function renderPlan() {
  let items = state.room.items;
  // 搜索过滤
  const q = state.planSearch.toLowerCase().trim();
  const ft = state.planFilterType;
  if (q || ft || state.planFilterMine) {
    items = items.filter(i => {
      if (ft && i.type !== ft) return false;
      if (state.planFilterMine && i.creator !== state.userName) return false;
      if (q) {
        const searchStr = (i.place + ' ' + (i.note || '') + ' ' + (i.creator || '')).toLowerCase();
        if (!searchStr.includes(q)) return false;
      }
      return true;
    });
  }
  const days = [...new Set(items.map(i => i.date))].sort();
  const searchBar = $('#planSearchBar');
  // 有行程时显示搜索栏
  if (items.length > 0 || state.room.items.length > 0) {
    if (searchBar) searchBar.style.display = '';
    // 更新类型筛选 chips
    const allTypes = ['景点','餐饮','住宿','交通','其他'];
    const chipContainer = $('#planFilterChips');
    if (chipContainer) {
      const typeCounts = {};
      state.room.items.forEach(i => { typeCounts[i.type] = (typeCounts[i.type] || 0) + 1; });
      let chips = '<button class="plan-chip' + (ft === '' && !state.planFilterMine ? ' active' : '') + '" onclick="setPlanFilter(\x27\x27)">' + '全部' + ' (' + state.room.items.filter(i => i.status !== 'dropped').length + ')</button>';
      if (state.userName) {
        const myCnt = state.room.items.filter(i => i.creator === state.userName && i.status !== 'dropped').length;
        chips += '<button class="plan-chip plan-chip-mine' + (state.planFilterMine ? ' active' : '') + '" onclick="setPlanFilterMine()">👤 我创建的 (' + myCnt + ')</button>';
      }
      chips += allTypes.map(type => {
          const cnt = typeCounts[type] || 0;
          return '<button class="plan-chip' + (ft === type ? ' active' : '') + '" onclick="setPlanFilter(\'' + type + '\')">' + ({'景点':'🏛️','餐饮':'🍜','住宿':'🏨','交通':'🚗','其他':'📌'}[type] || '') + ' ' + type + (cnt > 0 ? ' (' + cnt + ')' : '') + '</button>';
        }).join('');
      chipContainer.innerHTML = chips;
    }
  } else {
    if (searchBar && ft === '' && q === '') searchBar.style.display = 'none';
  }
  if (!items.length) {
    let emptyMsg = (q || ft || state.planFilterMine) ? '没有匹配的行程' : '还没有行程，先在上方添加吧 ✍️';
    const planList = $('#planList');
    planList.innerHTML = '<div class="empty">' + emptyMsg + '</div>';
    return;
  }
  if (state.planMapMode) { $('#planList').innerHTML = renderPlanMap(); return; }
  let html = '';
  if (state.userName) {
    const mine = (state.room.items || []).filter(i => i.creator === state.userName);
    const kept = mine.filter(i => i.status === 'kept').length;
    const prop = mine.filter(i => i.status === 'proposed').length;
    const other = mine.length - kept - prop;
    html += '<div class="my-status-banner">👤 我的提交 <b>' + mine.length + '</b> 条 · ✅ 已采纳 ' + kept + ' · ⏳ 待审阅 ' + prop + (other ? ' · 🗑️ 已处理 ' + other : '') + '</div>';
  }
  days.forEach(day => {
    const list = items.filter(i => i.date === day && (i.status === 'kept' || i.status === 'proposed'))
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!list.length) return;
    html += '<div class="day-group"><div class="day-head">📅 ' + day + ' ' + weatherBriefForDate(day) + '</div>';
    list.forEach(it => {
      // 搜索高亮
      let placeDisplay = it.place;
      if (q) {
        const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        placeDisplay = it.place.replace(re, '<mark>$1</mark>');
      }
      html += itemRowHtmlSearchAware(it, placeDisplay);
    });
    html += '</div>';
  });
  $('#planList').innerHTML = html;
}

function itemRowHtmlSearchAware(it, placeDisplay) {
  const linkedExpenses = (state.room.expenses || []).filter(e => e.linkedItemId === it.id);
  const expBadge = linkedExpenses.length > 0
    ? '<span class="cost-badge" onclick="switchTab(\'expense\')" style="cursor:pointer">💰 ' + linkedExpenses.length + '笔</span>'
    : '';
  return '<div class="item-row" draggable="true" data-id="' + it.id + '" data-date="' + it.date + '" data-time="' + (it.time || '') + '">' +
    '<div class="drag-handle" title="拖拽排序">⋮⋮</div>' +
    '<div class="item-top">' +
      '<div class="item-time">' + (it.time || '--:--') + '</div>' +
      '<div class="item-main">' +
        '<div class="item-place">' + placeDisplay + ' ' + tagHtml(it.type) + '</div>' +
        '<div class="item-meta">' +
          (it.note ? '<span class="item-note">' + formatNote(it.note) + '</span>' : '') +
          expBadge +
          '<span class="creator-badge">' + it.creator + '</span>' +
          statusPill(it.status) +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="item-btns">' + (state.isViewOnly ? '' : '<button class="edit" onclick="event.stopPropagation();editItem(\'' + it.id + '\')">编</button><button class="del" onclick="event.stopPropagation();deleteItem(\'' + it.id + '\')">删</button>') + '</div>' +
  '</div>';
}

function setPlanFilter(type) {
  state.planFilterType = type;
  renderPlan();
}

function clearPlanSearch() {
  const inp = $('#planSearchInput');
  if (inp) inp.value = '';
  state.planSearch = '';
  $('#planSearchClear').style.display = 'none';
  renderPlan();
}

function setPlanFilterMine() {
  state.planFilterMine = !state.planFilterMine;
  state.planFilterType = '';
  renderPlan();
}

function togglePlanMap() {
  state.planMapMode = !state.planMapMode;
  const b = $('#planMapToggle');
  if (b) b.classList.toggle('active', state.planMapMode);
  renderPlan();
}

// 每天天气简述（概览已拉取，行程日头复用）
function weatherBriefForDate(date) {
  const w = state.weather;
  if (!w || !w.daily || !w.daily.time) return '';
  const i = w.daily.time.indexOf(date);
  if (i < 0) return '';
  const code = (w.daily.weathercode || [])[i] ?? 0;
  const icon = WEATHER_ICONS[code] || '🌡️';
  const maxT = Math.round((w.daily.temperature_2m_max || [])[i] || 0);
  const minT = Math.round((w.daily.temperature_2m_min || [])[i] || 0);
  return '<span class="day-weather" title="' + escHtml(WEATHER_TEXT[code] || '') + '">' + icon + ' ' + minT + '~' + maxT + '°</span>';
}

// 按天地图：经纬度相对投影散点图（离线可用，不使用外部地图瓦片，规避合规风险）
function renderPlanMap() {
  const pts = (state.room.items || []).filter(i => (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng);
  if (pts.length === 0) return '<div class="empty">还没有带坐标的行程，无法绘制地图<br><span style="font-size:12px;color:#94a3b8">编辑行程并补充地点后会自动出现</span></div>';
  const days = [...new Set(pts.map(i => i.date))].sort();
  const dayColors = ['#FF6B35', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#14B8A6'];
  const dayColor = {}; days.forEach((d, idx) => dayColor[d] = dayColors[idx % dayColors.length]);
  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 26, W = 360, H = 240;
  const spanLat = Math.max(maxLat - minLat, 0.002), spanLng = Math.max(maxLng - minLng, 0.002);
  const sx = (W - 2 * pad) / spanLng, sy = (H - 2 * pad) / spanLat;
  const s = Math.min(sx, sy);
  const ox = pad + ((W - 2 * pad) - spanLng * s) / 2, oy = pad + ((H - 2 * pad) - spanLat * s) / 2;
  const proj = p => ({ x: ox + (p.lng - minLng) * s, y: oy + (maxLat - p.lat) * s });
  let svg = '<svg class="plan-map" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  days.forEach(d => {
    const dl = pts.filter(p => p.date === d).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (dl.length >= 2) {
      const ptsStr = dl.map(p => { const q = proj(p); return q.x.toFixed(1) + ',' + q.y.toFixed(1); }).join(' ');
      svg += '<polyline points="' + ptsStr + '" fill="none" stroke="' + dayColor[d] + '" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.7"/>';
    }
  });
  const sorted = pts.slice().sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const dayOrder = {}; days.forEach(d => dayOrder[d] = 0);
  sorted.forEach(p => {
    const q = proj(p); const c = dayColor[p.date]; const n = (dayOrder[p.date]++ + 1);
    svg += '<circle cx="' + q.x.toFixed(1) + '" cy="' + q.y.toFixed(1) + '" r="9" fill="' + c + '" stroke="#fff" stroke-width="2"/>';
    svg += '<text x="' + q.x.toFixed(1) + '" y="' + (q.y + 3).toFixed(1) + '" font-size="10" fill="#fff" text-anchor="middle" font-weight="700">' + n + '</text>';
    const label = (p.place || '').length > 9 ? (p.place || '').slice(0, 9) + '…' : (p.place || '');
    svg += '<text x="' + (q.x + 12).toFixed(1) + '" y="' + (q.y + 3).toFixed(1) + '" font-size="9" fill="#334155">' + escHtml(label) + '</text>';
  });
  svg += '</svg>';
  let legend = '<div class="plan-map-legend">';
  days.forEach(d => { legend += '<span class="plan-map-legend-item"><span class="plan-map-dot" style="background:' + dayColor[d] + '"></span>' + d + '</span>'; });
  legend += '</div>';
  return '<div class="plan-map-wrap">' + svg + legend + '<div class="plan-map-hint">📌 按经纬度相对位置绘制；虚线为当天行程顺序，圆点数字为当日次序</div></div>';
}

// ---------------- 行程拖拽排序 ----------------
function setupDragDrop() {
  const planList = $('#planList');
  if (!planList) return;
  let dragSrc = null;

  planList.addEventListener('dragstart', function(e) {
    const row = e.target.closest('.item-row');
    if (!row || !state.isLoggedIn) { e.preventDefault(); return; }
    dragSrc = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.id);
  });

  planList.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.item-row');
    if (!row || row === dragSrc) return;
    row.classList.add('drag-over');
  });

  planList.addEventListener('dragleave', function(e) {
    const row = e.target.closest('.item-row');
    if (row) row.classList.remove('drag-over');
  });

  planList.addEventListener('drop', function(e) {
    e.preventDefault();
    const target = e.target.closest('.item-row');
    if (!target || !dragSrc || target === dragSrc || target.dataset.date !== dragSrc.dataset.date) {
      // 不同日期不允许拖拽
      dragSrc = null; cleanupDragClasses(); return;
    }
    target.classList.remove('drag-over');

    const dayItems = state.room.items.filter(i =>
      i.date === target.dataset.date && i.id !== dragSrc.dataset.id &&
      (i.status === 'kept' || i.status === 'proposed')
    ).sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    // 找到目标位置
    const targetIdx = dayItems.findIndex(i => i.id === target.dataset.id);
    const srcItem = state.room.items.find(i => i.id === dragSrc.dataset.id);
    if (!srcItem || targetIdx < 0) { cleanupDragClasses(); return; }

    // 重新排序：移除 src，插入到 target 位置
    dayItems.splice(targetIdx, 0, srcItem);
    applyDragOrder(dayItems);
  });

  planList.addEventListener('dragend', function(e) {
    cleanupDragClasses();
    dragSrc = null;
  });

  function cleanupDragClasses() {
    planList.querySelectorAll('.item-row.dragging, .item-row.drag-over')
      .forEach(el => { el.classList.remove('dragging', 'drag-over'); });
  }
}

async function applyDragOrder(dayItems) {
  // 为重新排序的条目计算新的时间（保持间隔15分钟）
  const baseHour = 7, baseMin = 0;
  const promises = [];
  showToast('正在保存排序…', 'info');
  for (let i = 0; i < dayItems.length; i++) {
    const mins = baseHour * 60 + baseMin + i * 15;
    const h = Math.floor(mins / 60), m = mins % 60;
    const newTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    if (dayItems[i].time !== newTime) {
      dayItems[i].time = newTime;
      promises.push(
        fetch('/api/rooms/' + state.roomId + '/items/' + dayItems[i].id, {
          method: 'PATCH',
          headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
          body: JSON.stringify({ time: newTime })
        }).then(r => r.json())
      );
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
    showToast('排序已保存 ✅', 'success');
  }
  await refresh();
}

function toggleTomorrow() {
  const body = document.querySelector('.dash-tomorrow-body');
  const toggle = document.querySelector('.dash-tomorrow-toggle');
  if (!body || !toggle) return;
  if (body.style.display === 'none') {
    body.style.display = '';
    toggle.textContent = '收起 ▲';
  } else {
    body.style.display = 'none';
    toggle.textContent = '展开 ▼';
  }
}

// ---------------- 数据导出备份 ----------------
async function exportBackup() {
  try {
    showToast('正在生成备份…', 'info');
    const resp = await fetch('/api/admin/export', { headers: getAuthHeaders() });
    if (!resp.ok) throw new Error('导出失败: ' + resp.status);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'travel-planner-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('备份已下载 ✅', 'success');
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

function itemRowHtml(it) {
  // 统计关联到此行程的费用
  const linkedExpenses = (state.room.expenses || []).filter(e => e.linkedItemId === it.id);
  const expBadge = linkedExpenses.length > 0
    ? '<span class="cost-badge" onclick="switchTab(\'expense\')" style="cursor:pointer">💰 ' + linkedExpenses.length + '笔</span>'
    : '';
  return '<div class="item-row">' +
    '<div class="item-top">' +
      '<div class="item-time">' + (it.time || '--:--') + '</div>' +
      '<div class="item-main">' +
        '<div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
        '<div class="item-meta">' +
          (it.note ? '<span class="item-note">' + formatNote(it.note) + '</span>' : '') +
          expBadge +
          '<span class="creator-badge">' + it.creator + '</span>' +
          statusPill(it.status) +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="item-btns">' + (state.isViewOnly ? '' : '<button class="edit" onclick="editItem(\'' + it.id + '\')">编</button><button class="del" onclick="deleteItem(\'' + it.id + '\')">删</button>') + '</div>' +
  '</div>';
}

// ---------------- 费用管理（独立模块） ----------------
function fmtMoney(amount, currency) {
  if (currency === 'MOP') return 'MOP$' + Number(amount).toFixed(2);
  return '\u00A5' + Number(amount).toFixed(2);
}

function renderExpense() {
  const expenses = (state.room.expenses || []).slice().sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    return (b.time || '').localeCompare(a.time || '');
  });
  const box = $('#expenseList');
  if (!box) return;

  // 初始化表单选项
  refreshExpenseFormOptions();

  if (!expenses.length) {
    box.innerHTML = '<div class="empty">还没有费用记录<br><span style="font-size:12px;color:#94a3b8">旅行中花了钱？点上方"记一笔"记录吧</span></div>';
    return;
  }

  const allPeople = getExpensePeople();
  const days = [...new Set(expenses.map(e => e.date))].sort().reverse();

  // 按币种分别统计总额
  const totalsByCurrency = {};
  expenses.forEach(e => {
    const cur = e.currency || 'CNY';
    if (!totalsByCurrency[cur]) totalsByCurrency[cur] = 0;
    totalsByCurrency[cur] += Number(e.amount || 0);
  });

  // 按分类统计
  const catStats = {};
  expenses.forEach(e => {
    const cat = e.category || '其他';
    if (!catStats[cat]) catStats[cat] = { count: 0, total: 0 };
    catStats[cat].count++;
    catStats[cat].total += Number(e.amount || 0);
  });

  // 按付款人统计（按 CNY 简化处理，MOP 按 1:0.9 估算展示）
  const MOP_RATE = 0.9;
  const payerStats = {};
  expenses.forEach(e => {
    const p = e.payer || '未知';
    const amtCNY = e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
    if (!payerStats[p]) payerStats[p] = { paid: 0, paidOriginal: { CNY: 0, MOP: 0 }, count: 0 };
    payerStats[p].paid += amtCNY;
    const curKey = e.currency || 'CNY';
    if (payerStats[p].paidOriginal[curKey] == null) payerStats[p].paidOriginal[curKey] = 0;
    payerStats[p].paidOriginal[curKey] += Number(e.amount || 0);
    payerStats[p].count++;
  });

  // 分摊计算 — 每笔费用按 splitAmong 分摊（支持自定义金额）
  const balances = {}; // name -> net balance (正=应收, 负=应付)
  allPeople.forEach(p => balances[p] = 0);
  expenses.forEach(e => {
    const amtCNY = e.currency === 'MOP' ? Number(e.amount) * MOP_RATE : Number(e.amount);
    const split = (e.splitAmong && e.splitAmong.length > 0) ? e.splitAmong : allPeople;

    // 自定义分摊金额 — 按比例计算
    if (e.splitAmounts && Object.keys(e.splitAmounts).length > 0) {
      const totalCustom = Object.values(e.splitAmounts).reduce((s, v) => s + Math.abs(v), 0);
      if (totalCustom > 0) {
        balances[e.payer] = (balances[e.payer] || 0) + amtCNY;
        split.forEach(p => {
          const share = ((e.splitAmounts[p] || 0) / totalCustom) * amtCNY;
          balances[p] = (balances[p] || 0) - share;
        });
        return;
      }
    }

    // 均分
    const share = amtCNY / split.length;
    balances[e.payer] = (balances[e.payer] || 0) + amtCNY;
    split.forEach(p => { balances[p] = (balances[p] || 0) - share; });
  });

  const totalCNY = Object.values(totalsByCurrency).reduce((s, v, i) => {
    const cur = Object.keys(totalsByCurrency)[i];
    return s + (cur === 'MOP' ? v * MOP_RATE : v);
  }, 0);

  let html = '';

  // 总览卡片
  const avgPerPerson = allPeople.length > 0 ? totalCNY / allPeople.length : 0;
  const catColors = { '餐饮':'#EF4444', '交通':'#3B82F6', '门票':'#8B5CF6', '住宿':'#F59E0B', '购物':'#10B981', '其他':'#64748B' };
  const catBarParts = [];
  Object.entries(catStats).sort((a, b) => b[1].total - a[1].total).forEach(([cat, st]) => {
    const pct = totalCNY > 0 ? (st.total / totalCNY * 100) : 0;
    if (pct >= 1) catBarParts.push('<span class="cat-bar-seg" style="flex:' + pct.toFixed(1) + ';background:' + (catColors[cat] || '#94A3B8') + ';" title="' + cat + ' ¥' + st.total.toFixed(0) + '"></span>');
  });
  html += '<div class="expense-summary">';
  html += '<div class="exp-head-row">';
  html += '<div class="exp-head-main">';
  html += '<div class="exp-total-num">\u00A5' + totalCNY.toFixed(0) + '</div>';
  html += '<div class="exp-total-label">总费用 \u00B7 ' + expenses.length + ' 笔</div>';
  html += '</div>';
  html += '<div class="exp-head-side">';
  html += '<div class="exp-avg-num">\u00A5' + avgPerPerson.toFixed(0) + '</div>';
  html += '<div class="exp-avg-label">' + '人均' + ' / ' + allPeople.length + '人</div>';
  html += '</div>';
  html += '</div>';
  if (catBarParts.length > 0) {
    html += '<div class="cat-bar">' + catBarParts.join('') + '</div>';
    html += '<div class="cat-bar-labels">';
    Object.entries(catStats).sort((a, b) => b[1].total - a[1].total).forEach(([cat, st]) => {
      const pct = totalCNY > 0 ? (st.total / totalCNY * 100).toFixed(0) : 0;
      if (pct >= 1) html += '<span class="cat-bar-label"><span class="cat-dot" style="background:' + (catColors[cat] || '#94A3B8') + '"></span>' + cat + ' ' + pct + '%</span>';
    });
    html += '</div>';
  }
  html += '</div>';

  // 分类统计
  html += '<div class="expense-section"><h4>📊 ' + '费用总览' + '</h4><div class="cat-stats">';
  Object.entries(catStats).sort((a, b) => b[1].total - a[1].total).forEach(([cat, st]) => {
    const icon = EXPENSE_CATEGORIES[cat] || '\u{1F4A1}';
    html += '<div class="cat-stat-item"><span class="cat-icon">' + icon + '</span><span class="cat-name">' + cat + '</span><span class="cat-count">' + st.count + '笔</span><span class="cat-amt">\u00A5' + st.total.toFixed(0) + '</span></div>';
  });
  html += '</div></div>';

  // 付款明细
  html += '<div class="expense-section"><h4>💳 付款明细</h4>';
  html += '<table class="exp-table"><thead><tr><th>付款人</th><th class="exp-amt">已付</th><th class="exp-amt">笔数</th><th class="exp-amt">净值</th></tr></thead><tbody>';
  const sortedPayers = Object.entries(payerStats).sort((a, b) => b[1].paid - a[1].paid);
  sortedPayers.forEach(([name, st]) => {
    const bal = balances[name] || 0;
    const balStr = Math.abs(bal) < 0.01 ? '<span style="color:#94a3b8">\u00A50</span>'
      : bal > 0 ? '<span class="exp-pos">+\u00A5' + bal.toFixed(2) + '</span>'
      : '<span class="exp-neg">-\u00A5' + (-bal).toFixed(2) + '</span>';
    // 显示原始币种
    const parts = [];
    if (st.paidOriginal.CNY > 0) parts.push('\u00A5' + st.paidOriginal.CNY.toFixed(2));
    if (st.paidOriginal.MOP > 0) parts.push('MOP$' + st.paidOriginal.MOP.toFixed(2));
    html += '<tr><td class="exp-name">' + name + '</td><td class="exp-amt">' + parts.join(' + ') + '</td><td class="exp-amt">' + st.count + '</td><td class="exp-amt">' + balStr + '</td></tr>';
  });
  html += '</tbody></table></div>';

  // 结算建议
  const debts = Object.entries(balances).map(([name, diff]) => ({ name, diff }))
    .filter(d => Math.abs(d.diff) > 0.01);
  const creditors = debts.filter(d => d.diff > 0).sort((a, b) => b.diff - a.diff);
  const debtors = debts.filter(d => d.diff < 0).sort((a, b) => a.diff - b.diff);

  if (creditors.length > 0 && debtors.length > 0) {
    let settleLines = [];
    html += '<div class="expense-section"><h4>🔄 结算建议 <button class="btn-sm btn-outline settle-copy-btn" style="float:right" onclick="copySettlement()">📋 复制清单</button></h4><div class="settle-list">';
    let ci = 0, di = 0;
    let c = creditors[ci], d = debtors[di];
    while (ci < creditors.length && di < debtors.length) {
      const amt = Math.min(c.diff, -d.diff);
      html += '<div class="settle-row"><span class="settle-from">' + d.name + '</span> \u2192 <span class="settle-to">' + c.name + '</span> <span class="settle-amt">\u00A5' + amt.toFixed(2) + '</span></div>';
      settleLines.push(d.name + ' → ' + c.name + '：\u00A5' + amt.toFixed(2));
      c.diff -= amt; d.diff += amt;
      if (c.diff < 0.01) { ci++; if (ci < creditors.length) c = creditors[ci]; }
      if (d.diff > -0.01) { di++; if (di < debtors.length) d = debtors[di]; }
    }
    html += '</div></div>';
    state._settleText = '【旅行结算清单】\n' + settleLines.join('\n');
  } else {
    state._settleText = '';
  }

  // 按天列出费用明细
  html += '<div class="expense-section"><h4>📋 费用时间线</h4>';
  days.forEach(day => {
    const list = expenses.filter(e => e.date === day).sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const dayTotals = {};
    list.forEach(e => {
      const cur = e.currency || 'CNY';
      if (!dayTotals[cur]) dayTotals[cur] = 0;
      dayTotals[cur] += Number(e.amount || 0);
    });
    const dayTotalStr = Object.entries(dayTotals).map(([cur, val]) => fmtMoney(val, cur)).join(' + ');
    html += '<div class="exp-day"><div class="exp-day-head">\u{1F4C5} ' + day + ' \u00B7 ' + dayTotalStr + '</div>';
    list.forEach(e => {
      const icon = EXPENSE_CATEGORIES[e.category] || '\u{1F4A1}';
      const linkedItem = e.linkedItemId ? (state.room.items || []).find(i => i.id === e.linkedItemId) : null;
      const linkedBadge = linkedItem ? '<span class="linked-badge">\u{1F517} ' + linkedItem.place + '</span>' : '';
      const splitInfo = (e.splitAmounts && Object.keys(e.splitAmounts).length > 0)
        ? '<span class="split-info split-custom-tag">📐自定义</span>'
        : (e.splitAmong && e.splitAmong.length > 0)
        ? '<span class="split-info">' + e.splitAmong.length + '人AA</span>'
        : '';
      const canModify = !state.isViewOnly;
      const editBtn = canModify ? '<button class="exp-edit" onclick="editExpense(\'' + e.id + '\')">编</button><button class="exp-del" onclick="deleteExpense(\'' + e.id + '\')">删</button>' : '';
      const receiptThumb = (e.receiptId)
        ? '<div class="exp-receipt" onclick="viewReceipt(\'' + e.receiptId + '\')"><img src="/api/receipt/' + e.receiptId + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'" /><span class="receipt-tag">🧾</span></div>'
        : '';
      html += '<div class="exp-item">' +
        '<div class="exp-item-time">' + (e.time || '--:--') + '</div>' +
        '<div class="exp-item-main">' +
          '<div class="exp-item-place"><span class="exp-cat-icon">' + icon + '</span> ' + (e.description || e.category) + ' ' + linkedBadge + '</div>' +
          '<div class="exp-item-meta">' +
            '<span class="cost-badge">' + fmtMoney(e.amount, e.currency) + '</span>' +
            '<span class="creator-badge">' + (e.payer || '\u672A\u77E5') + ' \u4ED8</span>' +
            splitInfo +
            editBtn +
          '</div>' +
        '</div>' +
        receiptThumb +
      '</div>';
    });
    html += '</div>';
  });
  html += '</div>';

  box.innerHTML = html;
}

function renderNav() {
  const allItems = state.room.items.filter(i => i.status === 'kept' || i.status === 'proposed');
  const days = [...new Set(allItems.map(i => i.date))].sort();
  if (!days.length) { $('#navDayBar').innerHTML = ''; $('#navResult').innerHTML = '<div class="empty">暂无行程</div>'; return; }

  if (!state.navDay || !days.includes(state.navDay)) state.navDay = days[0];
  $('#navDayBar').innerHTML = days.map(d =>
    '<button class="' + (d === state.navDay ? 'active' : '') + '" onclick="selectNavDay(\'' + d + '\')">' + d + '</button>'
  ).join('');

  let list = allItems.filter(i => i.date === state.navDay)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (state.navOptimized) list = state.navOptimized;

  const geoItems = list.filter(i => i.lat && i.lng);
  const noGeoCount = list.length - geoItems.length;

  const dayName = state.navOptimized ? '（智能排序预览）' : '';
  let html = '<div class="route-card"><h4>🗺️ ' + state.navDay + ' 导航路线' + dayName + '</h4>';

  // 一键出发按钮 — 高德路径点导航
  if (geoItems.length >= 2) {
    const first = geoItems[0], last = geoItems[geoItems.length - 1];
    html += '<button class="nav-go-btn" onclick="oneClickNav(\'' + state.navDay + '\')">🚀 一键出发 · 高德地图</button>';
  }
  let totalKm = 0, totalMin = 0;
  let lastGeo = null;

  list.forEach((it, idx) => {
    const hasCoords = it.lat && it.lng;

    // 只在两个有坐标的点之间画路线段
    if (hasCoords && lastGeo) {
      const d = haversine(lastGeo, it);
      const t = segTime(d);
      totalKm += d; totalMin += t;
      html += '<div class="seg"><span>↓ ' + d.toFixed(1) + ' km · 约 ' + Math.round(t) + ' 分钟</span><span class="line"></span></div>';
    } else if (!hasCoords && lastGeo) {
      // 中间插入了一个无坐标的点，显示断点提示
      html += '<div class="seg no-coords-seg"><span>⚠️ 坐标缺失，路线中断</span><span class="line dashed"></span></div>';
    }
    if (hasCoords) lastGeo = it;

    html += '<div class="item-row' + (hasCoords ? '' : ' no-coords') + '">' +
      '<div class="item-top">' +
        '<div class="item-time">' + (it.time || '--:--') + '</div>' +
        '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + '</div>' +
        '<div class="item-meta">' + formatNote(it.note) + '<span class="creator-badge" style="margin-left:4px">' + it.creator + '</span></div>';
    if (hasCoords) {
      html += '<a class="nav-link" href="' + amapNav(it.lat, it.lng, it.place) + '" target="_blank">🚗 高德导航</a>';
    } else {
      html += '<span class="nav-no-coords">⚠️ 无坐标，请编辑补充地点信息</span>';
    }
    html += '</div></div>';
  });

  if (geoItems.length > 1) {
    html += '<div class="summary">全程约 <b>' + totalKm.toFixed(1) + ' km</b> · 预计行驶/移动 <b>' +
      Math.round(totalMin) + ' 分钟</b>（不含游玩停留）。跨城段已按较高车速估算，实际以地图为准。</div>';
  } else if (geoItems.length === 1) {
    html += '<div class="summary">当天仅 1 个带坐标的点，无法生成路段路线。</div>';
  } else {
    html += '<div class="summary">⚠️ 当天所有行程都没有坐标信息，无法生成路线。请编辑行程补充地点。</div>';
  }

  // 无坐标行程提示
  if (noGeoCount > 0) {
    html += '<div class="nav-no-coords-warn">⚠️ ' + noGeoCount + ' 条行程缺少坐标，已跳过路线计算。请在行程页编辑补充地点。</div>';
  }

  html += '</div>';
  $('#navResult').innerHTML = html;

  // ==== Canvas 路线地图 ====
  drawNavMap(list, totalKm);
}

// 一键出发 — 高德地图多点途经导航
function oneClickNav(day) {
  const items = state.room.items.filter(i =>
    i.date === day && (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng
  ).sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  if (items.length < 2) { showToast('需要至少2个有坐标的地点', 'error'); return; }

  // 第一站为起点，最后一站为终点
  const first = items[0], last = items[items.length - 1];
  let url = 'https://uri.amap.com/navigation?';
  url += 'from=' + first.lng + ',' + first.lat + ',' + encodeURIComponent(first.place);
  url += '&to=' + last.lng + ',' + last.lat + ',' + encodeURIComponent(last.place);
  // 途经点（最多支持1个高德途经点，传中间第一站）
  if (items.length > 3) {
    const mid = items[Math.floor(items.length / 2)];
    url += '&via=' + mid.lng + ',' + mid.lat + ',' + encodeURIComponent(mid.place);
  }
  url += '&mode=car&coordinate=gaode&callnative=1';

  // 复制途经清单到剪贴板（供高德内手动添加）
  const stops = items.map((it, i) => (i + 1) + '. ' + it.time + ' ' + it.place).join('\n');
  try {
    navigator.clipboard.writeText(stops).then(() => {});
  } catch(e) { /* ignore */ }

  showToast('已打开高德地图 🚀\n途经点清单已复制，可在高德内添加', 'info');
  window.open(url, '_blank');
}

function drawNavMap(list, totalKm) {
  const canvas = $('#navMap');
  if (!canvas) return;
  const validPts = list.filter(p => p.lat && p.lng);
  if (validPts.length < 2) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';

  const container = canvas.parentElement;
  const W = Math.min(container.clientWidth - 24, 600);
  const H = Math.round(W * 200 / 360); /* 比例高度，适配不同屏幕宽度 */
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const lats = validPts.map(p => p.lat);
  const lngs = validPts.map(p => p.lng);
  // 用户 GPS 位置也纳入画布范围
  if (state.myLocation) { lats.push(state.myLocation.lat); lngs.push(state.myLocation.lng); }
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

  // 用户 GPS 位置（蓝色圆点 + 脉冲）
  if (state.myLocation) {
    const mx = toX(state.myLocation.lng), my = toY(state.myLocation.lat);
    // 脉冲圈
    ctx.fillStyle = 'rgba(59,130,246,0.12)';
    ctx.beginPath(); ctx.arc(mx, my, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(59,130,246,0.20)';
    ctx.beginPath(); ctx.arc(mx, my, 12, 0, Math.PI * 2); ctx.fill();
    // 蓝色圆点
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2); ctx.stroke();
    // 标签
    ctx.fillStyle = '#1d4ed8'; ctx.font = 'bold 10px -apple-system, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('📍 我的位置', mx + 12, my + 4);
  }

  // 图例
  ctx.fillStyle = '#94a3b8'; ctx.font = '10px -apple-system, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('路线总距 ' + totalKm.toFixed(1) + ' km  |  🟠 景点/餐饮  🟣 住宿  🔵 我的位置', pad, 14);
}

function selectNavDay(d) { state.navDay = d; state.navOptimized = null; renderNav(); }

function optimizeRoute() {
  const items = state.room.items.filter(i => i.date === state.navDay && (i.status === 'kept' || i.status === 'proposed') && i.lat && i.lng);
  if (!state.myLocation && items.length < 3) {
    promptInput({ title: '无需优化', icon: '💡', hint: '当天点数太少，无需优化。\n\n提示：先点击「获取我的位置」可以从你当前位置出发规划。', confirmOnly: true });
    return;
  }

  // 分离酒店（住宿）和其他点
  const hotels = items.filter(i => i.type === '住宿');
  const others = items.filter(i => i.type !== '住宿');

  // 用户 GPS 位置 → 作为起点
  let start = null;
  if (state.myLocation) {
    start = { ...state.myLocation, _isMyLoc: true, type: 'mypos' };
  }

  let ordered;
  if (hotels.length > 0 && others.length >= 2) {
    // 酒店锚点模式：从用户位置（或酒店）出发 → 最近邻遍历 → 回到酒店
    const firstHotel = hotels[0];
    // 如果用户位置离酒店很远，从用户位置出发去酒店，再遍历景点
    if (start) {
      const toHotel = haversine(start, firstHotel);
      const toFirstOther = others.length ? haversine(start, others.reduce((a, b) => haversine(start, a) < haversine(start, b) ? a : b)) : Infinity;
      if (toFirstOther < toHotel) {
        // 用户离第一个景点比离酒店更近 → 从用户出发先玩
        ordered = [start];
        const rest = [...others];
        while (rest.length) {
          const last = ordered[ordered.length - 1];
          let bi = 0, bd = Infinity;
          rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
          ordered.push(rest.splice(bi, 1)[0]);
        }
        // 最后回酒店
        ordered.push(firstHotel);
      } else {
        ordered = [start, firstHotel];
        const rest = [...others];
        while (rest.length) {
          const last = ordered[ordered.length - 1];
          let bi = 0, bd = Infinity;
          rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
          ordered.push(rest.splice(bi, 1)[0]);
        }
      }
    } else {
      // 无 GPS：原逻辑
      ordered = [firstHotel];
      const rest = [...others];
      while (rest.length) {
        const last = ordered[ordered.length - 1];
        let bi = 0, bd = Infinity;
        rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
        ordered.push(rest.splice(bi, 1)[0]);
      }
    }
    if (hotels.length > 1) ordered.push(hotels[1]);
  } else {
    // 无酒店：标准最近邻（从 GPS 或第一个点开始）
    const rest = items.slice();
    ordered = start ? [start, ...rest] : [rest.shift()];
    if (!start) {
      while (rest.length) {
        const last = ordered[ordered.length - 1];
        let bi = 0, bd = Infinity;
        rest.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
        ordered.push(rest.splice(bi, 1)[0]);
      }
    } else {
      // 从 GPS 出发，去掉第一个实际点（已加入），对剩下的做最近邻
      const remaining = [...rest.slice(1)]; // 去掉第一个（已被最近邻选中）
      // 先做一次最近邻从 GPS 出发
      const allPoints = rest.slice();
      ordered = [start];
      while (allPoints.length) {
        const last = ordered[ordered.length - 1];
        let bi = 0, bd = Infinity;
        allPoints.forEach((c, i) => { const d = haversine(last, c); if (d < bd) { bd = d; bi = i; } });
        ordered.push(allPoints.splice(bi, 1)[0]);
      }
    }
  }
  state.navOptimized = ordered;
  renderNav();
}

function renderReview() {
  const items = state.room.items;
  const days = [...new Set(items.map(i => i.date))].sort();
  if (!items.length) {
    $('#reviewList').innerHTML = '<div class="empty">暂无行程可审阅</div>';
    $('#reviewBatchBar').style.display = 'none';
    return;
  }

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

  // 非管理员只读提示
  if (state.userRole !== 'admin') {
    html += '<div class="review-readonly-banner">👀 只读模式 — 你只能查看审阅状态，不能执行保留/合并/删除操作</div>';
  }

  // 批量操作栏
  const isAdmin = state.userRole === 'admin';
  const batchBar = $('#reviewBatchBar');
  if (batchBar) batchBar.style.display = isAdmin ? '' : 'none';

  days.forEach(day => {
    const list = items.filter(i => i.date === day).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!list.length) return;
    html += '<div class="day-group"><div class="day-head">📅 ' + day + ' · 共 ' + list.length + ' 条</div>';
    list.forEach(it => {
      const conflict = conflictIds.has(it.id) ? ' conflict' : '';
      const isChecked = state.reviewSelected.has(it.id) ? ' checked' : '';
      html += '<div class="item-row' + conflict + '">' +
        (isAdmin ? '<label class="review-check-wrap"><input type="checkbox" class="review-check" data-id="' + it.id + '"' + (isChecked ? ' checked' : '') + ' onchange="toggleReviewCheck(this)"></label>' : '') +
        '<div class="item-top">' +
          '<div class="item-time">' + (it.time || '--:--') + '</div>' +
          '<div class="item-main"><div class="item-place">' + it.place + ' ' + tagHtml(it.type) + ' ' + statusPill(it.status) + '</div>' +
          '<div class="item-meta">' +
            (it.note ? '<span class="item-note">' + formatNote(it.note) + '</span>' : '') +
            '<span class="creator-badge">' + it.creator + '</span>' +
          '</div>' +
        '</div></div>' +
        '<div class="review-actions' + (isAdmin ? '' : ' readonly') + '">' +
          (isAdmin
            ? '<button class="b-keep" onclick="setStatus(\'' + it.id + '\',\'kept\')">保留</button>' +
              '<button class="b-merge" onclick="mergeItem(\'' + it.id + '\')">合并</button>' +
              '<button class="b-drop" onclick="deleteItem(\'' + it.id + '\')">删除</button>'
            : '<span class="review-status-label">' + (it.status === 'kept' ? '✅ 已保留' : it.status === 'proposed' ? '⏳ 待审阅' : it.status === 'merged' ? '🔄 已合并' : '🗑️ 已删除') + '</span>') +
        '</div></div>';
    });
    html += '</div>';
  });
  $('#reviewList').innerHTML = html;
  updateReviewBatchCount();
}

// ---------------- 审阅批量操作 ----------------
function toggleReviewCheck(cb) {
  const id = cb.dataset.id;
  if (cb.checked) state.reviewSelected.add(id);
  else state.reviewSelected.delete(id);
  updateReviewBatchCount();
}

function toggleSelectAllReview() {
  const isChecked = $('#reviewSelectAll').checked;
  const cbs = $$('.review-check');
  if (isChecked) {
    cbs.forEach(cb => { cb.checked = true; state.reviewSelected.add(cb.dataset.id); });
  } else {
    cbs.forEach(cb => { cb.checked = false; });
    state.reviewSelected.clear();
  }
  updateReviewBatchCount();
}

function updateReviewBatchCount() {
  const count = state.reviewSelected.size;
  $('#reviewBatchCount').textContent = '已选 ' + count + ' 条';
}

async function batchSetStatus(status) {
  const ids = [...state.reviewSelected];
  if (!ids.length) { showToast('未选中任何条目', 'info'); return; }
  const label = status === 'kept' ? '保留' : '删除';
  showInputModal({
    title: '批量' + label,
    icon: status === 'kept' ? '✅' : '🗑️',
    hint: '确认批量' + label + ' ' + ids.length + ' 条行程？',
    confirmOnly: true
  }, async (ok) => {
    if (!ok) return;
    let success = 0, fail = 0;
    for (const id of ids) {
      try {
        if (status === 'dropped') {
          await fetch('/api/rooms/' + state.roomId + '/items/' + id, { method: 'DELETE' });
        } else {
          await fetch('/api/rooms/' + state.roomId + '/items/' + id, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
          });
        }
        success++;
      } catch (e) { fail++; }
    }
    state.reviewSelected.clear();
    await refresh();
    showToast('批量' + label + '完成：' + success + ' 成功' + (fail > 0 ? ', ' + fail + ' 失败' : ''), fail > 0 ? 'error' : 'success');
  });
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
    // 走服务器代理（Node 原生 HTTPS），避免浏览器 CORS / 代理拦截
    const resp = await fetch('/api/geocode?q=' + encodeURIComponent(query));
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data.slice(0, 5).map(d => ({
      name: (d.display_name || '').split(',')[0],
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
  // 自动设置类型：POI 返回的类型匹配 type-pill 的 value
  if (p.type) {
    const radio = f.querySelector('input[name="type"][value="' + p.type + '"]');
    if (radio) radio.checked = true;
  }
}

// 根据地点名称智能判断类型（POI 没有返回类型时使用）
function guessType(name) {
  const n = (name || '').toLowerCase();
  // 餐饮：品牌名 + 菜系 + 通用词
  if (/酒店|宾馆|民宿|旅馆|青旅|度假村|客栈|公寓|airbnb/.test(n)) return '住宿';
  if (/海底捞|西贝|太二|探鱼|九毛九|外婆家|绿茶|新白鹿|巴奴|呷哺|湊湊|鼎泰丰|全聚德|大董|小南国|桂满陇|点都德|陶陶居|广州酒家|蔡澜|避风塘|翠华|大家乐|大快活|麦当劳|肯德基|必胜客|星巴克|喜茶|奈雪|瑞幸|蜜雪冰城|茶颜悦色|一点点|coco/.test(n)) return '餐饮';
  if (/餐厅|饭店|酒楼|茶餐厅|小吃|面馆|火锅|烧烤|大排档|美食|早茶|咖啡|甜品|奶茶|自助|食堂|饭馆|餐馆|酒家|菜馆|食府|捞面|米线|米粉|煲仔|烧腊|叉烧|肠粉|虾饺|烧卖|凤爪|乳鸽|烧鹅|白切|点心/.test(n)) return '餐饮';
  if (/机场|火车站|高铁|地铁|码头|口岸|汽车站|公交/.test(n)) return '交通';
  if (/商场|购物|步行街|市场|超市|百货|奥特莱斯|免税|广场.*购/.test(n)) return '购物';
  return null;
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
  state.poiSelectedIndex = -1;  // 重置键盘导航位置

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
      state.poiSelectedIndex = -1;  // 重置键盘导航位置
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
      // 在线结果没有类型信息，智能猜测
      const guessed = guessType(p.name);
      if (guessed) {
        const radio = document.querySelector('input[name="type"][value="' + guessed + '"]');
        if (radio) radio.checked = true;
      }
      box.style.display = 'none';
      return;
    }
  }

  // 本地 POI 结果
  const p = box._matches && box._matches[i];
  if (!p) { box.style.display = 'none'; return; }
  inp.value = p.name;
  fillCoords(p);
  // POI 类型是"其他"或无类型时，智能猜测
  if (!p.type || p.type === '其他') {
    const guessed = guessType(p.name);
    if (guessed) {
      const radio = document.querySelector('input[name="type"][value="' + guessed + '"]');
      if (radio) radio.checked = true;
    }
  }
  box.style.display = 'none';
}

function hidePoi() { const box = $('#poiSuggestions'); if (box) box.style.display = 'none'; state.poiSelectedIndex = -1; }

// POI 键盘导航: ↑↓ 选择, Enter 确认, Esc 关闭
function onPlaceKeydown(e) {
  const box = $('#poiSuggestions');
  if (!box || box.style.display === 'none') return;
  const items = box.querySelectorAll('li[data-i]');
  if (!items.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    state.poiSelectedIndex += (e.key === 'ArrowDown' ? 1 : -1);
    if (state.poiSelectedIndex >= items.length) state.poiSelectedIndex = 0;
    if (state.poiSelectedIndex < 0) state.poiSelectedIndex = items.length - 1;
    highlightPoiItem(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.poiSelectedIndex >= 0 && items[state.poiSelectedIndex]) {
      const i = parseInt(items[state.poiSelectedIndex].dataset.i, 10);
      selectPoi(i);
    }
  } else if (e.key === 'Escape') {
    hidePoi();
  }
}

function highlightPoiItem(items) {
  items.forEach((li, j) => {
    li.classList.toggle('poi-selected', j === state.poiSelectedIndex);
  });
  // 滚动跟随
  const sel = items[state.poiSelectedIndex];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ---------------- 管理员后台 ----------------

async function openAdminPanel() {
  if (state.userRole !== 'admin') {
    showLogin();
    return;
  }
  const panel = $('#adminPanel');
  panel.classList.remove('hidden');
  // 默认显示房间管理
  switchAdminTab('rooms');
  await refreshAdminRooms();
  await refreshAdminUsers();
}

function closeAdminPanel() {
  $('#adminPanel').classList.add('hidden');
}

function switchAdminTab(tab) {
  $$('.admin-tab').forEach(t => t.classList[t.dataset.tab === tab ? 'add' : 'remove']('active'));
  $$('.admin-tab-content').forEach(p => p.classList[p.id === ('admin' + tab[0].toUpperCase() + tab.slice(1)) ? 'add' : 'remove']('active'));
  if (tab === 'audit') refreshAuditLog(1);
}

// ===== 房间管理 =====
async function refreshAdminRooms() {
  try {
    const resp = await fetch('/api/rooms');
    const data = await resp.json();
    $('#adminRoomCount').textContent = '共 ' + data.total + ' 个房间';
    let html = '';
    if (data.rooms.length === 0) {
      html = '<div class="empty">暂无房间</div>';
    } else {
      data.rooms.forEach(r => {
        html += '<div class="admin-row">' +
          '<div class="admin-row-info">' +
            '<div class="admin-row-name">' + r.name + ' <code>#' + r.id + '</code></div>' +
            '<div class="admin-row-sub">📍 ' + r.itemCount + ' 条行程 · ' + new Date(r.createdAt).toLocaleDateString('zh-CN') + '</div>' +
          '</div>' +
          '<div class="admin-row-actions">' +
            '<button class="btn-sm btn-outline" onclick="adminVisitRoom(\'' + r.id + '\')">进入</button>' +
            '<button class="btn-sm btn-outline" onclick="adminEditRoom(\'' + r.id + '\',\'' + r.name.replace(/'/g, "\\'") + '\')">改名</button>' +
            '<button class="btn-sm btn-danger-outline" onclick="adminDeleteRoom(\'' + r.id + '\',\'' + r.name.replace(/'/g, "\\'") + '\')">删除</button>' +
          '</div>' +
        '</div>';
      });
    }
    $('#adminRoomList').innerHTML = html;
  } catch (e) {
    $('#adminRoomCount').textContent = '加载失败';
  }
}

function adminVisitRoom(id) {
  closeAdminPanel();
  location.hash = id;
  ensureRoom();
}

function adminCreateRoom() {
  showInputModal({
    title: '新建房间',
    icon: '🏠',
    hint: '请输入房间号和房间名称',
    placeholder: '房间号（4位数字）',
    placeholder2: '房间名称',
    twoFields: true
  }, async (roomId, roomName) => {
    if (!/^\d{4}$/.test(roomId)) {
      promptInput({ title: '格式错误', icon: '⚠️', hint: '房间号必须是 4 位数字（如 1234、2026）。', confirmOnly: true });
      return;
    }
    try {
      await createRoomById(roomId, roomName || '我的旅行');
      closeAdminPanel();
      location.hash = roomId;
      await ensureRoom();
      refreshAdminRooms();
      fetchRoomCount();
    } catch (err) {
      promptInput({ title: '创建失败', icon: '❌', hint: err.message, confirmOnly: true });
    }
  });
}

async function adminEditRoom(id, currentName) {
  const name = await promptInput({
    title: '修改房间名称',
    icon: '✏️',
    hint: '当前名称：' + currentName,
    placeholder: '输入新名称',
    value: currentName
  });
  if (!name || name === currentName) return;
  try {
    const resp = await fetch('/api/rooms/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!resp.ok) {
      const e = await resp.json();
      promptInput({ title: '修改失败', icon: '❌', hint: e.error || '状态码 ' + resp.status, confirmOnly: true });
      return;
    }
    await refreshAdminRooms();
    showToast('房间名称已更新 ✅', 'success');
    // 如果当前在这个房间，刷新
    if (state.roomId === id) {
      state.room = await fetch('/api/rooms/' + id).then(r => r.json());
      render();
    }
  } catch (err) {
    promptInput({ title: '网络错误', icon: '❌', hint: err.message, confirmOnly: true });
  }
}

async function adminDeleteRoom(id, name) {
  const ok = await promptInput({
    title: '删除确认',
    icon: '🗑️',
    hint: '确定删除房间「' + name + '」？\n\n⚠️ 所有行程数据将被永久删除，不可恢复！',
    confirmOnly: true
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rooms/' + id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
    });
    if (!resp.ok) {
      const e = await resp.json();
      promptInput({ title: '删除失败', icon: '❌', hint: e.error || '状态码 ' + resp.status, confirmOnly: true });
      return;
    }
    await refreshAdminRooms();
    await fetchRoomCount();
    showToast('房间「' + name + '」已删除', 'info');
    // 如果当前在这个房间，跳回默认房间
    if (state.roomId === id) {
      location.hash = '2026';
      await ensureRoom();
    }
  } catch (err) {
    promptInput({ title: '网络错误', icon: '❌', hint: err.message, confirmOnly: true });
  }
}

// ===== 用户管理 =====
async function refreshAdminUsers() {
  try {
    const resp = await fetch('/api/admin/users', { headers: getAuthHeaders() });
    const data = await resp.json();
    const users = data.users || [];
    $('#adminUserCount').textContent = '共 ' + users.length + ' 个用户';
    let html = '';
    if (users.length === 0) {
      html = '<div class="empty">暂无用户</div>';
    } else {
      users.forEach(u => {
        const isSelf = u.name === state.userName;
        const roleBadge = u.role === 'admin' ? '<span class="tag admin">管理员</span>' : '<span class="tag user">普通用户</span>';
        html += '<div class="admin-row">' +
          '<div class="admin-row-info">' +
            '<div class="admin-row-name">' + u.name + ' ' + roleBadge + (isSelf ? ' <span class="tag self">当前</span>' : '') + '</div>' +
          '</div>' +
          '<div class="admin-row-actions">' +
            (u.name !== '景杰克' ? '<button class="btn-sm btn-edit-outline" onclick="showEditUser(\'' + u.name + '\')">编辑</button>' + '<button class="btn-sm btn-danger-outline" onclick="adminDeleteUser(\'' + u.name + '\')">删除</button>' : '<span class="admin-hint">内置账号</span>') +
          '</div>' +
        '</div>';
      });
    }
    $('#adminUserList').innerHTML = html;
  } catch (e) {
    $('#adminUserCount').textContent = '加载失败';
  }
}

function showAddUser() {
  $('#addUserForm').classList.remove('hidden');
  $('#newUserName').focus();
}

function hideAddUser() {
  $('#addUserForm').classList.add('hidden');
  $('#newUserName').value = '';
  $('#newUserPass').value = '';
  $('#addUserErr').classList.add('hidden');
}

async function doAddUser() {
  const name = $('#newUserName').value.trim();
  const pass = $('#newUserPass').value;
  const role = $('#newUserRole').value;
  const errDiv = $('#addUserErr');

  if (!name) { $('#newUserName').focus(); return; }
  if (!pass) { $('#newUserPass').focus(); return; }

  errDiv.classList.add('hidden');
  try {
    const resp = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ name, password: pass, role })
    });
    const data = await resp.json();
    if (!resp.ok) {
      errDiv.textContent = data.error || '添加失败';
      errDiv.classList.remove('hidden');
      return;
    }
    hideAddUser();
    await refreshAdminUsers();
    showToast('用户已添加 ✅', 'success');
  } catch (e) {
    errDiv.textContent = '网络错误：' + e.message;
    errDiv.classList.remove('hidden');
  }
}

async function adminDeleteUser(name) {
  const ok = await promptInput({
    title: '删除用户',
    icon: '🗑️',
    hint: '确定删除用户「' + name + '」？',
    confirmOnly: true
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/admin/users/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
    });
    if (!resp.ok) {
      const e = await resp.json();
      promptInput({ title: '删除失败', icon: '❌', hint: e.error || '状态码 ' + resp.status, confirmOnly: true });
      return;
    }
    await refreshAdminUsers();
    showToast('用户「' + name + '」已删除', 'info');
  } catch (e) {
    promptInput({ title: '网络错误', icon: '❌', hint: e.message, confirmOnly: true });
  }
}

function showEditUser(name) {
  hideAddUser();
  $('#editUserNameOld').value = name;
  $('#editUserName').value = '';
  $('#editUserPass').value = '';
  $('#editUserErr').classList.add('hidden');
  $('#editUserForm').classList.remove('hidden');
  $('#editUserName').focus();
}

function hideEditUser() {
  $('#editUserForm').classList.add('hidden');
  $('#editUserName').value = '';
  $('#editUserPass').value = '';
  $('#editUserErr').classList.add('hidden');
}

async function doEditUser() {
  const oldName = $('#editUserNameOld').value;
  const newName = $('#editUserName').value.trim();
  const pass = $('#editUserPass').value;
  const errDiv = $('#editUserErr');

  if (!newName && !pass) { errDiv.textContent = '用户名和密码至少填写一项'; errDiv.classList.remove('hidden'); return; }

  errDiv.classList.add('hidden');
  try {
    const body = {};
    if (newName) body.name = newName;
    if (pass) body.password = pass;
    const resp = await fetch('/api/admin/users/' + encodeURIComponent(oldName), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) {
      errDiv.textContent = data.error || '修改失败';
      errDiv.classList.remove('hidden');
      return;
    }
    hideEditUser();
    await refreshAdminUsers();
    showToast('用户已更新 ✅', 'success');
  } catch (e) {
    errDiv.textContent = '网络错误：' + e.message;
    errDiv.classList.remove('hidden');
  }
}

// ---------------- 多人协作自动刷新 + 在线心跳 ----------------
setInterval(async () => {
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
  if (!state.roomId || !state.room) return;
  try { await refresh(); } catch (e) { /* 离线/只读时静默 */ }
}, 30000);

// 切回页面时立即刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.roomId && state.room) {
    refresh().catch(() => {});
  }
});

// 每 30 秒发送心跳，让服务端知道在线
async function sendHeartbeat() {
  if (!state.roomId || !state.isLoggedIn) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.authToken) headers['Authorization'] = 'Bearer ' + state.authToken;
    const resp = await fetch('/api/rooms/' + state.roomId + '/heartbeat', { method: 'POST', headers });
    if (resp.ok) {
      const data = await resp.json();
      const elOnline = $('#riOnline');
      if (elOnline) elOnline.textContent = (data.online || []).length + '人';
    }
  } catch (e) { /* 离线静默 */ }
}
setInterval(sendHeartbeat, 30000);
sendHeartbeat(); // 立即发一次

// 定期更新同步时间显示
setInterval(() => {
  const sync = $('#riSync');
  if (!sync || !state.lastSync) return;
  const sec = Math.floor((Date.now() - state.lastSync) / 1000);
  if (sec < 60) sync.textContent = '🔄 ' + sec + '秒前同步';
  else sync.textContent = '🔄 ' + Math.floor(sec/60) + '分钟前同步';
}, 10000);

// 启动
loadAuth();
initNickname();
// 显示前端版本号（顶栏小字，便于一眼确认是否运行最新代码）
(function(){ var el = $('#appVer'); if (el) el.textContent = 'v' + APP_VERSION; })();
// 设置行程日期默认为今天
(function(){ var d = $('#itemDateInput'); if (d) d.value = new Date().toISOString().slice(0, 10); })();
ensureRoom();
window.addEventListener('hashchange', ensureRoom);
loadPois();
setupDragDrop();
initReminders();
updateLangButton();

// 显式绑定按钮事件（避免 inline onclick 被移动端拦截）
(function bindButtons() {
  const badge = $('#userBadge');
  if (badge) badge.addEventListener('click', showLogin);

  const joinBtn = $('#btnJoinRoom');
  if (joinBtn) joinBtn.addEventListener('click', joinRoom);

  // 房间计数徽章
  const countBadge = $('#roomCountBadge');
  if (countBadge) countBadge.addEventListener('click', openAdminPanel);
})();
(function bindPoi() {
  const inp = $('#placeInput');
  const box = $('#poiSuggestions');
  if (!inp || !box) return;
  inp.addEventListener('input', onPlaceInput);
  inp.addEventListener('focus', onPlaceInput);
  inp.addEventListener('keydown', onPlaceKeydown);
  box.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); selectPoi(+li.dataset.i); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.input-wrap')) hidePoi(); });
})();
// 行程搜索输入绑定
(function bindPlanSearch() {
  const inp = $('#planSearchInput');
  if (!inp) return;
  inp.addEventListener('input', function() {
    state.planSearch = this.value;
    $('#planSearchClear').style.display = this.value ? '' : 'none';
    renderPlan();
  });
})();
// ---------------- 日志审计 ----------------
const AUDIT_ACTION_LABELS = {
  'auth.login': '🔑 登录成功',
  'auth.login_fail': '❌ 登录失败',
  'room.create': '🏠 创建房间',
  'room.rename': '✏️ 重命名房间',
  'room.delete': '🗑️ 删除房间',
  'room.travelers': '👥 编辑同行人',
  'item.add': '📝 添加行程',
  'item.update': '✏️ 编辑行程',
  'item.delete': '🗑️ 删除行程',
  'item.merge': '🔄 合并行程',
  'expense.add': '💰 添加费用',
  'expense.update': '✏️ 编辑费用',
  'expense.delete': '🗑️ 删除费用',
  'user.create': '👤 创建用户',
  'user.delete': '🗑️ 删除用户'
};

let auditState = { page: 1, totalPages: 1, filters: {} };

async function refreshAuditLog(page) {
  if (page) auditState.page = page;

  const user = $('#auditFilterUser')?.value || '';
  const action = $('#auditFilterAction')?.value || '';
  const room = $('#auditFilterRoom')?.value || '';
  const dateFrom = $('#auditFilterDateFrom')?.value || '';
  const dateTo = $('#auditFilterDateTo')?.value || '';

  const params = new URLSearchParams();
  if (user) params.set('user', user);
  if (action) params.set('action', action);
  if (room) params.set('room', room);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  params.set('page', auditState.page);
  params.set('size', '50');

  try {
    const resp = await fetch('/api/admin/audit?' + params.toString(), { headers: getAuthHeaders() });
    if (!resp.ok) {
      $('#auditLogList').innerHTML = '<div class="empty">加载失败：' + resp.status + '</div>';
      return;
    }
    const data = await resp.json();
    auditState.totalPages = data.totalPages;
    auditState.filters = data.filters || {};

    // 填充筛选下拉（保持用户选中的值）
    populateFilterSelect('auditFilterUser', auditState.filters.users || [], user);
    populateFilterSelect('auditFilterAction', auditState.filters.actions || [], action);
    populateFilterSelect('auditFilterRoom', auditState.filters.rooms || [], room);

    $('#auditCount').textContent = '共 ' + data.total + ' 条记录';

    // 渲染列表
    let html = '';
    if (data.entries.length === 0) {
      html = '<div class="empty">暂无日志记录</div>';
    } else {
      data.entries.forEach(e => {
        const time = new Date(e.ts).toLocaleString('zh-CN', { hour12: false });
        const actionLabel = AUDIT_ACTION_LABELS[e.action] || e.action;
        const detailHtml = formatAuditDetail(e);
        const statusIcon = e.ok ? '✅' : '❌';
        html += '<div class="audit-entry">' +
          '<div class="audit-entry-time">' + time + '</div>' +
          '<div class="audit-entry-body">' +
            '<div class="audit-entry-action">' + statusIcon + ' ' + actionLabel + '</div>' +
            '<div class="audit-entry-meta">' +
              '<span class="audit-entry-user">👤 ' + escHtml(e.user) + '</span>' +
              (e.room ? '<span class="audit-entry-room">🏠 #' + escHtml(e.room) + '</span>' : '') +
              (e.ip ? '<span class="audit-entry-ip">🌐 ' + escHtml(e.ip) + '</span>' : '') +
            '</div>' +
            (detailHtml ? '<div class="audit-entry-detail">' + detailHtml + '</div>' : '') +
          '</div>' +
        '</div>';
      });
    }
    $('#auditLogList').innerHTML = html;

    // 分页
    renderAuditPagination();

  } catch (e) {
    $('#auditLogList').innerHTML = '<div class="empty">网络错误：' + e.message + '</div>';
  }
}

function formatAuditDetail(e) {
  const d = e.detail || {};
  let parts = [];
  if (d.place) parts.push('📍 ' + escHtml(d.place));
  if (d.date && d.date !== 'null') parts.push('📅 ' + d.date);
  if (d.type) parts.push('🏷️ ' + d.type);
  if (d.category) parts.push('📂 ' + d.category);
  if (d.amount != null) parts.push('💵 ' + (d.currency || '¥') + Number(d.amount).toFixed(2));
  if (d.source && d.target) parts.push('🔄 ' + escHtml(d.source) + ' → ' + escHtml(d.target));
  if (d.name) parts.push('📛 ' + escHtml(d.name));
  if (d.newName) parts.push('✏️ → ' + escHtml(d.newName));
  if (d.targetUser) parts.push('👤 ' + escHtml(d.targetUser));
  if (d.reason) parts.push('💬 ' + d.reason);
  if (d.travelers != null) parts.push('👥 ' + d.travelers + '人');
  if (d.itemCount != null) parts.push('📋 ' + d.itemCount + '条行程');
  if (d.role) parts.push('🔰 ' + d.role);
  if (d.status) parts.push('📌 ' + d.status);
  if (d.desc) parts.push('📝 ' + escHtml(String(d.desc).slice(0, 30)));
  return parts.join(' · ');
}

function populateFilterSelect(id, options, currentValue) {
  const sel = $('#' + id);
  if (!sel) return;
  const selValue = sel.value;
  sel.innerHTML = '<option value="">' + (id === 'auditFilterUser' ? '👤 全部用户' : id === 'auditFilterAction' ? '📌 全部操作' : '🏠 全部房间') + '</option>';
  options.forEach(opt => {
    const label = id === 'auditFilterAction' ? (AUDIT_ACTION_LABELS[opt] || opt) : opt;
    sel.innerHTML += '<option value="' + opt + '"' + (opt === selValue ? ' selected' : '') + '>' + label + '</option>';
  });
}

function renderAuditPagination() {
  const box = $('#auditPagination');
  if (!box) return;
  const p = auditState.page, total = auditState.totalPages;
  if (total <= 1) { box.innerHTML = ''; return; }

  let html = '<span class="audit-page-info">' + p + ' / ' + total + ' 页</span>';
  if (p > 1) html += '<button class="btn-sm btn-outline" onclick="refreshAuditLog(' + (p - 1) + ')">上一页</button>';
  if (p < total) html += '<button class="btn-sm btn-outline" onclick="refreshAuditLog(' + (p + 1) + ')">下一页</button>';
  box.innerHTML = html;
}

async function exportAuditCSV() {
  const user = $('#auditFilterUser')?.value || '';
  const action = $('#auditFilterAction')?.value || '';
  const room = $('#auditFilterRoom')?.value || '';
  const dateFrom = $('#auditFilterDateFrom')?.value || '';
  const dateTo = $('#auditFilterDateTo')?.value || '';

  const params = new URLSearchParams();
  if (user) params.set('user', user);
  if (action) params.set('action', action);
  if (room) params.set('room', room);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  params.set('size', '10000');

  try {
    const resp = await fetch('/api/admin/audit?' + params.toString(), { headers: getAuthHeaders() });
    if (!resp.ok) {
      promptInput({ title: '导出失败', icon: '❌', hint: '服务器返回 ' + resp.status, confirmOnly: true });
      return;
    }
    const data = await resp.json();
    if (!data.entries || data.entries.length === 0) {
      promptInput({ title: '无数据', icon: '⚠️', hint: '当前筛选条件下没有日志记录', confirmOnly: true });
      return;
    }

    const BOM = '\uFEFF';
    let csv = BOM + '时间,用户,操作,房间,详情,IP,状态\n';
    data.entries.forEach(e => {
      const time = new Date(e.ts).toISOString();
      const actLabel = (AUDIT_ACTION_LABELS[e.action] || e.action).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
      const detail = JSON.stringify(e.detail || {}).replace(/"/g, '""');
      csv += '"' + time + '","' + e.user + '","' + actLabel + '","' + (e.room || '') + '","' + detail + '","' + (e.ip || '') + '","' + (e.ok ? '成功' : '失败') + '"\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '审计日志_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);

  } catch (e) {
    promptInput({ title: '导出失败', icon: '❌', hint: e.message, confirmOnly: true });
  }
}

// 管理员打开后台时填充默认日期范围
const _origOpenAdmin = openAdminPanel;
openAdminPanel = async function() {
  await _origOpenAdmin();
  const today = new Date();
  const thirtyDaysAgo = new Date(today - 30 * 86400000);
  const fromInput = $('#auditFilterDateFrom');
  const toInput = $('#auditFilterDateTo');
  if (fromInput && !fromInput.value) fromInput.value = thirtyDaysAgo.toISOString().slice(0, 10);
  if (toInput && !toInput.value) toInput.value = today.toISOString().slice(0, 10);
};
