/* ==========================================================================
   科技数码日报 — 前端应用（无框架、无构建、纯静态）
   数据全部来自 ./data/index.json、./data/days/*.json、./data/search.json
   安全约定：所有来自 RSS 的文本一律走 textContent / createElement，
   仅「搜索关键词高亮」一处使用 innerHTML，且输入经过 HTML 转义。
   ========================================================================== */

const INDEX_URL = './data/index.json';
const DAY_URL = (date) => `./data/days/${date}.json`;
const SEARCH_URL = './data/search.json';
const SEARCH_RESULT_LIMIT = 240;
const READ_KEY = 'techdaily:read';
const THEME_KEY = 'techdaily:theme';
const COLLAPSED_KEY = 'techdaily:collapsed';

/* ───────────────────────── 全局状态 ───────────────────────── */

const state = {
  index: null,
  categoryById: new Map(),
  dayKeys: [],
  dayKeySet: new Set(),
  requestedDay: null,
  loadedDay: null,
  dayCache: new Map(),
  query: '',
  catOn: new Set(),
  catOff: new Set(),
  srcOn: new Set(),
  srcOff: new Set(),
  searchData: null,
  calCursor: null, // {y, m} m: 0-11
  loadToken: 0,
  markTimer: null,
};

const el = (id) => document.getElementById(id);

const dom = {
  siteTitle: el('site-title'),
  siteSubtitle: el('site-subtitle'),
  search: el('search'),
  searchClear: el('search-clear'),
  theme: el('btn-theme'),
  sidebar: el('sidebar'),
  sidebarBtn: el('btn-sidebar'),
  scrim: el('scrim'),
  dayTitle: el('day-title'),
  dayMeta: el('day-meta'),
  tabLatest: el('tab-latest'),
  tabArchived: el('tab-archived'),
  digest: el('digest'),
  activeFilters: el('active-filters'),
  feed: el('feed'),
  loadMore: el('load-more'),
  footGenerated: el('foot-generated'),
  buildMeta: el('build-meta'),
  health: el('source-health'),
  filterCategories: el('filter-categories'),
  filterSources: el('filter-sources'),
  calGrid: el('cal-grid'),
  calLabel: el('cal-label'),
  calPrev: el('cal-prev'),
  calNext: el('cal-next'),
  btnLatest: el('btn-latest'),
  btnRandom: el('btn-random'),
  btnExport: el('btn-export'),
  toggleAll: el('btn-toggle-all'),
  feedSummary: el('feed-summary'),
  toast: el('toast'),
};

/* ───────────────────────── 小工具 ───────────────────────── */

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(100,116,139,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 8) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function clockLabel(iso, offsetMin) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t + (offsetMin || 0) * 60000);
  return `${d.toISOString().slice(11, 16)}`;
}

function todayKey(offsetMin) {
  return new Date(Date.now() + (offsetMin || 0) * 60000).toISOString().slice(0, 10);
}

let toastTimer = null;
function toast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2400);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function saveReadSet() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...readSet].slice(-800)));
  } catch { /* 隐私模式下忽略 */ }
}
let readSet = new Set();
try {
  readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]'));
} catch {
  readSet = new Set();
}

/* ───────────────────────── 分类折叠状态 ───────────────────────── */

const collapsedCats = new Set();
let collapsedLoaded = false;

function loadCollapsed() {
  if (collapsedLoaded) return;
  collapsedLoaded = true;
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) for (const id of JSON.parse(raw)) collapsedCats.add(id);
  } catch { /* 忽略损坏的数据 */ }
}

function persistCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedCats]));
  } catch { /* 忽略 */ }
}

function setCategoryCollapsed(categoryId, collapsed, { persist = true } = {}) {
  if (collapsed) collapsedCats.add(categoryId);
  else collapsedCats.delete(categoryId);
  if (persist) persistCollapsed();
}

/** 一次性设置多个分类（供「全部收起 / 全部展开」使用），只写一次存储 */
function setManyCollapsed(ids, collapsed) {
  for (const id of ids) setCategoryCollapsed(id, collapsed, { persist: false });
  persistCollapsed();
}

/** 切换后需要整体重绘，因此把「哪些分类在本次渲染中可见」记下来 */
let renderedCategoryIds = [];

/* ───────────────────────── 主题 ───────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  dom.theme.textContent = theme === 'dark' ? '🌙' : '☀️';
  dom.theme.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* 忽略 */ }
}

function initTheme() {
  let theme = null;
  try {
    theme = localStorage.getItem(THEME_KEY);
  } catch { /* 忽略 */ }
  if (!theme) {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(theme);
}

/* ───────────────────────── 数据加载 ───────────────────────── */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadDay(date) {
  if (state.dayCache.has(date)) return state.dayCache.get(date);
  const data = await fetchJson(DAY_URL(date));
  state.dayCache.set(date, data);
  return data;
}

/* ───────────────────────── 侧栏渲染 ───────────────────────── */

function renderSidebar() {
  const { index } = state;
  dom.siteTitle.textContent = index.site?.title || '科技数码日报';
  dom.siteSubtitle.textContent = index.site?.subtitle || '';

  // 数据源状态
  dom.health.replaceChildren(
    ...index.sources.map((s) =>
      h('div', { class: 'health-row', title: s.ok ? `${s.itemCount} 条 · ${s.ms}ms` : `失败：${s.error || '未知'}` }, [
        h('span', { class: `health-dot ${s.ok ? 'ok' : 'bad'}` }),
        h('span', { class: 'health-name', text: s.name }),
        h('span', { class: 'health-num', text: s.ok ? String(s.itemCount) : '—' }),
      ])
    )
  );

  // 构建信息
  const t = index.totals || {};
  const rows = [
    ['生成时间', new Date(index.generatedAt).toLocaleString('zh-CN', { hour12: false })],
    ['归档天数', `${t.days ?? 0} 天`],
    ['累计条目', `${t.items ?? 0} 条`],
    ['本次新增', `${t.freshItems ?? 0} 条`],
    ['可用数据源', `${t.sourcesOk ?? 0} / ${t.sources ?? 0}`],
    ['构建耗时', `${((index.buildMs || 0) / 1000).toFixed(1)} s`],
  ];
  dom.buildMeta.replaceChildren(
    ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])
  );

  dom.footGenerated.textContent = `数据生成于 ${new Date(index.generatedAt).toLocaleString('zh-CN', { hour12: false })}`;

  renderFilterChips();
}

function renderFilterChips() {
  const day = state.dayCache.get(state.loadedDay) || state.dayCache.get(state.dayKeys[0]);
  const catCount = new Map();
  const srcCount = new Map();

  // 用「当前日期 + 搜索词」下的条目统计数量，筛选后再算会互相干扰
  for (const item of allItemsForCounts()) {
    if (state.query && !matchesQuery(item, state.query)) continue;
    catCount.set(item.category, (catCount.get(item.category) || 0) + 1);
    srcCount.set(item.sourceId, (srcCount.get(item.sourceId) || 0) + 1);
  }

  const cats = state.index.categories
    .map((c) => ({ ...c, n: catCount.get(c.id) || 0 }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh'));

  dom.filterCategories.replaceChildren(
    ...cats.map((c) => {
      const isOn = state.catOn.has(c.id);
      const isOff = state.catOff.has(c.id);
      return h('button', {
        class: `chip${isOn ? ' is-on' : ''}${isOff ? ' is-off' : ''}`,
        title: `筛选「${c.label}」`,
        onclick: () => toggleFilter('cat', c.id),
      }, [h('span', { text: `${c.emoji} ${c.label}` }), h('span', { class: 'n', text: String(c.n) })]);
    })
  );

  const srcs = state.index.sources
    .filter((s) => s.ok)
    .map((s) => ({ ...s, n: srcCount.get(s.id) || 0 }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'zh'));

  dom.filterSources.replaceChildren(
    ...srcs.map((s) => {
      const isOn = state.srcOn.has(s.id);
      const isOff = state.srcOff.has(s.id);
      return h('button', {
        class: `chip${isOn ? ' is-on' : ''}${isOff ? ' is-off' : ''}`,
        title: `筛选来源「${s.name}」`,
        onclick: () => toggleFilter('src', s.id),
      }, [h('span', { text: s.name }), h('span', { class: 'n', text: String(s.n) })]);
    })
  );
}

function allItemsForCounts() {
  const day = state.dayCache.get(state.loadedDay);
  if (day) return day.items;
  const first = state.dayCache.get(state.dayKeys[0]);
  return first ? first.items : [];
}

function toggleFilter(kind, id) {
  const onSet = kind === 'cat' ? state.catOn : state.srcOn;
  const offSet = kind === 'cat' ? state.catOff : state.srcOff;

  if (onSet.has(id)) {
    onSet.delete(id);
    offSet.add(id);
  } else if (offSet.has(id)) {
    offSet.delete(id);
  } else {
    onSet.add(id);
    offSet.delete(id);
  }
  renderFilterChips();
  renderActiveFilters();
  renderFeed();
}

function clearFilters() {
  state.catOn.clear();
  state.catOff.clear();
  state.srcOn.clear();
  state.srcOff.clear();
  renderFilterChips();
  renderActiveFilters();
  renderFeed();
}

function renderActiveFilters() {
  const bits = [];
  const label = (id) => state.categoryById.get(id)?.label || id;
  const srcName = (id) => state.index.sources.find((s) => s.id === id)?.name || id;

  for (const id of state.catOn) bits.push(`仅看「${label(id)}」`);
  for (const id of state.catOff) bits.push(`排除「${label(id)}」`);
  for (const id of state.srcOn) bits.push(`仅看来源 ${srcName(id)}`);
  for (const id of state.srcOff) bits.push(`排除来源 ${srcName(id)}`);

  if (!bits.length) {
    dom.activeFilters.hidden = true;
    dom.activeFilters.replaceChildren();
    return;
  }
  dom.activeFilters.hidden = false;
  dom.activeFilters.replaceChildren(
    h('span', { text: `筛选中：${bits.join(' · ')}` }),
    h('button', { class: 'link-btn clear-all', text: '清除全部筛选', onclick: clearFilters })
  );
}

/* ───────────────────────── 日历 ───────────────────────── */

function renderCalendar() {
  if (!state.calCursor) {
    const base = state.requestedDay || state.dayKeys[0] || todayKey(state.index.timezoneOffsetMinutes);
    const [y, m] = base.split('-').map(Number);
    state.calCursor = { y, m: m - 1 };
  }
  const { y, m } = state.calCursor;
  dom.calLabel.textContent = `${y} 年 ${m + 1} 月`;

  const dow = ['日', '一', '二', '三', '四', '五', '六'].map((d) => h('div', { class: 'cal-dow', text: d }));
  const first = new Date(Date.UTC(y, m, 1));
  const startDow = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const tKey = todayKey(state.index.timezoneOffsetMinutes);

  const cells = [];
  for (let i = 0; i < startDow; i += 1) cells.push(h('div', { class: 'cal-cell empty' }));

  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hasData = state.dayKeySet.has(key);
    const classes = ['cal-cell'];
    if (hasData) classes.push('has-data');
    if (key === state.requestedDay) classes.push('is-selected');
    if (key === tKey) classes.push('is-today');

    const entry = state.index.days.find((x) => x.date === key);
    const cell = h('div', {
      class: classes.join(' '),
      text: String(d),
      title: hasData ? `${key} · ${entry?.itemCount ?? 0} 条` : `${key} · 无数据`,
    });
    if (hasData) {
      cell.setAttribute('role', 'button');
      cell.setAttribute('tabindex', '0');
      const go = () => selectDay(key);
      cell.addEventListener('click', go);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    }
    cells.push(cell);
  }

  dom.calGrid.replaceChildren(...dow, ...cells);
}

function shiftMonth(delta) {
  const { y, m } = state.calCursor;
  const next = new Date(Date.UTC(y, m + delta, 1));
  state.calCursor = { y: next.getUTCFullYear(), m: next.getUTCMonth() };
  renderCalendar();
}

/* ───────────────────────── 打开原文 ───────────────────────── */

/**
 * 打开条目原文。
 *
 * 用 window.open 而不是 location.href：GitHub Pages 上站点是 /tech-daily/ 子路径，
 * 用相对路径赋值在带查询参数（?d=日期）时容易解析错，交给浏览器处理更稳。
 * 必须同步调用，否则会被弹窗拦截器判定为非用户手势。
 */
function openItemLink(item) {
  const url = item.link || item.u;
  if (!url) return;
  window.open(url, '_blank', 'noopener');
}

/** 点击目标是可交互元素时不劫持（内部链接、按钮等各自有行为） */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [data-no-card-click]';
function isInteractiveTarget(target) {
  return Boolean(target && typeof target.closest === 'function' && target.closest(INTERACTIVE_SELECTOR));
}

/**
 * 卡片点击 = 打开原文，让整条内容区域都可点，不必去瞄右下角的小链接。
 * 用事件委托挂在容器上，避免给上百张卡片各绑一个监听器。
 */
function onFeedClick(event) {
  if (event.button !== undefined && event.button !== 0) return; // 只处理左键
  if (event.defaultPrevented) return;
  const card = event.target && event.target.closest ? event.target.closest('.card') : null;
  if (!card) return;
  // 点在内部链接/按钮上时交给它们自己处理
  if (isInteractiveTarget(event.target)) return;

  const id = card.dataset.id;
  const day = state.dayCache.get(state.loadedDay);
  const item = day ? day.items.find((i) => i.id === id) : null;
  const url = item ? item.link : card.dataset.link;
  if (!url) return;

  markRead(id);
  openItemLink(item || { link: url });
}

/* ───────────────────────── 正文渲染 ───────────────────────── */

function matchesQuery(item, query) {
  if (!query) return true;
  // 只匹配标题与摘要：把来源名纳入匹配会让「AI」命中 XDA 这类源的全部条目
  const hay = `${item.title}\n${item.description || ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

function visibleItems(items) {
  return items.filter((item) => {
    if (state.catOn.size && !state.catOn.has(item.category)) return false;
    if (state.catOff.has(item.category)) return false;
    if (state.srcOn.size && !state.srcOn.has(item.sourceId)) return false;
    if (state.srcOff.has(item.sourceId)) return false;
    if (!matchesQuery(item, state.query)) return false;
    return true;
  });
}

function groupItems(items, mode) {
  const groups = new Map();
  for (const item of items) {
    const key = mode === 'category' ? item.category : item.sourceId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function highlight(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const words = query
    .split(/\s+/)
    .filter((w) => w.length >= 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (!words.length) return safe;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return safe.replace(re, '<mark class="hl">$1</mark>');
}

function renderCard(item, { query = '', showDay = false } = {}) {
  const cat = state.categoryById.get(item.category) || { label: item.category, emoji: '📰', color: '#64748b' };
  const isRead = readSet.has(item.id);

  const card = h('article', {
    class: `card${isRead ? ' is-read' : ''}`,
    dataset: { id: item.id, link: item.link },
    title: '点击卡片打开原文',
  });

  card.append(
    h('span', { class: 'card-accent', style: `background:${cat.color}` }),
    h('div', { class: 'card-body' }, [
      h('div', { class: 'card-top' }, [
        h('span', {
          class: 'cat-tag',
          style: `color:${cat.color};border-color:${hexToRgba(cat.color, 0.4)};background:${hexToRgba(cat.color, 0.12)}`,
          text: `${cat.emoji} ${cat.label}`,
        }),
        h('span', { class: `src-tag${item.sourceLang === 'en' ? ' lang-en' : ''}`, text: item.sourceName }),
        showDay && item.day ? h('span', { class: 'src-tag', text: item.day }) : null,
      ]),
      // 标题本身就是链接：键盘用户和「右键新标签打开」都靠它，
      // 鼠标用户点卡片任意位置则由事件委托处理
      h('h3', { class: 'card-title' }, [
        h('a', {
          class: 'card-title-link',
          href: item.link,
          target: '_blank',
          rel: 'noopener noreferrer',
          html: highlight(item.title, query),
        }),
      ]),
      item.description ? h('p', { class: 'card-desc', html: highlight(item.description, query) }) : null,
      h('div', { class: 'card-foot' }, [
        h('span', { text: relTime(item.publishedAt) }),
        h('span', { class: 'sep', text: '·' }),
        h('span', { text: clockLabel(item.publishedAt, state.index.timezoneOffsetMinutes) }),
        item.author ? h('span', { class: 'sep', text: '·' }) : null,
        item.author ? h('span', { class: 'author', text: item.author }) : null,
        h('span', { class: 'card-link', text: '阅读原文 ↗' }),
      ]),
    ])
  );

  if (item.image) {
    const img = h('img', {
      src: item.image,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('error', () => thumb.remove(), { once: true });
    const thumb = h('div', { class: 'card-thumb' }, [img]);
    card.append(thumb);
  }

  if (item.duplicates?.length || item.sameSourceDupes) {
    const bits = [];
    if (item.duplicates?.length) {
      bits.push(h('span', { text: `另 ${item.duplicates.length} 家媒体报道：` }));
      item.duplicates.slice(0, 3).forEach((d, i) => {
        if (i) bits.push(h('span', { text: '、' }));
        bits.push(h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer', text: d.sourceName }));
      });
    }
    if (item.sameSourceDupes) bits.push(h('span', { text: `${bits.length ? '｜' : ''}同源重复 ${item.sameSourceDupes} 篇已折叠` }));
    // data-no-card-click：这段是「别的报道来源」信息，点它不该跳到主条目
    card.querySelector('.card-body').append(h('div', { class: 'dupes', 'data-no-card-click': 'true' }, bits));
  }

  return card;
}

function markRead(id) {
  readSet.add(id);
  saveReadSet();
  const node = dom.feed.querySelector(`.card[data-id="${id}"]`);
  if (node) node.classList.add('is-read');
}
function skeleton(count = 6) {
  return h('div', { class: 'skeleton' }, Array.from({ length: count }, () => h('div', { class: 'sk-card' })));
}

function emptyState(title, hint) {
  return h('div', { class: 'empty' }, [
    h('span', { class: 'big', text: '🗞️' }),
    h('p', { text: title }),
    hint ? h('p', { text: hint }) : null,
  ]);
}

/** 主渲染：根据当前 day / 搜索 / 筛选，渲染列表 */
function renderFeed() {
  const feed = dom.feed;

  if (state.query) {
    renderSearchResults();
    return;
  }

  const day = state.dayCache.get(state.loadedDay);
  if (!day) {
    feed.setAttribute('aria-busy', 'true');
    feed.replaceChildren(skeleton());
    return;
  }

  const items = visibleItems(day.items);
  feed.setAttribute('aria-busy', 'false');
  renderDigest(day);

  if (!items.length) {
    feed.replaceChildren(
      emptyState(
        day.items.length ? '当前筛选条件下没有内容' : '这一天没有抓到内容',
        day.items.length ? '试着放宽筛选，或点击侧栏「清除全部筛选」。' : '可能是数据源当天无更新。'
      )
    );
    updateLoadMore();
    return;
  }

  const nodes = [];
  nodes.push(
    h('div', { class: 'group-head group-head--plain' }, [
      h('span', { class: 'g-emoji', text: '📋' }),
      h('h2', { text: '全部动态' }),
      h('span', { class: 'g-count', text: `${items.length} / ${day.items.length} 条` }),
    ])
  );

  const groups = groupItems(items, 'category');
  const order = state.index.categories.map((c) => c.id).filter((id) => groups.has(id));
  // 供 collectVisibleCategoryIds / 全部收起展开 使用
  renderedCategoryIds = order;

  for (const catId of order) {
    const cat = state.categoryById.get(catId) || { label: catId, emoji: '📰', color: '#64748b' };
    const list = groups.get(catId);
    const collapsed = collapsedCats.has(catId);
    const bodyId = `cat-body-${catId}`;
    const headId = `cat-head-${catId}`;

    // 分组标题本身也是按钮：整条都可以点，不必去瞄那个小箭头
    const head = h('div', {
      class: `group-head is-collapsible${collapsed ? ' is-collapsed' : ''}`,
      id: headId,
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(!collapsed),
      'aria-controls': bodyId,
      title: collapsed ? `展开「${cat.label}」` : `收起「${cat.label}」`,
      onclick: () => toggleCategoryCollapse(catId),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleCategoryCollapse(catId);
        }
      },
    }, [
      h('span', { class: 'g-emoji', text: cat.emoji }),
      h('h2', { text: cat.label }),
      h('span', { class: 'g-count', text: `${list.length} 条` }),
      h('span', { class: 'g-toggle', 'aria-hidden': 'true', text: '▾' }),
    ]);

    const body = h('div', {
      class: `cards cards--collapsible${collapsed ? ' is-collapsed' : ''}`,
      id: bodyId,
      role: 'region',
      'aria-labelledby': headId,
      hidden: collapsed ? 'true' : null,
    }, list.map((item) => renderCard(item, { query: '' })));

    nodes.push(head, body);
  }

  feed.replaceChildren(...nodes);
  renderCollapseAll();
  updateLoadMore();
}

function toggleCategoryCollapse(categoryId) {
  const next = !collapsedCats.has(categoryId);
  setCategoryCollapsed(categoryId, next);
  renderFeed();
  if (!next) {
    // 展开后把该分组滚进视野，避免它在长列表里跑丢
    const head = document.getElementById(`cat-head-${categoryId}`);
    if (head && typeof head.scrollIntoView === 'function') {
      head.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** 「全部收起 / 全部展开」按钮的状态与文案 */
function renderCollapseAll() {
  const btn = dom.toggleAll;
  if (!btn) return;
  const total = renderedCategoryIds.length;

  // 工具栏提示：分类数 + 因折叠而隐藏的条数，避免用户以为内容丢了
  if (dom.feedSummary) {
    const day = state.dayCache.get(state.loadedDay);
    const visible = day ? visibleItems(day.items).length : 0;
    const hiddenCount = day
      ? day.items.filter((i) => collapsedCats.has(i.category)).length
      : 0;
    const parts = [`${total} 个分类`, `${visible} 条`];
    if (hiddenCount > 0) parts.push(`已折叠 ${hiddenCount} 条`);
    dom.feedSummary.textContent = state.query ? '' : parts.join(' · ');
  }

  if (!total) {
    btn.hidden = true;
    return;
  }
  const collapsedCount = renderedCategoryIds.filter((id) => collapsedCats.has(id)).length;
  btn.hidden = false;
  if (collapsedCount === total) {
    btn.textContent = '全部展开';
    btn.dataset.action = 'expand';
  } else {
    btn.textContent = '全部收起';
    btn.dataset.action = 'collapse';
  }
}

function renderSearchResults() {
  if (!state.searchData) {
    loadSearchIndex().then(renderSearchResults);
    return;
  }
  renderDigest(state.dayCache.get(state.loadedDay));
  // 搜索结果不成组，折叠控件没有意义
  if (dom.toggleAll) dom.toggleAll.hidden = true;
  if (dom.feedSummary) dom.feedSummary.textContent = '';
  const feed = dom.feed;
  const query = state.query;

  const hits = [];
  for (const item of state.searchData.items) {
    if (state.catOn.size && !state.catOn.has(item.c)) continue;
    if (state.catOff.has(item.c)) continue;
    if (state.srcOn.size && !state.srcOn.has(item.s)) continue;
    if (state.srcOff.has(item.s)) continue;
    const hay = `${item.t}\n${item.x || ''}`.toLowerCase();
    if (!query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) continue;
    hits.push(item);
    if (hits.length >= SEARCH_RESULT_LIMIT) break;
  }
  feed.setAttribute('aria-busy', 'false');

  if (!hits.length) {
    feed.replaceChildren(
      emptyState(`没有匹配「${query}」的内容`, `搜索范围是最近 ${state.searchData.total} 条归档条目，试试更短的关键词。`)
    );
    updateLoadMore();
    return;
  }

  feed.replaceChildren(
    h('div', { class: 'group-head' }, [
      h('span', { class: 'g-emoji', text: '🔍' }),
      h('h2', { text: `搜索「${query}」` }),
      h('span', { class: 'g-count', text: `${hits.length} 条结果${hits.length >= SEARCH_RESULT_LIMIT ? '（已截断）' : ''}` }),
    ]),
    h(
      'div',
      { class: 'cards' },
      hits.map((item) =>
        renderCard(
          {
            ...item,
            title: item.t,
            link: item.u,
            sourceId: item.s,
            sourceName: item.s,
            sourceLang: '',
            category: item.c,
            description: item.x,
            publishedAt: item.p,
            day: item.d,
            image: null,
            id: item.id,
            duplicates: [],
          },
          { query, showDay: true }
        )
      )
    )
  );
  updateLoadMore();
}

function renderDigest(day) {
  if (!day || !day.summary) {
    dom.digest.hidden = true;
    return;
  }
  const s = day.summary;
  const isAi = s.mode === 'ai';
  dom.digest.hidden = false;
  dom.digest.replaceChildren(
    h('div', { class: 'digest-head' }, [
      h('h2', { text: `📝 ${day.label} 摘要` }),
      h('span', { class: `badge${isAi ? '' : ' plain'}`, text: isAi ? 'AI 生成' : '规则式要点' }),
      !isAi && state.index.totals?.sourcesOk
        ? h('span', { class: 'badge plain', text: '配置 AI_API_KEY 后自动升级为 AI 综述' })
        : null,
    ]),
    h('p', {
      class: `digest-overview${s.overview ? '' : ' empty'}`,
      text: s.overview || '这一天没有生成摘要。',
    }),
    s.highlights?.length
      ? h(
          'div',
          { class: 'digest-grid' },
          s.highlights.map((hl) =>
            h('div', { class: 'digest-block' }, [
              h('h3', { text: `${hl.emoji || '📌'} ${hl.label}` }),
              h('ul', {}, (hl.texts || []).map((t) => h('li', { text: t }))),
            ])
          )
        )
      : null
  );
}

function updateLoadMore() {
  const index = state.dayKeys.indexOf(state.loadedDay);
  const hasMore = !state.query && index >= 0 && index < state.dayKeys.length - 1;
  dom.loadMore.hidden = !hasMore;
  dom.loadMore.disabled = false;
  dom.loadMore.textContent = `加载更早一天（还有 ${Math.max(0, state.dayKeys.length - 1 - index)} 天）`;
}

/* ───────────────────────── 日期切换 ───────────────────────── */

async function selectDay(key, { scroll = true } = {}) {
  if (!state.dayKeySet.has(key)) {
    toast('这一天没有归档数据');
    return;
  }
  state.requestedDay = key;
  const token = ++state.loadToken;

  const [y, m] = key.split('-').map(Number);
  if (!state.calCursor || state.calCursor.y !== y || state.calCursor.m !== m - 1) {
    state.calCursor = { y, m: m - 1 };
  }
  renderCalendar();

  dom.tabArchived.hidden = key === state.dayKeys[0];
  dom.tabLatest.classList.toggle('is-active', key === state.dayKeys[0]);
  dom.tabArchived.classList.toggle('is-active', key !== state.dayKeys[0]);
  dom.tabLatest.setAttribute('aria-selected', String(key === state.dayKeys[0]));
  dom.tabArchived.setAttribute('aria-selected', String(key !== state.dayKeys[0]));

  const entry = state.index.days.find((d) => d.date === key);
  dom.dayTitle.textContent = `${entry?.label || key}`;
  dom.dayMeta.textContent = `${key} · ${entry?.itemCount ?? 0} 条${key === state.dayKeys[0] ? ' · 最新' : ''}`;

  if (!state.dayCache.has(key)) {
    dom.feed.setAttribute('aria-busy', 'true');
    dom.feed.replaceChildren(skeleton());
    dom.digest.hidden = true;
  }

  try {
    const day = await loadDay(key);
    if (token !== state.loadToken) return;
    state.loadedDay = key;
    try {
      const url = new URL(location.href);
      if (key === state.dayKeys[0]) url.searchParams.delete('d');
      else url.searchParams.set('d', key);
      history.replaceState(null, '', url);
    } catch { /* file:// 下会失败，忽略 */ }
    renderSidebar();
    renderFeed();
    if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    if (token !== state.loadToken) return;
    dom.feed.setAttribute('aria-busy', 'false');
    dom.feed.replaceChildren(emptyState('加载失败', `无法读取 ${key} 的数据：${err.message}`));
  }
}

async function loadSearchIndex() {
  if (state.searchData) return state.searchData;
  try {
    state.searchData = await fetchJson(SEARCH_URL);
  } catch {
    state.searchData = { total: 0, items: [] };
  }
  return state.searchData;
}

/* ───────────────────────── 导出 ───────────────────────── */

function exportCurrent() {
  const day = state.dayCache.get(state.loadedDay);
  if (!day) return;
  const items = state.query
    ? state.searchData?.items.filter((i) => matchesQuery({ title: i.t, description: i.x, sourceName: i.s }, state.query)) || []
    : visibleItems(day.items);

  const lines = [`# 科技数码日报 · ${day.label}（${day.date}）`, ''];
  if (day.summary?.overview) lines.push(`> ${day.summary.overview}`, '');
  for (const it of items) {
    const source = it.sourceName || it.s;
    const url = it.link || it.u;
    lines.push(`- [${it.title || it.t}](${url}) — ${source}`);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tech-daily-${day.date}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已导出 ${items.length} 条`);
}

/* ───────────────────────── 事件绑定 ───────────────────────── */

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.sidebarBtn.setAttribute('aria-expanded', 'false');
  dom.scrim.hidden = true;
}

function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.sidebarBtn.setAttribute('aria-expanded', 'true');
  dom.scrim.hidden = false;
}

function bindEvents() {
  dom.theme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  dom.sidebarBtn.addEventListener('click', () => {
    if (dom.sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  dom.scrim.addEventListener('click', closeSidebar);

  const onSearch = debounce((value) => {
    state.query = value.trim();
    dom.searchClear.hidden = !state.query;
    if (state.query) loadSearchIndex().then(renderSearchResults);
    renderFilterChips();
    renderFeed();
  }, 190);

  dom.search.addEventListener('input', (e) => onSearch(e.target.value));
  dom.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dom.search.value = '';
      onSearch('');
      dom.search.blur();
    }
  });
  dom.searchClear.addEventListener('click', () => {
    dom.search.value = '';
    onSearch('');
    dom.search.focus();
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      dom.search.focus();
      dom.search.select();
    } else if (e.key === 'Escape' && dom.sidebar.classList.contains('open')) {
      closeSidebar();
    }
  });

  dom.calPrev.addEventListener('click', () => shiftMonth(-1));
  dom.calNext.addEventListener('click', () => shiftMonth(1));
  dom.tabLatest.addEventListener('click', () => selectDay(state.dayKeys[0]));
  dom.tabArchived.addEventListener('click', () => {
    // 「历史」= 当前选中日期的前一天
    const idx = state.dayKeys.indexOf(state.loadedDay);
    if (idx + 1 < state.dayKeys.length) selectDay(state.dayKeys[idx + 1]);
  });

  dom.btnLatest.addEventListener('click', () => selectDay(state.dayKeys[0]));

  dom.btnRandom.addEventListener('click', () => {
    if (state.dayKeys.length < 2) return toast('还没有更多历史归档');
    const others = state.dayKeys.filter((k) => k !== state.loadedDay);
    selectDay(others[Math.floor(Math.random() * others.length)]);
  });

  dom.loadMore.addEventListener('click', () => {
    const idx = state.dayKeys.indexOf(state.loadedDay);
    if (idx + 1 < state.dayKeys.length) {
      dom.loadMore.disabled = true;
      dom.loadMore.textContent = '加载中…';
      selectDay(state.dayKeys[idx + 1]);
    }
  });

  dom.btnExport.addEventListener('click', exportCurrent);

  // 事件委托：卡片内容区任意位置点击都打开原文（内部链接除外）
  dom.feed.addEventListener('click', onFeedClick);

  dom.toggleAll.addEventListener('click', () => {
    // 未全部收起时先全部收起；已全部收起则全部展开
    setManyCollapsed(renderedCategoryIds, dom.toggleAll.dataset.action !== 'expand');
    renderFeed();
  });

  window.addEventListener('popstate', () => {
    const d = new URL(location.href).searchParams.get('d');
    selectDay(d && state.dayKeySet.has(d) ? d : state.dayKeys[0], { scroll: false });
  });
}

/* ───────────────────────── 启动 ───────────────────────── */

async function main() {
  initTheme();
  loadCollapsed();
  bindEvents();
  dom.feed.setAttribute('aria-busy', 'true');
  dom.feed.replaceChildren(skeleton());

  let index;
  try {
    index = await fetchJson(INDEX_URL);
  } catch (err) {
    dom.dayTitle.textContent = '数据未就绪';
    dom.dayMeta.textContent = '还没有生成任何数据';
    dom.feed.setAttribute('aria-busy', 'false');
    dom.feed.replaceChildren(
      emptyState('找不到 data/index.json', `请先在项目根目录运行 npm run build 生成数据。(${err.message})`)
    );
    return;
  }

  state.index = index;
  state.categoryById = new Map(index.categories.map((c) => [c.id, c]));
  state.dayKeys = index.days.map((d) => d.date);
  state.dayKeySet = new Set(state.dayKeys);

  renderSidebar();

  if (!state.dayKeys.length) {
    dom.feed.replaceChildren(emptyState('暂无数据', '构建成功但没有任何条目，请检查数据源。'));
    return;
  }

  let requested = null;
  try {
    requested = new URL(location.href).searchParams.get('d');
  } catch { /* 忽略 */ }
  const startDay = requested && state.dayKeySet.has(requested) ? requested : state.dayKeys[0];

  await selectDay(startDay, { scroll: false });

  // 空闲时预取搜索索引，让首次搜索瞬间响应，同时不拖慢首屏
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(() => loadSearchIndex().catch(() => {}));

  // 就绪信号（供自动化测试与外部集成使用）
  window.__techDailyReady = true;
  window.dispatchEvent(new CustomEvent('techdaily:ready', { detail: { date: state.loadedDay, items: state.dayCache.get(state.loadedDay)?.items.length ?? 0 } }));
}

main().catch((err) => {
  console.error('[tech-daily] 启动失败：', err);
  window.__techDailyError = err?.message || String(err);
});
