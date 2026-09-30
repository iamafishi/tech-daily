/**
 * 样式与页面结构静态检查
 *
 *   node scripts/test-assets.mjs
 *
 * 不引入 CSS 解析器，按括号配平、变量定义/引用一致性、选择器里用到的
 * id/class 是否真实存在于 index.html / app.js 等可判定的维度做校验，
 * 拦住拼错类名、漏定义变量、漏闭合括号这类最容易出现的问题。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const css = await readFile(path.join(ROOT, 'styles.css'), 'utf8');
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const js = await readFile(path.join(ROOT, 'app.js'), 'utf8');

/* ─────────────── 基础语法 ─────────────── */

console.log('— 样式语法 —');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const clean = stripComments(css);

const open = (clean.match(/\{/g) || []).length;
const close = (clean.match(/\}/g) || []).length;
check('花括号配平', open === close, `{ ${open} } ${close}`);
check('小括号配平', (clean.match(/\(/g) || []).length === (clean.match(/\)/g) || []).length);
check('未使用制表符', !/\t/.test(css));
check('文件非空', css.length > 5000, `${(css.length / 1024).toFixed(1)} KB`);

// 逐条规则检查「属性: 值;」形状（自定义属性以 -- 开头，属合法）
let malformed = 0;
const bodyBlocks = clean.match(/\{[^{}]*\}/g) || [];
for (const block of bodyBlocks) {
  const inner = block.slice(1, -1).trim();
  if (!inner || inner.startsWith('@')) continue;
  for (const decl of inner.split(';')) {
    const d = decl.trim();
    if (!d) continue;
    if (!d.includes(':')) {
      malformed += 1;
      continue;
    }
    const [prop] = d.split(':');
    if (!/^(--[a-zA-Z0-9-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/.test(prop.trim())) malformed += 1;
  }
}
check('所有声明都是「属性: 值」形式', malformed === 0, malformed ? `${malformed} 处异常` : '');

/* ─────────────── CSS 变量 ─────────────── */

console.log('\n— 主题变量 —');

const declared = new Set([...clean.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = new Set([...clean.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
const missing = [...used].filter((v) => !declared.has(v));
check('引用的 CSS 变量都有定义', missing.length === 0, missing.join(', '));
check('定义了深浅两套主题变量', /:root\s*\{/.test(clean) && /\[data-theme='light'\]\s*\{/.test(clean));

const rootBlock = clean.match(/:root\s*\{([\s\S]*?)\}/)?.[1] || '';
const lightBlock = clean.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\}/)?.[1] || '';
const rootVars = new Set([...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const lightVars = new Set([...lightBlock.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
// 只有颜色/阴影类变量需要在浅色主题里重新定义；尺寸类（--radius、--maxw 等）是共用几何参数
const COLOR_VAR = /^--(bg|text|border|accent|shadow)/;
const lightMissing = [...rootVars].filter((v) => COLOR_VAR.test(v) && !lightVars.has(v));
check('浅色主题覆盖了全部颜色类变量', lightMissing.length === 0, lightMissing.join(', '));
check('浅色主题确实重定义了背景与文字色', lightVars.has('--bg') && lightVars.has('--text'));

const unusedVars = [...declared].filter((v) => !used.has(v) && !['--maxw'].includes(v));
check('没有明显未使用的变量', unusedVars.length <= 6, unusedVars.join(', '));

/* ─────────────── 类名一致性 ─────────────── */

console.log('\n— 类名与选择器 —');

const cssClasses = new Set();
for (const m of clean.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) cssClasses.add(m[1]);

// 页面里真实出现的类名：index.html 的 class 属性 + JS 里拼出的 class
const htmlClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && htmlClasses.add(c));
const jsClasses = new Set();
for (const m of js.matchAll(/class:\s*[`'"]([^`'"]+)[`'"]/g)) {
  m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).forEach((c) => c && !c.includes('$') && jsClasses.add(c));
}
for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\('([\w-]+)'/g)) jsClasses.add(m[1]);

const known = new Set([...htmlClasses, ...jsClasses]);
// 组合类名（如 "card is-read"）会被拆开，这里放宽为「出现在任一处即可」
const unknown = [...cssClasses].filter((c) => !known.has(c) && !js.includes(c) && !html.includes(c));
check('CSS 中的类名在页面或脚本中真实使用', unknown.length === 0, unknown.slice(0, 8).join(', '));

const idChecks = ['site-title', 'site-subtitle', 'search', 'search-clear', 'btn-theme', 'sidebar', 'btn-sidebar',
  'scrim', 'day-title', 'day-meta', 'tab-latest', 'tab-archived', 'digest', 'active-filters', 'feed',
  'load-more', 'foot-generated', 'build-meta', 'source-health', 'filter-categories', 'filter-sources',
  'cal-grid', 'cal-label', 'cal-prev', 'cal-next', 'btn-latest', 'btn-random', 'btn-export', 'toast'];
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]));
const idsNotInHtml = [...jsIds].filter((id) => !htmlIds.has(id));
check('脚本引用的元素 id 都存在于页面', idsNotInHtml.length === 0, idsNotInHtml.join(', '));
check('页面关键元素齐备', idChecks.every((id) => htmlIds.has(id)), idChecks.filter((id) => !htmlIds.has(id)).join(', '));

/* ─────────────── 响应式与可访问性 ─────────────── */

console.log('\n— 响应式与可访问性 —');

check('定义了移动端断点', /@media \(max-width:\s*900px\)/.test(clean));
check('定义了窄屏断点', /@media \(max-width:\s*560px\)/.test(clean));
check('支持 prefers-reduced-motion', /prefers-reduced-motion/.test(clean));
check('支持打印样式', /@media print/.test(clean));
check('移动端侧栏为抽屉式', /transform:\s*translateX\(-102%\)/.test(clean) || /\.sidebar\.open/.test(clean));

check('页面声明 lang', /<html lang="zh-CN"/.test(html));
check('设置了 viewport', /name="viewport"/.test(html));
check('每个按钮都有可访问名称', (() => {
  const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)];
  return buttons.every(([, attrs, inner]) => /aria-label=/.test(attrs) || inner.replace(/<[^>]+>/g, '').trim().length > 0);
})());
check('存在跳到正文链接', /class="skip-link"/.test(html) && /id="feed"/.test(html));
check('列表区域声明 aria-live', /aria-live="polite"/.test(html));
check('日历格子可键盘操作', /setAttribute\('tabindex', '0'\)/.test(js) && /keydown/.test(js));
check('深色为默认主题', /data-theme="dark"/.test(html) && /:root\s*\{/.test(clean));
check('声明 color-scheme', /name="color-scheme"/.test(html));

/* ─────────────── 安全 ─────────────── */

console.log('\n— 安全 —');

check('未使用 eval', !/\beval\s*\(/.test(js));
check('未使用 new Function', !/new Function\s*\(/.test(js));
check('未使用 document.write', !/document\.write/.test(js));
check('所有外链带 noopener', (() => {
  const targets = [...js.matchAll(/target:\s*'_blank'/g)].length;
  const noopeners = [...js.matchAll(/rel:\s*'noopener noreferrer'/g)].length;
  return targets > 0 && noopeners >= targets;
})());
check('仅高亮处使用 innerHTML 且经过转义', (() => {
  const uses = [...js.matchAll(/html:\s*([^,\n]+)/g)].map((m) => m[1]);
  // 允许 highlight(...) 与静态模板，禁止直接拼 item.title / item.description
  return uses.every((u) => !/item\.(title|description)\b(?!\s*,\s*query)/.test(u) || /highlight\(/.test(u));
})());
check('外部链接均为 https', !/(?:href|src)="http:\/\//.test(html));

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(66)}`);
console.log(`样式与结构检查：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('✓ 全部通过');
