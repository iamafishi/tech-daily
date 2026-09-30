/**
 * 产物自检：验证 index.json / days/*.json / search.json 的结构与一致性。
 *   node scripts/check.mjs
 * 退出码非 0 表示数据不健康（CI 可用）。
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);
const note = (m) => notes.push(m);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    fail(`无法读取 ${path.relative(ROOT, file)}：${err.message}`);
    return null;
  }
}

const index = await readJson(path.join(DATA, 'index.json'));
if (!index) {
  console.log('✗ data/index.json 缺失或损坏，请先执行 npm run build');
  process.exit(1);
}

// 基础字段
for (const field of ['generatedAt', 'totals', 'categories', 'sources', 'days']) {
  if (!(field in index)) fail(`index.json 缺少字段 ${field}`);
}
if (!Array.isArray(index.days) || !index.days.length) fail('index.json 的 days 为空');

// 日期格式与排序
let prev = '9999-99-99';
for (const d of index.days || []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) fail(`非法日期格式：${d.date}`);
  if (d.date > prev) fail(`days 未按时间倒序：${d.date} 出现在 ${prev} 之后`);
  prev = d.date;
  if (!d.itemCount) fail(`${d.date} 的 itemCount 为 0`);
}

// 每日文件
const dayFiles = existsSync(path.join(DATA, 'days'))
  ? (await readdir(path.join(DATA, 'days'))).filter((f) => f.endsWith('.json'))
  : [];
if (dayFiles.length !== (index.days || []).length) {
  fail(`days/ 目录文件数 ${dayFiles.length} 与索引天数 ${(index.days || []).length} 不一致`);
}

const ids = new Set();
let totalItems = 0;
let withImage = 0;
let withDesc = 0;
let aiDays = 0;

for (const entry of index.days || []) {
  const file = path.join(DATA, 'days', `${entry.date}.json`);
  const day = await readJson(file);
  if (!day) continue;

  if (day.date !== entry.date) fail(`${entry.date}.json 内部日期为 ${day.date}`);
  if (!Array.isArray(day.items) || !day.items.length) {
    fail(`${entry.date}.json 没有条目`);
    continue;
  }
  if (day.items.length !== entry.itemCount) {
    fail(`${entry.date}.json 条目数 ${day.items.length} 与索引 ${entry.itemCount} 不一致`);
  }
  if (!day.summary || !day.summary.overview) fail(`${entry.date}.json 缺少 summary.overview`);
  if (day.summary?.mode === 'ai') aiDays += 1;

  for (const it of day.items) {
    totalItems += 1;
    if (!it.title) fail(`${entry.date} 存在无标题条目`);
    if (!/^https?:\/\//.test(it.link || '')) fail(`${entry.date} 存在非法链接：${it.link}`);
    if (!it.category) fail(`${entry.date} 条目缺少分类：${it.title}`);
    if (!it.publishedAt || Number.isNaN(Date.parse(it.publishedAt))) {
      fail(`${entry.date} 条目时间非法：${it.title}`);
    }
    if (it.image) withImage += 1;
    if (it.description) withDesc += 1;
    if (ids.has(it.id)) fail(`条目 id 重复：${it.id}`);
    ids.add(it.id);
  }
}

// 搜索索引
const search = await readJson(path.join(DATA, 'search.json'));
if (!search) {
  fail('search.json 缺失');
} else {
  if (!Array.isArray(search.items)) fail('search.json 的 items 不是数组');
  else if (search.items.length !== search.total) {
    fail(`search.json 实际 ${search.items.length} 条与 total ${search.total} 不一致`);
  }
  const bad = (search.items || []).filter((i) => !i.t || !i.u);
  if (bad.length) fail(`search.json 有 ${bad.length} 条缺少标题或链接`);
}

// 数据新鲜度
const ageHours = (Date.now() - Date.parse(index.generatedAt)) / 3600000;
if (Number.isNaN(ageHours)) fail(`generatedAt 非法：${index.generatedAt}`);
else if (ageHours > 48) note(`⚠ 数据已 ${ageHours.toFixed(1)} 小时未更新，请检查定时任务`);

const okSources = (index.sources || []).filter((s) => s.ok).length;
const totalSources = (index.sources || []).length;
if (totalSources && okSources / totalSources < 0.5) {
  note(`⚠ 仅 ${okSources}/${totalSources} 个源可用，可能被限流或需要更换地址`);
}

console.log('─'.repeat(60));
console.log(`生成时间      ${index.generatedAt}（${ageHours.toFixed(2)} 小时前）`);
console.log(`归档天数      ${(index.days || []).length}`);
console.log(`条目总数      ${totalItems}`);
console.log(`唯一条目 id   ${ids.size}`);
console.log(`含摘要比例    ${totalItems ? ((withDesc / totalItems) * 100).toFixed(1) : 0}%`);
console.log(`含配图比例    ${totalItems ? ((withImage / totalItems) * 100).toFixed(1) : 0}%`);
console.log(`AI 摘要天数   ${aiDays}`);
console.log(`搜索索引      ${search?.total || 0} 条`);
console.log(`数据源健康    ${okSources}/${totalSources}`);
console.log(`构建耗时      ${(index.buildMs / 1000).toFixed(1)}s`);
console.log('─'.repeat(60));

for (const n of notes) console.log(n);

if (problems.length) {
  console.log(`\n✗ 发现 ${problems.length} 个问题：`);
  for (const p of problems.slice(0, 40)) console.log(`  - ${p}`);
  if (problems.length > 40) console.log(`  ... 其余 ${problems.length - 40} 个已省略`);
  process.exit(1);
}

console.log('\n✓ 数据自检通过');
