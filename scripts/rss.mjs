/**
 * 极简 RSS 2.0 / Atom 1.0 / RDF 解析器
 * 不引入任何第三方依赖，只依赖 Node 内置能力，保证 GitHub Actions 上零安装开销。
 *
 * 解析结果条目字段：
 *   title, link, guid, description(纯文本), contentHtml(原始), author,
 *   publishedAt(ISO 字符串或 null), image, categories[]
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  middot: '·', times: '×', deg: '°', euro: '€', pound: '£', yen: '¥',
  laquo: '«', raquo: '»', bull: '•', dagger: '†', permil: '‰',
};

/** 解码 XML/HTML 实体（含十进制与十六进制数字实体） */
export function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function safeCodePoint(code) {
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 取出 CDATA 内容或原文 */
function unwrapCdata(raw) {
  if (raw == null) return '';
  let out = String(raw);
  let guard = 0;
  while (guard++ < 8) {
    const m = out.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (!m) break;
    out = m[1];
  }
  return out;
}

/** 提取某个标签的文本内容（取第一个匹配） */
function pickTag(xml, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(tag)}\\s*>`, 'i');
    const m = xml.match(re);
    if (m && String(m[1]).trim()) return unwrapCdata(m[1]).trim();
  }
  return '';
}

/** 提取自闭合或带属性的标签，返回其属性字典 */
function pickTagAttributes(xml, tagNames) {
  const found = [];
  for (const tag of tagNames) {
    const re = new RegExp(`<${escapeRe(tag)}(\\s[^>]*?)\\/?>`, 'gi');
    let m;
    while ((m = re.exec(xml))) found.push(parseAttributes(m[1]));
  }
  return found;
}

/** 把 <a href="x" rel="y"> 解析成属性字典 */
function parseAttributes(attrString) {
  const attrs = {};
  if (!attrString) return attrs;
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(attrString))) {
    const name = m[1].toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 HTML 压成纯文本（用于摘要与搜索）
 *
 * 关键点：不少源（IT之家、GSMArena 等）把 HTML **转义**后放进 <description>，
 * 也就是文本是 `&lt;p&gt;正文&lt;/p&gt;`。若先剥标签后解码，标签会在解码后"复活"。
 * 因此顺序固定为：解码实体 → 去除标签与脚本 → 再次解码（处理双重转义）→ 压缩空白。
 * 该函数可安全地对纯文本重复调用（幂等）。
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = decodeEntities(String(html));
  s = decodeEntities(s); // 双重转义（&amp;lt;）需要两次
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 用哨兵标记块级边界，避免相邻标签之间堆出多余空格
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\u0000');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\u0000');
  s = s.replace(/<[^>]*>/g, ' '); // 会一并吞掉 <img …> 等无闭合标签
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ');
  s = s.replace(/ *\u0000 */g, ' '); // 块级边界统一压成单个空格
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

/** 从 HTML 里挑一张有代表性的配图 */
function extractImage(rawXml, descriptionHtml) {
  const media = pickTagAttributes(rawXml, ['media:content', 'media:thumbnail']);
  for (const attrs of media) {
    const url = attrs.url || attrs.href;
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  const enclosure = pickTagAttributes(rawXml, ['enclosure', 'link']);
  for (const attrs of enclosure) {
    const url = attrs.url || attrs.href;
    const type = attrs.type || '';
    if (url && /^https?:\/\//i.test(url) && (type.startsWith('image') || /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url))) {
      return url;
    }
  }

  // 正文里的 <img>：必须先解码实体再找。
  // GSMArena 这类源把整个 HTML 转义后塞进 <description>，
  // 不解码的话看到的是 `&lt;img src=&quot;…` 而非 `<img src="…`，配图会全部丢失。
  const decoded = decodeEntities(String(descriptionHtml || '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'));
  const m = decoded.match(/<img[^>]+?src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const url = m && (m[2] || m[3] || m[4]);
  if (url && /^https?:\/\//i.test(url)) return decodeEntities(url);

  return null;
}

/** 解析 RSS/Atom 的时间字符串为 ISO 时间 */
export function parseDate(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // 纯数字时间戳（秒或毫秒）
  if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();
  if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();

  // 没有时区信息的 ISO 时间必须按 UTC 解释：
  // 否则 Date.parse 会按「构建机器所在时区」解释，同一份 feed 在 UTC 与 UTC+8 的
  // CI 上会得到相差 8 小时的结果，切日与排序都会漂移。
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(raw)) {
    const ts = Date.parse(`${raw.replace(' ', 'T')}Z`);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  }

  const direct = Date.parse(raw);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();

  // 回退：手工解析 "Wed, 30 Sep 2026 04:27:14 +0800" 之类的格式
  const m = raw.match(
    /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|[A-Z]{1,5}|UTC|GMT)?/
  );
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(m[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      let year = Number(m[3]);
      if (year < 100) year += 2000;
      let zone = m[7] || 'UTC';
      if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}T` +
        `${String(Number(m[4])).padStart(2, '0')}:${m[5]}:${m[6] || '00'}${zone === 'UTC' || zone === 'GMT' ? 'Z' : zone}`;
      const ts = Date.parse(iso);
      if (!Number.isNaN(ts)) return new Date(ts).toISOString();
    }
  }
  return null;
}

/** 把 Atom 的 link 元素们解析出「最合适」的链接 */
function pickAtomLink(entryXml) {
  const links = [];
  const re = /<link(\s[^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(entryXml))) links.push(parseAttributes(m[1]));
  if (!links.length) return '';
  const preferred =
    links.find((a) => (a.rel === 'alternate' || !a.rel) && a.type === 'text/html') ||
    links.find((a) => a.rel === 'alternate' || !a.rel) ||
    links[0];
  return preferred.href || '';
}

/** 从一段 XML 中切出所有 <item> / <entry> 块 */
function splitEntries(xml) {
  const blocks = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(xml))) blocks.push(m[2]);
  return blocks;
}

/** 清洗链接：去跟踪参数，保证可比对 */
export function normalizeUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  u = decodeEntities(u);
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    const drop = [];
    for (const key of parsed.searchParams.keys()) {
      if (/^(utm_|ref$|ref_|spm|from$|source$|share_|fbclid|gclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|at_|cmpid)/i.test(key)) {
        drop.push(key);
      }
    }
    for (const key of drop) parsed.searchParams.delete(key);
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return u.toLowerCase();
  }
}

/**
 * 解析 feed 文本
 * @returns {{title: string, siteUrl: string, description: string, items: Array}}
 */
export function parseFeed(xml, { sourceId = '', sourceName = '' } = {}) {
  if (!xml || typeof xml !== 'string') return { title: '', siteUrl: '', description: '', items: [] };

  // 去掉 BOM 与 XML 声明里的编码问题
  const doc = xml.replace(/^\uFEFF/, '');

  const isAtom = /<feed[\s>]/i.test(doc);
  const channelMatch = doc.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i);
  const head = isAtom ? doc.slice(0, Math.min(doc.length, 8000)) : (channelMatch ? channelMatch[1] : doc.slice(0, 8000));

  const title = htmlToText(pickTag(head, ['title'])) || sourceName || sourceId;
  let siteUrl = '';
  if (isAtom) {
    const links = [];
    const re = /<link(\s[^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(head))) links.push(parseAttributes(m[1]));
    siteUrl = (links.find((a) => (a.rel === 'alternate' || !a.rel)) || links[0] || {}).href || '';
  } else {
    siteUrl = pickTag(head, ['link', 'atom:link']);
  }
  const description = htmlToText(pickTag(head, ['description', 'subtitle', 'tagline'])).slice(0, 500);

  const entries = splitEntries(doc);
  const items = [];

  for (const entry of entries) {
    const rawTitle = pickTag(entry, ['title']);
    const itemTitle = htmlToText(rawTitle).replace(/\s+/g, ' ').trim();
    if (!itemTitle) continue;

    const link = normalizeUrl(isAtom ? pickAtomLink(entry) : (pickTag(entry, ['link', 'guid']) || pickAtomLink(entry)));
    const guid = htmlToText(pickTag(entry, ['guid', 'id'])).trim();

    const contentHtml = pickTag(entry, ['content:encoded', 'content', 'description', 'summary']);
    // 纯文本摘要：正文可能只由图片组成（GSMArena 就是如此），此时留空，
    // 由构建层用标题兜底，避免卡片出现空白摘要区。
    const description2 = htmlToText(contentHtml).replace(/\s+/g, ' ').trim();

    const dateRaw =
      pickTag(entry, ['pubDate', 'published', 'updated', 'dc:date', 'date', 'lastBuildDate']) || '';
    const publishedAt = parseDate(dateRaw);

    const author =
      htmlToText(pickTag(entry, ['dc:creator', 'author', 'name'])) ||
      (pickTagAttributes(entry, ['author'])[0] || {}).name ||
      '';
    const cleanAuthor = author.replace(/\s+/g, ' ').trim().slice(0, 60);

    const cats = [];
    const catRe = /<category(?:\s[^>]*)?>([\s\S]*?)<\/category\s*>/gi;
    let cm;
    while ((cm = catRe.exec(entry))) {
      const c = htmlToText(cm[1]).trim();
      if (c) cats.push(c);
    }
    const catAttrs = pickTagAttributes(entry, ['category']);
    for (const a of catAttrs) if (a.term) cats.push(a.term);

    items.push({
      title: itemTitle,
      link,
      guid: guid || link,
      description: description2,
      contentHtml: contentHtml ? unwrapCdata(contentHtml).slice(0, 20000) : '',
      author: cleanAuthor,
      publishedAt,
      dateRaw: dateRaw || null,
      image: extractImage(entry, contentHtml),
      categories: [...new Set(cats)].slice(0, 6),
      sourceId,
      sourceName: sourceName || title,
    });
  }

  return { title, siteUrl, description, items };
}
