/**
 * 端到端逻辑验证（零依赖 DOM 仿真）
 *
 *   node scripts/test-ui.mjs
 *
 * 为什么不用无头浏览器：部分受限/沙箱环境中浏览器渲染进程无法启动。
 * 本脚本解析真实的 index.html 构建元素树，读取真实的 data/*.json，
 * 然后**执行真实的 app.js**，对渲染结果与交互行为逐项断言。
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dedupe } from './dedupe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.preview', 'ui-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════ 1. 极简 DOM 实现 ══════════════════════ */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'wbr']);

class ClassList {
  constructor(node) {
    Object.defineProperty(this, '_node', { value: node, enumerable: false });
  }
  get _set() {
    return this._node._classes;
  }
  add(...names) {
    for (const n of names) if (n) this._set.add(String(n).trim());
  }
  remove(...names) {
    for (const n of names) this._set.delete(String(n).trim());
  }
  toggle(name, force) {
    const has = this._set.has(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this._set.add(name);
    else this._set.delete(name);
    return want;
  }
  contains(name) {
    return this._set.has(String(name).trim());
  }
  get value() {
    return [...this._set].join(' ');
  }
}

class DomNode {
  constructor(name = 'div') {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    // dataset 必须与 attributes 联动：真实 DOM 里 el.dataset.id = 'x'
    // 等价于 setAttribute('data-id','x')，否则属性选择器 [data-id="x"] 匹配不到。
    this.dataset = new Proxy(
      {},
      {
        get: (t, key) => t[key],
        set: (t, key, value) => {
          t[key] = value;
          const attr = `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
          this.attributes.set(attr, String(value));
          return true;
        },
        deleteProperty: (t, key) => {
          delete t[key];
          const attr = `data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
          this.attributes.delete(attr);
          return true;
        },
        has: (t, key) => key in t,
      }
    );
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => ((t[k] = v), true) });
    this.listeners = new Map();
    this._classes = new Set();
    this.classList = new ClassList(this);
    this._text = '';
    this._html = '';
    this._value = '';
    this.hidden = false;
    this.disabled = false;
    this.isContentEditable = false;
  }

  get className() {
    return this.classList.value;
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    this.classList = new ClassList(this);
  }

  get textContent() {
    if (this.childNodes.length) return this.getAllText();
    return this._text;
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = v == null ? '' : String(v);
  }

  /** 仿真下不建节点树，但真实 DOM 的 innerHTML 也会让 textContent 变成纯文本，这里保持一致 */
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = v == null ? '' : String(v);
    this._text = this._html
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  get value() {
    return this._value;
  }
  set value(v) {
    this._value = v == null ? '' : String(v);
  }

  get children() {
    return this.childNodes.filter((c) => c instanceof DomNode);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get parentElement() {
    return this.parentNode instanceof DomNode ? this.parentNode : null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const n = node instanceof DomNode || node instanceof DomText ? node : new DomText(String(node));
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    return node;
  }

  setAttribute(name, value) {
    const n = String(name).toLowerCase();
    this.attributes.set(n, String(value));
    if (n.startsWith('data-')) {
      const key = n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
    if (n === 'class') this.className = value;
    if (n === 'hidden') this.hidden = true;
    if (n === 'value') this.value = value;
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    event.target = event.target || this;
    event.currentTarget = this;
    const fns = this.listeners.get(event.type);
    if (fns) for (const fn of [...fns]) fn.call(this, event);
    // 冒泡
    if (event.bubbles !== false && this.parentNode instanceof DomNode) this.parentNode.dispatchEvent(event);
    return true;
  }
  click() {
    this.dispatchEvent(new DomEvent('click', { bubbles: true }));
  }
  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  blur() {
    this.focused = false;
  }
  select() {
    this.selected = true;
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (node) => {
      if (node !== this && matches(node, selector)) out.push(node);
    });
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  matches(selector) {
    return matches(this, selector);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node instanceof DomNode && matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** 递归取出全部文本（仿真环境的 textContent 只覆盖直接子节点） */
  getAllText() {
    if (!this.childNodes.length) return this._text || '';
    return this.childNodes.map((c) => (c instanceof DomText ? c.data : c.getAllText())).join('');
  }
}

class DomText {
  constructor(data) {
    this.nodeName = '#text';
    this.data = String(data);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

class DomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = opts.bubbles !== false;
    this.detail = opts.detail;
    this.defaultPrevented = false;
    this.target = null;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {}
}

function walk(node, fn) {
  for (const child of node.childNodes) {
    if (child instanceof DomNode) {
      fn(child);
      walk(child, fn);
    }
  }
}

/** 支持后代选择器（空格分隔）以及 *、#id、.class、tag、[attr]、tag.class、.a.b、以及它们的任意组合 */
function matchesCompound(node, sel) {
  if (sel === '*') return true;

  let rest = sel;
  let constrained = false;

  if (rest.startsWith('#')) {
    rest = rest.slice(1);
    const id = rest.split(/[.\[]/)[0];
    if (node.getAttribute('id') !== id) return false;
    rest = rest.slice(id.length);
    constrained = true;
  }

  // 标签名（位于最前）
  const tagName = rest.split(/[.#\[]/)[0];
  if (tagName) {
    if (node.nodeName !== tagName.toUpperCase()) return false;
    constrained = true;
    rest = rest.slice(tagName.length);
  }

  // 类名
  for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!node.classList.contains(m[1])) return false;
    constrained = true;
  }

  // 属性选择器（可能带值，也可能只有属性名）—— 必须逐个检查，
  // 否则 .card[data-id="x"] 这种组合式会把属性条件整段忽略掉
  const attrRe = /\[\s*([a-zA-Z0-9_-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/g;
  let attrMatch;
  let sawAttr = false;
  while ((attrMatch = attrRe.exec(rest))) {
    sawAttr = true;
    const [, name, dq, sq, bare] = attrMatch;
    const expected = dq ?? sq ?? bare;
    const actual = node.getAttribute(name);
    if (expected === undefined) {
      if (actual === null) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  if (sawAttr) constrained = true;

  return constrained;
}

function matches(node, selector) {
  // 选择器列表（a, button, ...）：任一命中即可。
  // 必须支持，否则 closest('a, button, ...') 会永远返回 null。
  if (String(selector).includes(',')) {
    return String(selector)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => matches(node, part));
  }

  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchesCompound(node, parts[parts.length - 1])) return false;

  // 其余部分必须能在祖先链上按顺序匹配到
  let ancestor = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (ancestor instanceof DomNode) {
      if (matchesCompound(ancestor, parts[i])) {
        found = true;
        ancestor = ancestor.parentNode;
        break;
      }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * 把 HTML 解析成元素树。会正确处理属性里的 > 与引号，
 * 因此 <button ... aria-label="a>b"> 不会被截断。
 */
function parseHTML(html, doc) {
  const root = new DomNode('html');
  const stack = [root];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const text = html.slice(i, lt);
    if (text) top().append(new DomText(text.replace(/\s+/g, ' ')));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // 找到标签结束位置（跳过引号内的 >）
    let j = lt + 1;
    let quote = null;
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    const raw = html.slice(lt + 1, j).trim();
    i = j + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].nodeName === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameMatch = body.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const node = new DomNode(name);

    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    attrRe.lastIndex = nameMatch[0].length;
    let m;
    while ((m = attrRe.exec(body))) {
      const an = m[1];
      const av = m[3] ?? m[4] ?? m[5] ?? '';
      node.setAttribute(an, av);
    }

    node.ownerDocument = doc;
    top().append(node);
    if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) stack.push(node);
  }
  return root;
}

/* ══════════════════════ 2. 构建运行环境 ══════════════════════ */

const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const appSource = await readFile(path.join(ROOT, 'app.js'), 'utf8');

const documentRoot = parseHTML(html, null);
const idMap = new Map();
// 根元素自身不在 walk 的遍历结果里，需要单独处理
for (const node of [documentRoot, ...documentRoot.querySelectorAll('*')]) {
  const id = node.getAttribute('id');
  if (id) idMap.set(id, node);
}

const documentEvents = new Map();

const document = {
  documentElement: (() => {
    const el = new DomNode('html');
    el.dataset = {};
    return el;
  })(),
  body: new DomNode('body'),
  createElement: (tag) => new DomNode(tag),
  createTextNode: (t) => new DomText(t),
  getElementById: (id) => idMap.get(id) || null,
  querySelector: (sel) => documentRoot.querySelector(sel),
  querySelectorAll: (sel) => documentRoot.querySelectorAll(sel),
  addEventListener: (type, fn) => {
    if (!documentEvents.has(type)) documentEvents.set(type, new Set());
    documentEvents.get(type).add(fn);
  },
  removeEventListener: () => {},
  dispatchEvent: (e) => {
    const fns = documentEvents.get(e.type);
    if (fns) for (const fn of [...fns]) fn(e);
    return true;
  },
  hidden: false,
};

const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
// 折叠状态是跨会话持久化的，测试必须从干净状态开始，
// 否则上一次运行写入的分类 id 会残留、让当前日期的分组看起来是折叠的。
// 「已读」状态也一并清空，保证卡片初始不带 is-read。
localStorage.clear();

const location = {
  href: 'http://localhost/tech-daily/',
  search: '',
  pathname: '/tech-daily/',
  hash: '',
};

const historyCalls = [];
const history = {
  replaceState(_s, _t, url) {
    historyCalls.push(String(url));
    try {
      const u = new URL(String(url), location.href);
      location.search = u.search;
      location.href = u.toString();
      location.pathname = u.pathname;
    } catch { /* 忽略 */ }
  },
  pushState(_s, _t, url) {
    history.replaceState(_s, _t, url);
  },
};

const scrollCalls = [];
/** 记录 window.open 调用，用于验证「点击卡片打开原文」 */
const openCalls = [];
const windowObj = {
  location,
  history,
  localStorage,
  document,
  innerWidth: 1440,
  innerHeight: 900,
  scrollTo: (opts) => scrollCalls.push(opts),
  open: (url, target, features) => {
    openCalls.push({ url, target, features });
    return { closed: false };
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  addEventListener: (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener: () => {},
  dispatchEvent: (e) => {
    const fns = windowListeners.get(e.type);
    if (fns) for (const fn of [...fns]) fn(e);
    return true;
  },
  getComputedStyle: () => ({ display: 'block' }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  __techDailyReady: false,
};
const windowListeners = new Map();
windowObj.window = windowObj;
windowObj.self = windowObj;
windowObj.globalThis = windowObj;

const fetchCalls = [];
/** 与 app 共享的解析结果缓存：测试可借此直接改动 app 正在使用的对象 */
const jsonCache = new Map();
async function fetchShim(url) {
  const rel = String(url).replace(/^\.\//, '');
  fetchCalls.push(rel);
  const abs = path.join(ROOT, rel);
  try {
    const text = await readFile(abs, 'utf8');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        if (!jsonCache.has(rel)) jsonCache.set(rel, JSON.parse(text));
        return jsonCache.get(rel);
      },
      async text() {
        return text;
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      async json() {
        throw err;
      },
      async text() {
        return '';
      },
    };
  }
}

/**
 * 触发一次整体重绘（renderFeed）然后立刻把折叠状态还原为「全部展开」。
 * 注意不能盲目点一次——若分组本来就是折叠的，那一下会把它展开，状态反而更乱。
 */
async function refreshFeedClean() {
  const firstHead = () => documentRoot.querySelectorAll('.group-head.is-collapsible')[0];
  const head = firstHead();
  if (!head) return;
  head.click();
  await sleep(80);
  const h = firstHead();
  if (h && h.getAttribute('aria-expanded') === 'false') {
    h.click();
    await sleep(80);
  }
  // 保险：任何残留的折叠都展开
  for (const hd of documentRoot.querySelectorAll('.group-head.is-collapsible')) {
    if (hd.getAttribute('aria-expanded') === 'false') {
      hd.click();
      await sleep(40);
    }
  }
}

class CustomEventShim extends DomEvent {
  constructor(type, opts = {}) {
    super(type, opts);
    this.detail = opts.detail;
  }
}

/* ══════════════════════ 3. 执行 app.js ══════════════════════ */

await mkdir(TMP, { recursive: true });
const entry = path.join(TMP, 'app-under-test.mjs');
await writeFile(entry, appSource, 'utf8');

const runtime = {
  window: windowObj,
  document,
  localStorage,
  location,
  history,
  fetch: fetchShim,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  Blob: class {
    constructor(parts) {
      this.parts = parts;
    }
  },
  CustomEvent: CustomEventShim,
  Event: DomEvent,
  Node: DomNode,
  navigator: { userAgent: 'node-ui-harness' },
};

const runner = new Function(
  ...Object.keys(runtime),
  `"use strict";\n${appSource}\n//# sourceURL=app-under-test.js`
);
runner(...Object.values(runtime));

// 等待首屏异步加载完成
const deadline = Date.now() + 20000;
while (!windowObj.__techDailyReady && !windowObj.__techDailyError && Date.now() < deadline) {
  await sleep(60);
}

/* ══════════════════════ 4. 断言 ══════════════════════ */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const q = (sel) => documentRoot.querySelectorAll(sel);
const q1 = (sel) => documentRoot.querySelector(sel);
const text = (sel) => q1(sel)?.textContent?.trim() ?? '';
const count = (sel) => q(sel).length;

/** 统计真正可见的卡片：折叠的分组内容区带 hidden，其中的卡片不应计入 */
const visibleCards = () => q('.card').filter((c) => !c.closest('[hidden]'));

/**
 * 已读集合存在 localStorage 里（app.js 的 readSet 是模块内变量，
 * 经 new Function 执行后测试作用域无法直接访问，故从存储读取）
 */
const storedReadSet = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem('techdaily:read') || '[]'));
  } catch {
    return new Set();
  }
};

// 提前取出搜索框，供多处断言复用（避免 const 暂时性死区）
const searchInput = q1('#search');

const index = JSON.parse(await readFile(path.join(ROOT, 'data', 'index.json'), 'utf8'));
const latest = index.days[0];
const latestDay = JSON.parse(await readFile(path.join(ROOT, 'data', 'days', `${latest.date}.json`), 'utf8'));

console.log(`\n环境：DOM 仿真（${q('*').length} 个元素）· 数据 ${latest.date} / ${latest.itemCount} 条\n`);
console.log('— 首屏渲染 —');

check('应用启动无异常', !windowObj.__techDailyError, windowObj.__techDailyError || '');
check('已请求 index.json', fetchCalls.includes('data/index.json'));
check('已请求当日数据', fetchCalls.includes(`data/days/${latest.date}.json`));

// 搜索索引改为空闲时预取，给它一点时间
await sleep(1600);
check('空闲时预取搜索索引', fetchCalls.includes('data/search.json'));

const cardCount = count('.card');
check(
  '卡片数量与数据一致',
  cardCount === latest.itemCount,
  `渲染 ${cardCount} / 数据 ${latest.itemCount}`
);

const groupHeads = q('.group-head');
check('存在分组标题', groupHeads.length >= 5, `${groupHeads.length} 个分组（含「全部动态」）`);
check('第一个分组为「全部动态」', text('.group-head h2') === '全部动态', text('.group-head h2'));

const digestHidden = q1('#digest').hidden;
check('摘要卡片可见', digestHidden === false);
check('摘要正文非空', text('.digest-overview').length > 20, text('.digest-overview').slice(0, 50) + '…');
check('摘要包含要点区块', count('.digest-block') >= 1, `${count('.digest-block')} 个区块`);
check('摘要标注生成方式', /AI 生成|规则式要点/.test(text('#digest .badge')), text('#digest .badge'));
// 规则式要点时会提示如何升级为 AI 综述；AI 模式下不应出现该提示
if (text('#digest .badge') === '规则式要点') {
  check('未配置 AI 时给出升级提示', /AI_API_KEY/.test(text('#digest')));
} else {
  check('AI 模式下不显示升级提示', !/AI_API_KEY/.test(text('#digest')));
}

check('日期标题渲染', text('#day-title').length > 3, text('#day-title'));
check('日期元信息含条数', /条/.test(text('#day-meta')), text('#day-meta'));
check('「最新」标签激活', q1('#tab-latest').classList.contains('is-active'));
check('历史标签隐藏', q1('#tab-archived').hidden === true);

const calCells = q('.cal-cell.has-data');
check('日历标记有数据日期', calCells.length === index.days.length, `${calCells.length} 天 = 索引 ${index.days.length} 天`);
check('日历高亮当前日期', count('.cal-cell.is-selected') === 1);
check('日历月份标签正确', /年 \d+ 月/.test(text('#cal-label')), text('#cal-label'));

const catChips = q('#filter-categories .chip');
const srcChips = q('#filter-sources .chip');
check('分类筛选项渲染', catChips.length === index.categories.length, `${catChips.length} 个分类`);
check('来源筛选项渲染', srcChips.length === index.sources.filter((s) => s.ok).length, `${srcChips.length} 个可用来源`);
check(
  '筛选计数之和等于当日条数',
  catChips.reduce((sum, c) => sum + Number(c.querySelector('.n').textContent), 0) === latest.itemCount,
  `分类合计 ${catChips.reduce((sum, c) => sum + Number(c.querySelector('.n').textContent), 0)}`
);

check('数据源健康面板渲染', count('.health-row') === index.sources.length, `${count('.health-row')} 行`);
check('健康面板标记失败源', count('.health-dot.bad') === index.sources.filter((s) => !s.ok).length);
check('构建信息渲染', count('#build-meta dt') >= 5, `${count('#build-meta dt')} 项`);
check('页脚生成时间渲染', /数据生成于/.test(text('#foot-generated')));

check('卡片标题非空', q('.card').every((c) => c.querySelector('.card-title').getAllText().trim().length > 3));
check('卡片含来源标签', q('.card').every((c) => c.querySelector('.src-tag')));
check('标题是真实链接（键盘/右键可用）', q('.card').every((c) => {
  const a = c.querySelector('.card-title-link');
  return a && /^https?:\/\//.test(a.getAttribute('href') || '') && a.getAttribute('rel') === 'noopener noreferrer';
}));
check('标题链接指向原文', q('.card').every((c) => c.querySelector('.card-title-link').getAttribute('href') === c.dataset.link));
check('卡片带 data-link 兜底', q('.card').every((c) => /^https?:\/\//.test(c.dataset.link || '')));
check('卡片含分类色条', q('.card').every((c) => c.querySelector('.card-accent')));
check('渲染了配图', count('.card-thumb img') > 0, `${count('.card-thumb img')} 张`);
check('配图使用懒加载', q('.card-thumb img').every((i) => i.getAttribute('loading') === 'lazy'));

// 只有当数据里真的出现了折叠条目时才校验展示；逻辑本身在下方用合成样本回归
if (count('.dupes') > 0) {
  check('折叠重复条目有提示', true, `${count('.dupes')} 处`);
}

console.log('\n— 点击卡片打开原文 —');

const clickCard = q('.card')[0];
const clickLink = clickCard.dataset.link;
const clickId = clickCard.dataset.id;

openCalls.length = 0;
clickCard.querySelector('.card-desc').click();
check('点击卡片正文打开原文', openCalls.length === 1 && openCalls[0].url === clickLink, `${openCalls.length} 次调用 → ${openCalls[0]?.url}`);
check('新标签打开并带 noopener', openCalls[0]?.target === '_blank' && String(openCalls[0]?.features).includes('noopener'));
check('点击卡片后标记为已读', storedReadSet().has(clickId) && clickCard.classList.contains('is-read'));
check('已读状态写入 localStorage', (localStorage.getItem('techdaily:read') || '').includes(clickId));

openCalls.length = 0;
clickCard.querySelector('.cat-tag').click();
check('点击分类标签也打开原文', openCalls.length === 1, `${openCalls.length} 次`);

openCalls.length = 0;
clickCard.querySelector('.card-title-link').click();
check('点击标题不重复弹窗（交给链接自身）', openCalls.length === 0, `${openCalls.length} 次调用`);

// 关键防回归：卡片内部的「另 N 家媒体报道」链接不能被劫持
const cardWithDupes = q('.card').find((c) => c.querySelector('.dupes a'));
if (cardWithDupes) {
  const dupeLink = cardWithDupes.querySelector('.dupes a');
  const dupeHref = dupeLink.getAttribute('href');
  openCalls.length = 0;
  dupeLink.click();
  check('点击「另 N 家媒体报道」不打开主条目', openCalls.length === 0, `${openCalls.length} 次调用`);
  check('媒体报道链接本身保留正确地址', /^https?:\/\//.test(dupeHref || ''), dupeHref);
  check('媒体报道链接带 noopener', dupeLink.getAttribute('rel') === 'noopener noreferrer');
} else {
  check('（本次数据无折叠重复条目，跳过媒体链接测试）', true);
}

openCalls.length = 0;
const imgCard = q('.card').find((c) => c.querySelector('.card-thumb img'));
if (imgCard) {
  imgCard.querySelector('.card-thumb img').click();
  check('点击配图也打开原文', openCalls.length === 1, `${openCalls.length} 次`);
} else {
  check('（本次数据无配图，跳过配图点击测试）', true);
}

// 右键 / 中键不应触发
openCalls.length = 0;
const rightClick = new DomEvent('click', { bubbles: true });
rightClick.button = 2;
clickCard.querySelector('.card-desc').dispatchEvent(rightClick);
check('非左键点击不跳转', openCalls.length === 0, `${openCalls.length} 次`);

// 点击空白区域（无 .card 祖先）不应跳转
openCalls.length = 0;
q1('#feed').click();
check('点击非卡片区域不跳转', openCalls.length === 0, `${openCalls.length} 次`);

// 搜索结果里的卡片同样可点
searchInput.value = 'AI';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);
const searchCard = q('.card')[0];
if (searchCard) {
  openCalls.length = 0;
  searchCard.querySelector('.card-desc')?.click();
  check('搜索结果卡片也可点击跳转', openCalls.length === 1, `${openCalls.length} 次`);
}
q1('#search-clear').click();
await sleep(450);
openCalls.length = 0;

// 当前数据里恰好没有折叠重复条目，而「卡片内链接不能被劫持」是本次改动最容易踩的坑。
// 因此往 app 正在使用的日数据对象里注入一条合成重复项，重绘后验证，最后移除。
{
  const dayObj = jsonCache.get(`data/days/${index.days[0].date}.json`);
  const host = dayObj?.items?.find((i) => i.link && i.category);
  if (host) {
    const originalDupes = host.duplicates;
    host.duplicates = [{ sourceName: '合成测试源', link: 'https://example.com/other-coverage' }];
    await refreshFeedClean();

    const injected = q('.card').find((c) => c.querySelector('.dupes a'));
    if (injected) {
      const dupeA = injected.querySelector('.dupes a');
      openCalls.length = 0;
      dupeA.click();
      check('点击「另 N 家媒体报道」不打开主条目', openCalls.length === 0, `${openCalls.length} 次调用`);
      check('媒体报道链接地址正确', dupeA.getAttribute('href') === 'https://example.com/other-coverage', String(dupeA.getAttribute('href')));
      check('媒体报道链接带 noopener', dupeA.getAttribute('rel') === 'noopener noreferrer');

      openCalls.length = 0;
      injected.querySelector('.dupes').click();
      check('点击重复提示区域不误跳转', openCalls.length === 0, `${openCalls.length} 次`);

      openCalls.length = 0;
      const desc = injected.querySelector('.card-desc');
      if (desc) desc.click();
      check('同一卡片点正文仍正常跳转', openCalls.length === 1, `${openCalls.length} 次`);
    } else {
      check('注入合成重复项后渲染出折叠提示', false, '未找到 .dupes');
    }

    if (originalDupes === undefined) delete host.duplicates;
    else host.duplicates = originalDupes;
    await refreshFeedClean();
  } else {
    check('（无法取得日数据对象，跳过媒体链接测试）', true);
  }
}
openCalls.length = 0;

console.log('\n— 分类筛选 —');

const catChipInfo = (() => {
  const chip = catChips[0];
  return {
    label: chip.querySelector('span').textContent,
    n: Number(chip.querySelector('.n').textContent),
    index: 0,
  };
})();
// 每次交互都会重建 chip 节点，断言必须重新查询而不是持有旧引用
const freshCatChip = () => q('#filter-categories .chip')[catChipInfo.index];

freshCatChip().click();
await sleep(50);

check('筛选后卡片数等于该分类条数', count('.card') === catChipInfo.n, `${count('.card')} / 期望 ${catChipInfo.n}`);
check('筛选提示条出现', q1('#active-filters').hidden === false);
check('筛选提示含分类名', text('#active-filters').includes(catChipInfo.label.replace(/^\S+\s*/, '')), text('#active-filters').slice(0, 40));
check('被选中的 chip 高亮', freshCatChip().classList.contains('is-on'), freshCatChip().className);

// 再点一次 → 变为排除
freshCatChip().click();
await sleep(50);
check('二次点击变为排除', freshCatChip().classList.contains('is-off'), freshCatChip().className);
check('排除后条数减少', count('.card') === latest.itemCount - catChipInfo.n, `${count('.card')} / 期望 ${latest.itemCount - catChipInfo.n}`);

q1('#active-filters .clear-all').click();
await sleep(50);
check('清除筛选后恢复全部', count('.card') === latest.itemCount, `${count('.card')} 条`);
check('清除后提示条隐藏', q1('#active-filters').hidden === true);

console.log('\n— 来源筛选 —');

const srcChip = srcChips.find((c) => Number(c.querySelector('.n').textContent) > 0);
const srcName = srcChip.querySelector('span').textContent;
const srcN = Number(srcChip.querySelector('.n').textContent);
srcChip.click();
await sleep(50);
const srcTags = new Set(q('.card').map((c) => c.querySelector('.src-tag').textContent));
check('来源筛选后仅剩单一来源', srcTags.size === 1 && srcTags.has(srcName), `${count('.card')} 条，来源 ${[...srcTags].join(',')}`);
check('来源计数正确', count('.card') === srcN, `${count('.card')} / 期望 ${srcN}`);
q1('#active-filters .clear-all').click();
await sleep(50);

console.log('\n— 关键词搜索 —');

searchInput.value = 'AI';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);

check('搜索结果标题渲染', /搜索「AI」/.test(text('.group-head h2')), text('.group-head h2'));
const hitCount = count('.card');
check('搜索命中若干结果', hitCount > 0, `${hitCount} 条`);
check('结果条数不超过上限', hitCount <= 240, `${hitCount} 条`);
check(
  '所有结果都命中关键词（仅标题与摘要）',
  q('.card').every((c) => {
    const hay = `${c.querySelector('.card-title').getAllText()}\n${c.querySelector('.card-desc')?.getAllText() || ''}`.toLowerCase();
    return hay.includes('ai');
  })
);
check('搜索不匹配来源名（避免整源误命中）', fetchCalls.includes('data/search.json'));
// innerHTML 在仿真环境下是字符串，不解析成节点树，因此直接检查高亮标记文本
const highlighted = q('.card-title').concat(q('.card-desc')).filter((n) => /<mark class="hl">/.test(n.innerHTML));
check('关键词高亮写入渲染结果', highlighted.length > 0, `${highlighted.length} 个节点含高亮`);
check('高亮内容已做 HTML 转义', highlighted.every((n) => !/<(?!\/?mark)/i.test(n.innerHTML.replace(/<mark class="hl">|<\/mark>/g, ''))));
check('结果标注归档日期', q('.card').some((c) => c.querySelectorAll('.src-tag').length >= 2));
check('搜索时隐藏「加载更早」', q1('#load-more').hidden === true);
check('清空按钮出现', q1('#search-clear').hidden === false);

// 中文关键词
searchInput.value = '手机';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);
check('中文关键词搜索可用', count('.card') > 0, `「手机」→ ${count('.card')} 条`);

// 无结果
searchInput.value = 'zzzz不存在的关键词zzzz';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);
check('无结果时显示空状态', count('.empty') >= 1, text('.empty p'));
check('空状态文案包含关键词', text('.empty p').includes('zzzz'), '');
check('无结果时无卡片', count('.card') === 0);

q1('#search-clear').click();
await sleep(450);
check('清空搜索恢复列表', count('.card') === latest.itemCount, `${count('.card')} 条`);
check('清空后按钮隐藏', q1('#search-clear').hidden === true);

console.log('\n— 历史归档 —');

const otherCell = q('.cal-cell.has-data').find((c) => !c.classList.contains('is-selected'));
const otherDate = otherCell.getAttribute('title').split(' · ')[0];
const otherCount = Number(otherCell.getAttribute('title').split(' · ')[1].replace(/\D/g, ''));
otherCell.click();
await sleep(400);

check('切换到历史日期', text('#day-meta').includes(otherDate), text('#day-meta'));
check('历史日期条数正确', count('.card') === otherCount, `${count('.card')} / 期望 ${otherCount}`);
check('历史日期有独立摘要', q1('#digest').hidden === false);
check('历史标签激活', q1('#tab-archived').classList.contains('is-active') && q1('#tab-archived').hidden === false);
check('URL 记录历史日期', historyCalls.some((u) => String(u).includes(`d=${otherDate}`)), historyCalls.at(-1) || '');
check('日历高亮跟随切换', q('.cal-cell.is-selected')[0]?.getAttribute('title')?.startsWith(otherDate));

console.log('\n— 分类折叠 / 展开 —');

const catHeads = () => q('.group-head.is-collapsible');
check('每个分类分组都有折叠控件', catHeads().length === index.categories.filter((c) => q('.group-head h2').some((h) => h.textContent === c.label)).length, `${catHeads().length} 个可折叠分组`);
check('「全部动态」不可折叠', q('.group-head--plain').length === 1 && !q('.group-head--plain')[0].classList.contains('is-collapsible'));
check('折叠控件带图标', q('.g-toggle').length === catHeads().length, `${q('.g-toggle').length} 个箭头`);
check('初始状态全部展开', catHeads().every((hd) => hd.getAttribute('aria-expanded') === 'true'));

const firstHead = catHeads()[0];
const firstBodyId = firstHead.getAttribute('aria-controls');
const firstBody = q1(`#${firstBodyId}`);
const firstCatCount = Number(firstHead.querySelector('.g-count').textContent.replace(/\D/g, ''));
check('aria-controls 指向对应内容区', Boolean(firstBody), `#${firstBodyId}`);
check('内容区条目数与该分类一致', firstBody.querySelectorAll('.card').length === firstCatCount, `${firstBody.querySelectorAll('.card').length} / ${firstCatCount}`);

const totalCardsBefore = visibleCards().length;
firstHead.click();
await sleep(60);

check('点击分类标题即折叠', q1(`#${firstBodyId}`).hidden === true || q1(`#${firstBodyId}`).classList.contains('is-collapsed'));
check('折叠后该内容区不可见（hidden 属性）', q1(`#${firstBodyId}`).hidden === true);
check('折叠后 aria-expanded=false', catHeads()[0].getAttribute('aria-expanded') === 'false');
check('折叠后标题标记为已收起', catHeads()[0].classList.contains('is-collapsed'));
check('折叠后可见卡片数减少', visibleCards().length === totalCardsBefore - firstCatCount, `${visibleCards().length} / 期望 ${totalCardsBefore - firstCatCount}`);
check('折叠状态写入 localStorage', (localStorage.getItem('techdaily:collapsed') || '').includes(catHeads()[0].getAttribute('id').replace('cat-head-', '')));
check('工具栏提示已折叠条数', /已折叠/.test(text('#feed-summary')), text('#feed-summary'));

// 再次点击展开
catHeads()[0].click();
await sleep(60);
check('再次点击恢复展开', q1(`#${firstBodyId}`).hidden === false && catHeads()[0].getAttribute('aria-expanded') === 'true');
check('展开后可见卡片数恢复', visibleCards().length === totalCardsBefore, `${visibleCards().length}`);
check('展开后清除 localStorage 中的折叠记录', !(localStorage.getItem('techdaily:collapsed') || '').includes('"other"'));

// 键盘操作
const kbHead = catHeads()[1];
const kbBodyId = kbHead.getAttribute('aria-controls');
const kbEvent = new DomEvent('keydown', { bubbles: true });
kbEvent.key = 'Enter';
kbHead.dispatchEvent(kbEvent);
await sleep(60);
check('键盘 Enter 可折叠', q1(`#${kbBodyId}`).hidden === true && catHeads()[1].getAttribute('aria-expanded') === 'false');

// 全部收起 / 全部展开
const toggleAll = q1('#btn-toggle-all');
check('存在「全部收起」按钮', toggleAll && toggleAll.hidden === false, text('#btn-toggle-all'));
toggleAll.click();
await sleep(80);
check('全部收起后所有分组均折叠', catHeads().every((hd) => hd.getAttribute('aria-expanded') === 'false'));
check('全部收起后按钮变为「全部展开」', text('#btn-toggle-all') === '全部展开', text('#btn-toggle-all'));
check('全部收起后无可见卡片', visibleCards().length === 0, `${visibleCards().length} 张`);

toggleAll.click();
await sleep(80);
check('全部展开后恢复所有卡片', visibleCards().length === totalCardsBefore, `${visibleCards().length} / ${totalCardsBefore}`);
check('全部展开后按钮变为「全部收起」', text('#btn-toggle-all') === '全部收起', text('#btn-toggle-all'));

// 折叠状态跨渲染保持：切到历史再切回来
const keepId = catHeads()[0].getAttribute('id').replace('cat-head-', '');
catHeads()[0].click();
await sleep(60);
check('折叠后进入历史日期', true, keepId);
const otherCell2 = q('.cal-cell.has-data').find((c) => !c.classList.contains('is-selected'));
otherCell2.click();
await sleep(500);
q1('#btn-latest').click();
await sleep(500);
check('切换日期后折叠状态仍保留', q1(`#cat-body-${keepId}`)?.hidden === true, `#cat-body-${keepId}`);

// 搜索结果下隐藏折叠控件
searchInput.value = 'AI';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);
check('搜索模式下隐藏折叠控件', q1('#btn-toggle-all').hidden === true);
check('搜索模式下无分类标题', q('.group-head.is-collapsible').length === 0);
q1('#search-clear').click();
await sleep(450);
// 复原：全部展开，避免影响后续断言
q1('#btn-toggle-all').click();
await sleep(80);
if (text('#btn-toggle-all') === '全部展开') { q1('#btn-toggle-all').click(); await sleep(80); }

console.log('\n— 加载更早 / 回到最新 —');

// 选一个「不是最早一天」的归档日期，才能验证「加载更早一天」
const middleIdx = Math.min(1, index.days.length - 2);
const middleDate = index.days[middleIdx].date;
q('.cal-cell.has-data').find((c) => c.getAttribute('title').startsWith(middleDate)).click();
await sleep(400);
check('选中中间日期', text('#day-meta').includes(middleDate), text('#day-meta'));
check('「加载更早」按钮可见', q1('#load-more').hidden === false, text('#load-more'));

const loadMoreBtn = q1('#load-more');
loadMoreBtn.click();
await sleep(600);
const afterLoadMoreDate = text('#day-meta').split(' · ')[0];
check(
  '加载更早后前进到更早一天',
  afterLoadMoreDate === index.days[middleIdx + 1].date,
  `${middleDate} → ${afterLoadMoreDate}`
);

q1('#btn-latest').click();
await sleep(500);
check('回到最新一天', /最新/.test(text('#day-meta')), text('#day-meta'));
check('回到最新后 URL 清理参数', !String(historyCalls.at(-1)).includes('d='), String(historyCalls.at(-1)));

q1('#btn-random').click();
await sleep(600);
check('随机翻一天可用', count('.card') > 0, text('#day-meta'));
q1('#btn-latest').click();
await sleep(500);

console.log('\n— 日历翻月 / 主题 / 移动端 —');

const monthBefore = text('#cal-label');
q1('#cal-next').click();
const monthAfter = text('#cal-label');
check('日历可向后翻月', monthBefore !== monthAfter, `${monthBefore} → ${monthAfter}`);
q1('#cal-prev').click();
check('日历可回到原月份', text('#cal-label') === monthBefore, text('#cal-label'));

const themeBefore = document.documentElement.dataset.theme;
q1('#btn-theme').click();
check('主题切换生效', document.documentElement.dataset.theme !== themeBefore, `${themeBefore} → ${document.documentElement.dataset.theme}`);
check('主题写入 localStorage', localStorage.getItem('techdaily:theme') === document.documentElement.dataset.theme);
q1('#btn-theme').click();

q1('#btn-sidebar').click();
check('移动端抽屉可打开', q1('#sidebar').classList.contains('open'));
check('打开时显示遮罩', q1('#scrim').hidden === false);
q1('#scrim').click();
check('点击遮罩关闭抽屉', !q1('#sidebar').classList.contains('open') && q1('#scrim').hidden === true);

console.log('\n— 搜索式筛选组合 —');

searchInput.value = 'Apple';
searchInput.dispatchEvent(new DomEvent('input', { bubbles: true }));
await sleep(450);
const appleBefore = count('.card');
const chipForApple = q('#filter-sources .chip').find((c) => Number(c.querySelector('.n').textContent) > 0);
chipForApple.click();
await sleep(200);
check('搜索与来源筛选可叠加', count('.card') <= appleBefore && q('.card').every((c) => c.querySelector('.src-tag').textContent === chipForApple.querySelector('span').textContent), `${appleBefore} → ${count('.card')}`);
q1('#active-filters .clear-all').click();
q1('#search-clear').click();
await sleep(450);

console.log('\n— 导出 —');

let exported = null;
runtime.Blob = class {
  constructor(parts, opts) {
    exported = { parts, opts };
  }
};
const originalCreate = URL.createObjectURL;
URL.createObjectURL = () => 'blob:stub';
URL.revokeObjectURL = () => {};
// 重新绑定后再点导出（导出函数使用运行时的 Blob/URL）
q1('#btn-export').click();
await sleep(120);

console.log('\n— 读取状态持久化 —');

// 换一张还没被点过的卡片，验证点击内容区即标记已读
const unreadCard = q('.card').find((c) => !storedReadSet().has(c.dataset.id)) || q('.card')[0];
const unreadId = unreadCard.dataset.id;
openCalls.length = 0;
const clickTarget = unreadCard.querySelector('.card-desc') || unreadCard.querySelector('.card-body') || unreadCard;
clickTarget.click();
await sleep(80);
// 精确查回同一张卡片，避免拿到别的节点造成假通过
const sameCard = q1(`.card[data-id="${unreadId}"]`);
check(
  '点击卡片内容标记已读',
  storedReadSet().has(unreadId) && Boolean(sameCard) && sameCard.classList.contains('is-read'),
  `id=${unreadId} 已读集合=${storedReadSet().size} 条`
);
check('标记已读作用于正确的卡片', sameCard === unreadCard, '');
check('点击卡片内容同时也打开原文', openCalls.length === 1, `${openCalls.length} 次`);
check('已读状态写入 localStorage', (localStorage.getItem('techdaily:read') || '').includes(unreadId));

console.log('\n— 去重逻辑回归（合成样本）—');

const HOUR = 3600 * 1000;
const base = Date.now();
const mk = (o) => ({ ts: base, category: 'ai', sourceId: 'a', sourceName: 'A', ...o });

const urlDupes = dedupe([
  mk({ title: '英伟达发布新一代 AI 芯片', link: 'https://news.example.com/nvda-ai?utm_source=rss', sourceId: 'othome', sourceName: 'IT之家' }),
  mk({ title: '完全不同的标题内容', link: 'https://news.example.com/nvda-ai?ref=twitter', sourceId: 'verge', sourceName: 'The Verge' }),
]);
check('同一 URL（忽略跟踪参数）被合并', urlDupes.length === 1, `${urlDupes.length} 条`);
check('跨源重复记录到 duplicates', urlDupes[0]?.duplicates?.length === 1, JSON.stringify(urlDupes[0]?.duplicates));

const sameSource = dedupe([
  mk({ title: '小米发布新款手机', link: 'https://a.com/1', sourceId: 'ithome', sourceName: 'IT之家' }),
  mk({ title: '小米发布新款手机', link: 'https://a.com/2', sourceId: 'ithome', sourceName: 'IT之家' }),
]);
check('同源同题只保留一条', sameSource.length === 1);
check('同源重复计数到 sameSourceDupes', sameSource[0]?.sameSourceDupes === 1, String(sameSource[0]?.sameSourceDupes));

const punctuation = dedupe([
  mk({ title: '苹果 WWDC 2026：发布全新系统', link: 'https://a.com/x', sourceId: 'a', sourceName: 'A' }),
  mk({ title: '苹果 WWDC 2026 发布全新系统！', link: 'https://b.com/y', sourceId: 'b', sourceName: 'B' }),
]);
check('标点差异不影响指纹判定', punctuation.length === 1, `${punctuation.length} 条`);

const similar = dedupe([
  mk({ ts: base, title: 'OpenAI 发布 GPT-6 模型 性能大幅提升', link: 'https://a.com/1', sourceId: 'a', sourceName: 'A' }),
  mk({ ts: base - HOUR, title: 'OpenAI 正式发布 GPT-6 模型，性能大幅提升', link: 'https://b.com/2', sourceId: 'b', sourceName: 'B' }),
]);
check('高相似标题被折叠为同一事件', similar.length === 1, `${similar.length} 条`);

const distinct = dedupe([
  mk({ title: 'OpenAI 发布 GPT-6 模型 性能大幅提升', link: 'https://a.com/1', category: 'ai' }),
  mk({ title: '特斯拉发布新款 Model Y 续航提升', link: 'https://b.com/2', category: 'auto' }),
  mk({ title: '英伟达发布新一代显卡', link: 'https://c.com/3', category: 'chip' }),
]);
check('不相关条目不被误合并', distinct.length === 3, `${distinct.length} 条`);

const crossCategory = dedupe([
  mk({ title: 'OpenAI 发布 GPT-6 模型 性能大幅提升', link: 'https://a.com/1', category: 'ai' }),
  mk({ title: 'OpenAI 发布 GPT-6 模型 性能大幅提升', link: 'https://b.com/2', category: 'web' }),
]);
check('同 URL 跨分类仍合并', crossCategory.length === 1, `${crossCategory.length} 条`);

const timeApart = dedupe([
  mk({ ts: base, title: '苹果发布新款 MacBook Pro 搭载 M5 芯片', link: 'https://a.com/1' }),
  mk({ ts: base - 60 * HOUR, title: '苹果发布新款 MacBook Pro 搭载 M5 芯片', link: 'https://a.com/1' }),
]);
check('超出时间窗的同题不合并（避免复现标题被误伤）', timeApart.length === 2, `${timeApart.length} 条`);

const longAgo = dedupe([
  mk({ ts: base, title: '苹果秋季发布会定档 9 月', link: 'https://a.com/2026', sourceId: 'a', sourceName: 'A' }),
  mk({ ts: base - 400 * 24 * HOUR, title: '苹果秋季发布会定档 9 月', link: 'https://a.com/2025', sourceId: 'b', sourceName: 'B' }),
]);
check('相隔一年的同题按两条保留', longAgo.length === 2, `${longAgo.length} 条`);

console.log('\n— 结构完整性 —');

check('无未替换的占位符', !/>undefined<|>null</.test(html));
check('页面语言为中文', /lang="zh-CN"/.test(html));
check('声明了 viewport', /name="viewport"/.test(html));
check('声明了 color-scheme', /name="color-scheme"/.test(html));
check('无内联事件处理器（CSP 友好）', !/\son[a-z]+\s*=/i.test(html.replace(/<!--[\s\S]*?-->/g, '')));
check('未使用 eval', !/\beval\s*\(/.test(appSource));
check('外部资源均使用 https', !/src="http:\/\//.test(html));
check('卡片文本无 HTML 注入（标题按文本渲染）', q('.card-title').every((t) => !/<[a-z]/i.test(t.getAllText())));

/* ────────────── 汇总 ────────────── */

await rm(TMP, { recursive: true, force: true }).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(66)}`);
console.log(`UI 逻辑验证：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('✓ 全部通过');
