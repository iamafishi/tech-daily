/**
 * tech-daily 构建脚本（零第三方依赖）
 *
 * 流程：
 *   1. 并发抓取所有启用的 RSS/Atom 源（带超时、UA、重试）
 *   2. 解析 → 时间归一化 → 窗口过滤 → 分类 → 落源配额
 *   3. 去重合并（同 URL / 同标题指纹 / 标题高相似）
 *   4. 按展示时区切分「每日快照」，与历史归档合并（历史优先，保留已生成的摘要）
 *   5. 生成当日 AI 摘要（无 Key 自动降级为规则要点）
 *   6. 输出 data/*.json 供纯静态前端消费
 *
 * 用法：
 *   node scripts/build.mjs                 正常构建
 *   node scripts/build.mjs --with-summary  强制重算所有窗口内日期的摘要
 *   node scripts/build.mjs --only=ithome,sspai   只抓指定源（调试用）
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as BUILD_CONFIG, sources, categories, fallbackCategory, categoryGroups } from '../config/sources.mjs';
import { parseFeed, normalizeUrl } from './rss.mjs';
import { classify, normalizeTitle, tokenize, shortHash, dateKey, humanDate, truncate } from './util.mjs';
import { dedupe } from './dedupe.mjs';
import { resolveAiConfig, buildDaySummary, heuristicSummary } from './ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');

const args = process.argv.slice(2);
/**
 * 强制重算所有日期的摘要。
 *
 * 必须用真值判断而不是「环境变量存在即真」：workflow_dispatch 的 boolean 未勾选时
 * 传入的是字符串 "false"，定时触发时更可能是空字符串。若按存在性判断，
 * 每天都会把所有归档的摘要重算一遍，白白消耗 token。
 */
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const FORCE_SUMMARY = args.includes('--with-summary') || truthy(process.env.FORCE_SUMMARY);
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY_IDS = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;

const TZ = BUILD_CONFIG.timezoneOffsetMinutes;
const NOW = Date.now();
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

const CATEGORY_BY_ID = new Map([...categories, fallbackCategory].map((c) => [c.id, c]));
const SOURCE_BY_ID = new Map(sources.map((s) => [s.id, s]));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ' +
  'TechDailyBot/1.0 (+https://github.com/)';

/* ------------------------------------------------------------------ */
/* 1. 抓取                                                             */
/* ------------------------------------------------------------------ */

async function fetchText(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILD_CONFIG.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Date.now() - started, ctype: res.headers.get('content-type') || '' };
  } catch (err) {
    if (attempt < 2) {
      await sleep(800);
      return fetchText(url, attempt + 1);
    }
    return { ok: false, status: 0, text: '', ms: Date.now() - started, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPool(items, worker, concurrency = BUILD_CONFIG.concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { error: String(err?.message || err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectFromSource(source) {
  const { ok, status, text, ms, error, ctype } = await fetchText(source.url);
  const base = {
    id: source.id,
    name: source.name,
    url: source.url,
    ms,
    httpStatus: status,
  };

  if (!ok || !text) {
    warn(`  ✗ ${source.name} 抓取失败（${error || `HTTP ${status}`}）`);
    return { ...base, ok: false, itemCount: 0, items: [], error: error || `HTTP ${status}` };
  }

  const looksLikeFeed = /<rss|<feed|<rdf:RDF|<channel/i.test(text.slice(0, 4000));
  if (!looksLikeFeed) {
    warn(`  ✗ ${source.name} 返回的不是 feed（${ctype}）`);
    return { ...base, ok: false, itemCount: 0, items: [], error: `not a feed (${ctype})` };
  }

  const parsed = parseFeed(text, { sourceId: source.id, sourceName: source.name });
  if (!parsed.items.length) {
    warn(`  ✗ ${source.name} feed 可解析但 0 条内容`);
    return { ...base, ok: false, itemCount: 0, items: [], error: 'empty feed', title: parsed.title };
  }

  const items = parsed.items
    .map((raw) => normalizeItem(raw, source))
    .filter(Boolean);

  log(`  ✓ ${source.name.padEnd(18)} ${String(items.length).padStart(3)} 条  ${String(ms).padStart(5)}ms`);
  return { ...base, ok: true, itemCount: items.length, items, title: parsed.title, siteUrl: parsed.siteUrl };
}

function normalizeItem(raw, source) {
  const link = raw.link && /^https?:\/\//i.test(raw.link) ? raw.link : normalizeUrl(raw.link);
  if (!link || !/^https?:\/\//i.test(link)) return null;

  let ts = raw.publishedAt ? Date.parse(raw.publishedAt) : NaN;
  if (Number.isNaN(ts)) {
    if (BUILD_CONFIG.dropUndatedItems) return null;
    ts = NOW;
  }
  // 未来时间（源上常见的时区错误）夹到当前时间
  if (ts > NOW + 6 * 3600 * 1000) ts = NOW;
  // 早于窗口的直接丢弃
  if (ts < NOW - BUILD_CONFIG.windowHours * 3600 * 1000) return null;

  const title = raw.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length < 4) return null;

  const cat = classify({
    title,
    description: raw.description,
    sourceName: source.name,
    categories: raw.categories,
  });

  const fingerprint = normalizeTitle(title);
  const canonical = normalizeUrl(link);

  // 有些源（如 GSMArena）的 <description> 只有一张图、没有文字，
  // 此时用标题兜底，保证卡片信息区不为空。
  const body = raw.description && raw.description.trim() ? raw.description : `来源：${source.name} — ${title}`;

  return {
    id: shortHash(`${canonical}|${fingerprint}`),
    title,
    link,
    canonical,
    fingerprint,
    tokens: tokenize(title),
    sourceId: source.id,
    sourceName: source.name,
    sourceLang: source.lang || 'en',
    sourceGroup: source.group || 'intl',
    author: raw.author || '',
    description: truncate(body, 300),
    image: raw.image || null,
    publishedAt: new Date(ts).toISOString(),
    ts,
    category: cat.id,
    categoryLabel: cat.label,
    categoryEmoji: cat.emoji,
    categoryColor: cat.color,
    matchedKeyword: cat.matched,
    feedCategories: raw.categories || [],
  };
}

/* ------------------------------------------------------------------ */
/* 2. 去重（实现见 scripts/dedupe.mjs，便于单独回归测试）              */
/* ------------------------------------------------------------------ */

/** 每个源在每个分类每天的上限，避免单一高频源刷屏 */
function applySourceQuota(items) {
  const counters = new Map();
  const out = [];
  for (const item of items.slice().sort((a, b) => b.ts - a.ts)) {
    const day = dateKey(item.ts, TZ);
    const key = `${day}|${item.sourceId}|${item.category}`;
    const used = counters.get(key) || 0;
    if (used >= BUILD_CONFIG.perSourceLimit) continue;
    counters.set(key, used + 1);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. 归档合并                                                         */
/* ------------------------------------------------------------------ */

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toPublicItem(item, dayKey) {
  return {
    id: item.id,
    title: item.title,
    link: item.link,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    sourceLang: item.sourceLang,
    sourceGroup: item.sourceGroup,
    author: item.author || '',
    category: item.category,
    description: item.description,
    image: item.image,
    publishedAt: item.publishedAt,
    day: dayKey,
    duplicates: item.duplicates || [],
    sameSourceDupes: item.sameSourceDupes || 0,
  };
}

async function loadExistingDays() {
  const index = await readJson(path.join(DATA_DIR, 'index.json'));
  const days = new Map();
  if (!existsSync(DAYS_DIR)) return { days, previous: index };
  const files = (await readdir(DAYS_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  await runPool(
    files,
    async (file) => {
      const key = file.replace('.json', '');
      const data = await readJson(path.join(DAYS_DIR, file));
      if (data && Array.isArray(data.items)) days.set(key, data);
    },
    8
  );
  return { days, previous: index };
}

/* ------------------------------------------------------------------ */
/* 4. 主流程                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  log('━'.repeat(70));
  log(`tech-daily 构建开始  ${new Date(NOW).toISOString()}  (时区 UTC+${TZ / 60})`);
  log('━'.repeat(70));

  const activeSources = sources.filter((s) => s.enabled !== false && (!ONLY_IDS || ONLY_IDS.includes(s.id)));
  log(`\n[1/6] 抓取 ${activeSources.length} 个信息源（并发 ${BUILD_CONFIG.concurrency}，超时 ${BUILD_CONFIG.timeoutMs}ms）`);
  const sourceResults = await runPool(activeSources, collectFromSource, BUILD_CONFIG.concurrency);

  const allItems = [];
  for (const r of sourceResults) if (r && r.items) allItems.push(...r.items);
  log(`\n      原始条目 ${allItems.length} 条，来自 ${sourceResults.filter((r) => r?.ok).length} 个可用源`);

  log(`\n[2/6] 去重合并`);
  const deduped = dedupe(allItems);
  log(`      去重后 ${deduped.length} 条（折叠 ${allItems.length - deduped.length} 条重复）`);

  log(`\n[3/6] 应用单源配额（每源每分类每天 ≤ ${BUILD_CONFIG.perSourceLimit}）`);
  const quotaed = applySourceQuota(deduped);
  log(`      配额后 ${quotaed.length} 条`);

  log(`\n[4/6] 与历史归档合并（保留 ${BUILD_CONFIG.retentionDays} 天）`);
  const { days: existingDays } = await loadExistingDays();
  log(`      已存在 ${existingDays.size} 个历史快照`);

  // 按天分组
  const freshByDay = new Map();
  for (const item of quotaed) {
    const key = dateKey(item.ts, TZ);
    if (!freshByDay.has(key)) freshByDay.set(key, []);
    freshByDay.get(key).push(item);
  }

  const cutoffKey = dateKey(NOW - BUILD_CONFIG.retentionDays * 86400000, TZ);
  const allDayKeys = new Set([...existingDays.keys(), ...freshByDay.keys()]);
  const keepKeys = [...allDayKeys].filter((k) => k >= cutoffKey).sort().reverse();

  const aiConfig = resolveAiConfig();
  if (aiConfig.enabled) {
    log(`      AI 摘要已启用：${aiConfig.model} @ ${aiConfig.baseUrl}`);
  } else {
    log('      AI 摘要未配置（未检测到 AI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY），使用规则式要点');
  }
  log(
    FORCE_SUMMARY
      ? '      摘要模式：强制重算全部归档日期'
      : '      摘要模式：仅新增内容生成，已有摘要复用缓存（加 --with-summary 可强制重算）'
  );

  log(`\n[5/6] 写入每日快照`);
  const dayIndexEntries = [];
  const searchItems = [];
  const freshDayKeys = [...freshByDay.keys()].sort().reverse();
  const latestFreshDay = freshDayKeys[0] || null;
  const summaryWindow = new Set(freshDayKeys.slice(0, 3));

  for (const key of keepKeys) {
    const fresh = (freshByDay.get(key) || []).map((i) => toPublicItem(i, key));
    const existing = existingDays.get(key);
    let items;

    if (existing && key !== latestFreshDay) {
      // 历史日期：以已归档内容为准，避免重复条目与摘要丢失
      items = existing.items;
    } else if (existing) {
      // 最新一天：新旧合并，按 id 去重
      const seen = new Set();
      items = [];
      for (const it of [...fresh, ...existing.items]) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    } else {
      items = fresh;
    }

    items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (!items.length) continue;

    const label = humanDate(key);
    const byCat = new Map();
    for (const it of items) byCat.set(it.category, (byCat.get(it.category) || 0) + 1);

    const categoryStats = [...byCat.entries()]
      .map(([id, count]) => ({
        id,
        count,
        label: CATEGORY_BY_ID.get(id)?.label || id,
        emoji: CATEGORY_BY_ID.get(id)?.emoji || '📰',
        color: CATEGORY_BY_ID.get(id)?.color || '#64748b',
      }))
      .sort((a, b) => b.count - a.count);

    const sourceStats = [...new Set(items.map((i) => i.sourceId))]
      .map((id) => ({
        id,
        name: SOURCE_BY_ID.get(id)?.name || items.find((i) => i.sourceId === id)?.sourceName || id,
        lang: SOURCE_BY_ID.get(id)?.lang || 'en',
        count: items.filter((i) => i.sourceId === id).length,
      }))
      .sort((a, b) => b.count - a.count);

    // 摘要：历史有 AI 摘要就保留，否则按需生成
    let summary = existing?.summary || null;
    const needSummary =
      FORCE_SUMMARY ||
      !summary ||
      (summaryWindow.has(key) && summary.mode !== 'ai' && aiConfig.enabled);
    if (needSummary) {
      summary = await buildDaySummary({
        dateLabel: `${key}（${label}）`,
        items,
        categoryById: CATEGORY_BY_ID,
        config: aiConfig,
      });
    }

    const dayFile = {
      date: key,
      label,
      generatedAt: new Date().toISOString(),
      itemCount: items.length,
      summary,
      categoryStats,
      sourceStats,
      items,
    };
    await writeJson(path.join(DAYS_DIR, `${key}.json`), dayFile);

    dayIndexEntries.push({
      date: key,
      label,
      itemCount: items.length,
      aiSummary: summary?.mode === 'ai',
      topCategories: categoryStats.slice(0, 4).map((c) => c.id),
    });

    for (const it of items) {
      searchItems.push({
        id: it.id,
        t: it.title,
        u: it.link,
        s: it.sourceName,
        c: it.category,
        d: it.day,
        p: it.publishedAt,
        // 摘要只用于搜索匹配与结果预览，截短可显著缩小索引体积
        x: it.description ? it.description.slice(0, 110) : '',
      });
    }

    const modeTag = summary?.mode === 'ai' ? 'AI 摘要' : '规则要点';
    log(`      ${key}  ${String(items.length).padStart(4)} 条  ${modeTag}`);
  }

  // 清理超期归档
  const removed = [];
  if (existsSync(DAYS_DIR)) {
    for (const file of await readdir(DAYS_DIR)) {
      const key = file.replace('.json', '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && !keepKeys.includes(key)) {
        await rm(path.join(DAYS_DIR, file), { force: true });
        removed.push(key);
      }
    }
  }
  if (removed.length) log(`      清理超期快照 ${removed.length} 个：${removed.join(', ')}`);

  log(`\n[6/6] 生成索引`);
  dayIndexEntries.sort((a, b) => (a.date < b.date ? 1 : -1));

  const sourceHealth = sourceResults
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      lang: SOURCE_BY_ID.get(r.id)?.lang || 'en',
      group: SOURCE_BY_ID.get(r.id)?.group || 'intl',
      ok: Boolean(r.ok),
      itemCount: r.itemCount || 0,
      ms: r.ms || 0,
      httpStatus: r.httpStatus || 0,
      error: r.error || null,
    }))
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name, 'zh'));

  const totalItems = dayIndexEntries.reduce((sum, d) => sum + d.itemCount, 0);

  const indexFile = {
    generatedAt: new Date().toISOString(),
    timezoneOffsetMinutes: TZ,
    buildMs: Date.now() - startedAt,
    windowHours: BUILD_CONFIG.windowHours,
    site: {
      title: '科技数码日报',
      subtitle: '每日自动聚合中英科技数码圈资讯',
    },
    totals: {
      items: totalItems,
      days: dayIndexEntries.length,
      sources: sourceHealth.length,
      sourcesOk: sourceHealth.filter((s) => s.ok).length,
      freshItems: quotaed.length,
    },
    categories: [...categories, fallbackCategory].map((c) => ({
      id: c.id,
      label: c.label,
      emoji: c.emoji,
      color: c.color,
    })),
    categoryGroups,
    sources: sourceHealth,
    days: dayIndexEntries,
  };

  searchItems.sort((a, b) => (a.p < b.p ? 1 : -1));
  const searchFile = {
    generatedAt: indexFile.generatedAt,
    limit: BUILD_CONFIG.searchIndexLimit,
    total: Math.min(searchItems.length, BUILD_CONFIG.searchIndexLimit),
    items: searchItems.slice(0, BUILD_CONFIG.searchIndexLimit),
  };

  await writeJson(path.join(DATA_DIR, 'index.json'), indexFile);
  await writeJson(path.join(DATA_DIR, 'search.json'), searchFile);

  log(`\n      索引：${dayIndexEntries.length} 天 / ${totalItems} 条 / 搜索索引 ${searchFile.total} 条`);
  log(`      数据源健康度：${sourceHealth.filter((s) => s.ok).length}/${sourceHealth.length} 可用`);
  const failed = sourceHealth.filter((s) => !s.ok);
  if (failed.length) {
    log(`      失败源：${failed.map((s) => `${s.name}(${s.error})`).join('、')}`);
  }
  log('━'.repeat(70));
  log(`构建完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  log('━'.repeat(70));

  // 让 CI 能感知「全军覆没」这种异常
  if (!dayIndexEntries.length) {
    warn('警告：没有任何可用数据，构建结果为空');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('构建失败：', err);
  process.exit(1);
});
