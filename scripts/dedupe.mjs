/**
 * 条目去重
 *
 * 三级判定，全部在同一天/同一分类的候选集内进行：
 *   1. canonical URL 完全相同            → 必然重复
 *   2. 标题指纹（去标点/空格/大小写）相同 → 必然重复
 *   3. 标题 Jaccard 相似度 ≥ 0.72        → 判定为同一事件
 *
 * 保留下来的条目会带上 duplicates（跨源同题）与 sameSourceDupes（同源重复计数），
 * 供前端展示「另 N 家媒体报道」。
 */

import { normalizeUrl } from './rss.mjs';
import { normalizeTitle, tokenize, similarity } from './util.mjs';

export const SIMILARITY_THRESHOLD = 0.72;
export const CROSS_SOURCE_WINDOW_MS = 36 * 3600 * 1000;

/** 把原始条目转成可比较的形状（也可用于测试注入的合成条目） */
export function toComparable(item) {
  return {
    canonical: item.canonical || normalizeUrl(item.link || ''),
    fingerprint: item.fingerprint || normalizeTitle(item.title || ''),
    tokens: item.tokens || tokenize(item.title || ''),
  };
}

/**
 * @param {Array<{title:string, link:string, ts:number, category:string, sourceId:string, sourceName:string}>} items
 * @returns {Array} 去重后的条目（按时间倒序），重复信息挂在保留项的 duplicates 上
 */
export function dedupe(items) {
  const sorted = items.slice().sort((a, b) => b.ts - a.ts);
  const kept = [];
  const byCanonical = new Map();
  const byFingerprint = new Map();

  /** 时间窗必须对所有判定生效：否则「苹果秋季发布会」这类复现标题会被永久折叠 */
  const inWindow = (candidate, item) => Math.abs(candidate.ts - item.ts) <= CROSS_SOURCE_WINDOW_MS;

  for (const item of sorted) {
    const c = toComparable(item);

    const urlHit = byCanonical.get(c.canonical);
    const fpHit = byFingerprint.get(c.fingerprint);
    const dupOf = (urlHit && inWindow(urlHit, item) && urlHit) || (fpHit && inWindow(fpHit, item) && fpHit) || null;

    if (dupOf) {
      recordDuplicate(dupOf, item);
      continue;
    }

    let similar = null;
    for (const candidate of kept) {
      if (candidate.category !== item.category) continue;
      if (!inWindow(candidate, item)) continue;
      const cc = toComparable(candidate);
      if (similarity(cc.tokens, c.tokens) >= SIMILARITY_THRESHOLD) {
        similar = candidate;
        break;
      }
    }
    if (similar) {
      recordDuplicate(similar, item);
      continue;
    }

    if (!urlHit) byCanonical.set(c.canonical, item);
    if (!fpHit) byFingerprint.set(c.fingerprint, item);
    kept.push(item);
  }

  return kept;
}

function recordDuplicate(target, item) {
  target.duplicates = target.duplicates || [];
  if (target.sourceId === item.sourceId) {
    target.sameSourceDupes = (target.sameSourceDupes || 0) + 1;
  } else if (target.duplicates.length < 6) {
    target.duplicates.push({ sourceName: item.sourceName, link: item.link });
  }
}
