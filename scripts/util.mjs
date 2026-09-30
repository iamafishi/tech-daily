/**
 * 分类判定、去重指纹、时区日期等纯函数工具
 */

import { categories, fallbackCategory } from '../config/sources.mjs';

const COMPILED = categories.map((cat) => ({
  ...cat,
  patterns: cat.keywords.map((k) => ({ raw: k, re: buildKeywordRe(k) })),
}));

/**
 * 全局关键词表，分两轮匹配：
 *   第 1 轮 只试「具体词」（长度 ≥ 4 的长短语，如「数据泄露」「半导体」）
 *   第 2 轮 才试短词/泛词（如「平台」「芯片」）
 *
 * 为什么需要分轮：只按长度排序不足以解决冲突 —— 「平台」（互联网商业）与
 * 「漏洞」（安全隐私）都是 2 字，仍会由分类顺序决定胜负，导致
 * 「某平台被曝数据泄露漏洞」被误判为互联网商业。
 * 因此排序键为：轮次 → 关键词长度（越长越具体）→ 分类 priority（数字小优先）
 * → 配置顺序（稳定兜底）。priority 在 config/sources.mjs 里显式声明。
 */
const ALL_PATTERNS = [];
COMPILED.forEach((cat, catIndex) => {
  const priority = Number.isFinite(cat.priority) ? cat.priority : catIndex;
  cat.patterns.forEach((p, kwIndex) => {
    const weight = p.raw.trim().length;
    ALL_PATTERNS.push({
      cat,
      raw: p.raw,
      re: p.re,
      weight,
      tier: weight >= 4 ? 0 : 1,
      priority,
      catIndex,
      kwIndex,
    });
  });
});
ALL_PATTERNS.sort(
  (a, b) =>
    a.tier - b.tier ||
    b.weight - a.weight ||
    a.priority - b.priority ||
    a.catIndex - b.catIndex ||
    a.kwIndex - b.kwIndex
);

/**
 * 关键词匹配规则：
 * - 含空格或含点的英文短语 → 单词边界匹配
 * - 纯 ASCII 词 → 单词边界匹配（避免 "arm" 命中 "warm"）
 * - 中文（非 ASCII）→ 直接子串匹配
 */
function buildKeywordRe(keyword) {
  const k = keyword.trim();
  const isAscii = /^[\x20-\x7e]+$/.test(k);
  if (!isAscii) return new RegExp(escapeRe(k), 'i');
  const escaped = escapeRe(k).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstMatch(haystack) {
  if (!haystack) return null;
  for (const p of ALL_PATTERNS) {
    if (p.re.test(haystack)) return p;
  }
  return null;
}

/**
 * 判定条目分类
 *
 * 先看标题（更能代表主题），标题无命中再用摘要兜底。
 * @param {{title:string, description:string, sourceName:string, categories:string[]}} item
 * @returns {{id:string,label:string,emoji:string,color:string,matched:string|null}}
 */
export function classify(item) {
  const title = item.title || '';
  const body = `${item.description || ''} ${(item.categories || []).join(' ')}`;

  const hit = firstMatch(title) || firstMatch(body);
  if (hit) {
    return {
      id: hit.cat.id,
      label: hit.cat.label,
      emoji: hit.cat.emoji,
      color: hit.cat.color,
      matched: hit.raw,
    };
  }
  return { ...fallbackCategory, matched: null };
}

/** 标题归一化：去标点、去空白、统一大小写，用于指纹比对 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d"'`]/g, '')
    .replace(/[【】\[\]（）()<>《》「」『』:：,，.。!！?？;；、|/\\~—\-_*+#@&…·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中英混合分词：拉丁词按空格切，中文字符按二元组切 */
export function tokenize(title) {
  const norm = normalizeTitle(title);
  const tokens = new Set();
  for (const word of norm.split(' ')) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length > 1) tokens.add(word);
    } else {
      const cjk = word.replace(/[^\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '');
      const latin = word.replace(/[^\x00-\x7f]/g, '');
      if (latin.length > 1) tokens.add(latin);
      for (let i = 0; i < cjk.length; i += 1) {
        if (cjk.length === 1) tokens.add(cjk[i]);
        else if (i + 2 <= cjk.length) tokens.add(cjk.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

/** Jaccard 相似度 */
export function similarity(a, b) {
  const sa = a instanceof Set ? a : tokenize(a);
  const sb = b instanceof Set ? b : tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (large.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 稳定短哈希（用于生成条目 id） */
export function shortHash(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

/** 在固定时区偏移下，把时间戳转成 YYYY-MM-DD */
export function dateKey(ts, offsetMinutes = 480) {
  const shifted = new Date(ts + offsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** 在固定时区偏移下，把时间戳转成 "YYYY-MM-DD HH:mm" */
export function dateTimeLabel(ts, offsetMinutes = 480) {
  const d = new Date(ts + offsetMinutes * 60000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

/** 中文可读的日期标题：9月30日 周三 */
export function humanDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getUTCDay()];
  return `${m}月${d}日 ${week}`;
}

/** 截断文本到指定长度，尽量不在词中断开 */
export function truncate(text, max = 220) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const lastCjkPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'));
  const boundary = Math.max(lastSpace, lastCjkPunct);
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
}
