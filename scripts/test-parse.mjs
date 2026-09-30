/**
 * 抓取与解析层回归测试（纯函数，离线运行，无需网络）
 *
 *   node scripts/test-parse.mjs
 *
 * 重点覆盖历史真实缺陷：
 *   - 部分源把 HTML **转义**后放进 <description>，解析后标签"复活"污染摘要
 *   - 时间格式五花八门（RFC822 / ISO8601 / GMT / 时间戳）
 *   - 链接里的跟踪参数导致同一文章无法被判重
 */

import { parseFeed, parseDate, htmlToText, decodeEntities, normalizeUrl } from './rss.mjs';
import { classify, normalizeTitle, tokenize, similarity, dateKey, humanDate, truncate, shortHash } from './util.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ─────────────── htmlToText：转义 HTML 必须被剥净 ─────────────── */

console.log('\n— HTML 转纯文本 —');

const escaped = '&lt;p data-vmark="f4fd"&gt;IT之家 9 月 30 日消息，美国银行发布研报。&lt;/p&gt;&lt;p&gt;第二段内容。&lt;/p&gt;';
const fromEscaped = htmlToText(escaped);
check('转义 HTML 被剥离', !/<[a-z!/]/i.test(fromEscaped), JSON.stringify(fromEscaped.slice(0, 60)));
check('转义 HTML 保留正文', fromEscaped.includes('美国银行发布研报') && fromEscaped.includes('第二段内容'));
check('段落之间不堆叠多余空格', !/ {2,}/.test(fromEscaped));

const raw = '<p>第一段</p><p>第二段<img src="https://x.com/a.jpg"></p>';
const fromRaw = htmlToText(raw);
check('裸 HTML 被剥离', !/<[a-z!/]/i.test(fromRaw) && !fromRaw.includes('img'), JSON.stringify(fromRaw));
check('裸 HTML 保留正文', fromRaw.includes('第一段') && fromRaw.includes('第二段'));
check('去除 img 标签后不留空 src', !fromRaw.includes('x.com'));

check('双重转义被处理', !htmlToText('&amp;lt;p&amp;gt;正文&amp;lt;/p&amp;gt;').includes('<'));
check('处理幂等（重复调用结果一致）', htmlToText(htmlToText(fromEscaped)) === fromEscaped);
check('script/style 内容被丢弃', !htmlToText('<script>alert(1)</script><style>a{}</style>正文').includes('alert'));
check('HTML 注释被丢弃', !htmlToText('<!-- 注释 -->正文').includes('注释'));
check('实体被正确解码', htmlToText('&amp; &lt;tag&gt; &quot;引号&quot; &#39;单引号&#39;') === '& "引号" \'单引号\'');
check('nbsp 归一为普通空格', !htmlToText('a&nbsp;&nbsp;b').includes('\u00a0'));
check('空输入返回空串', htmlToText('') === '' && htmlToText(null) === '');
check('纯文本原样返回', htmlToText('就是一段普通中文，没有任何标签。') === '就是一段普通中文，没有任何标签。');

console.log('\n— 实体解码 —');
check('命名实体', decodeEntities('&amp;&lt;&gt;&quot;&apos;&hellip;&mdash;') === '&<>"\'\u2026\u2014');
check('十进制实体', decodeEntities('&#20013;&#25991;') === '中文');
check('十六进制实体', decodeEntities('&#x4e2d;&#x6587;') === '中文');
check('未知实体保持原样', decodeEntities('&notarealentity;') === '&notarealentity;');
check('非法码点不抛异常', typeof decodeEntities('&#x110000;') === 'string');

/* ─────────────── parseDate ─────────────── */

console.log('\n— 时间解析 —');

check('RFC822 + 时区偏移', parseDate('Wed, 30 Sep 2026 12:27:14 +0800') === '2026-09-30T04:27:14.000Z', String(parseDate('Wed, 30 Sep 2026 12:27:14 +0800')));
check('RFC822 GMT', parseDate('Tue, 29 Sep 2026 22:30:37 GMT') === '2026-09-29T22:30:37.000Z');
check('ISO 8601 带 Z', parseDate('2026-09-30T04:08:00Z') === '2026-09-30T04:08:00.000Z');
check('ISO 8601 带毫秒与偏移', parseDate('2026-09-30T12:00:00.000+08:00') === '2026-09-30T04:00:00.000Z');
check('ISO 8601 无时区（按 UTC）', parseDate('2026-09-30T04:08:00') === '2026-09-30T04:08:00.000Z');
check('十位秒级时间戳', parseDate('1790000000') === new Date(1790000000000).toISOString());
check('十三位毫秒时间戳', parseDate('1790000000000') === new Date(1790000000000).toISOString());
check('两位年份补全', String(parseDate('Wed, 30 Sep 26 12:27:14 +0800')).startsWith('2026-'));
check('空值返回 null', parseDate('') === null && parseDate(null) === null);
check('无法解析返回 null', parseDate('完全不是时间') === null);

/* ─────────────── normalizeUrl ─────────────── */

console.log('\n— 链接归一化 —');

const base = 'https://www.ithome.com/0/123/456.htm';
check('去除 utm 参数', normalizeUrl(`${base}?utm_source=rss&utm_medium=feed`) === normalizeUrl(base));
check('去除 ref / spm / fbclid', normalizeUrl(`${base}?ref=home&spm=a1.b2&fbclid=xyz`) === normalizeUrl(base));
check('去除 www 前缀', normalizeUrl('https://www.example.com/a') === normalizeUrl('https://example.com/a'));
check('去除尾部斜杠', normalizeUrl('https://example.com/a/') === normalizeUrl('https://example.com/a'));
check('去除锚点', normalizeUrl('https://example.com/a#section') === normalizeUrl('https://example.com/a'));
check('保留有意义的查询参数', normalizeUrl('https://example.com/a?id=42') !== normalizeUrl('https://example.com/a?id=43'));
check('不同域名不会混淆', normalizeUrl('https://a.com/x') !== normalizeUrl('https://b.com/x'));

/* ─────────────── parseFeed ─────────────── */

console.log('\n— Feed 解析 —');

const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>示例科技</title>
  <link>https://example.com</link>
  <description>示例频道的描述</description>
  <item>
    <title><![CDATA[英伟达发布新一代 AI 芯片 &amp; 架构]]></title>
    <link>https://example.com/a1?utm_source=rss</link>
    <guid>https://example.com/a1</guid>
    <description>&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段。&lt;/p&gt;</description>
    <pubDate>Wed, 30 Sep 2026 12:27:14 +0800</pubDate>
    <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">张三</dc:creator>
    <media:content url="https://example.com/img1.jpg" type="image/jpeg" />
    <category>芯片</category>
    <category>人工智能</category>
  </item>
  <item>
    <title>第二条：没有配图</title>
    <link>https://example.com/a2</link>
    <description>纯文本摘要</description>
    <pubDate>2026-09-30T04:08:00Z</pubDate>
  </item>
</channel></rss>`;

const rss = parseFeed(rssXml, { sourceId: 'demo', sourceName: '示例科技' });
check('RSS 频道标题解析', rss.title === '示例科技', rss.title);
check('RSS 条目数正确', rss.items.length === 2, `${rss.items.length} 条`);
check('CDATA 标题解开并解码实体', rss.items[0].title === '英伟达发布新一代 AI 芯片 & 架构', rss.items[0].title);
check('条目摘要已转纯文本', !/<[a-z!/]/i.test(rss.items[0].description), JSON.stringify(rss.items[0].description));
check('条目时间解析正确', rss.items[0].publishedAt === '2026-09-30T04:27:14.000Z', String(rss.items[0].publishedAt));
check('media:content 提取到配图', rss.items[0].image === 'https://example.com/img1.jpg', String(rss.items[0].image));
check('多个 category 全部收集', eq(rss.items[0].categories, ['芯片', '人工智能']), JSON.stringify(rss.items[0].categories));
check('作者字段解析（dc:creator）', rss.items[0].author === '张三', rss.items[0].author);
check('无配图条目 image 为 null', rss.items[1].image === null);

const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Verge</title>
  <link rel="alternate" type="text/html" href="https://www.theverge.com"/>
  <subtitle>国际科技媒体</subtitle>
  <entry>
    <title>Apple announces new MacBook Pro</title>
    <link rel="alternate" type="text/html" href="https://www.theverge.com/a1"/>
    <id>https://www.theverge.com/a1</id>
    <published>2026-09-30T00:26:57-04:00</published>
    <updated>2026-09-30T01:00:00-04:00</updated>
    <summary>A new laptop with an M5 chip.</summary>
    <author><name>Jane Doe</name></author>
  </entry>
  <entry>
    <title>Second entry</title>
    <link rel="alternate" href="https://www.theverge.com/a2"/>
    <updated>2026-09-29T22:00:00Z</updated>
    <content type="html">&lt;p&gt;正文内容&lt;/p&gt;</content>
  </entry>
</feed>`;

const atom = parseFeed(atomXml, { sourceId: 'verge', sourceName: 'The Verge' });
check('Atom 频道标题解析', atom.title === 'The Verge', atom.title);
check('Atom 条目数正确', atom.items.length === 2, `${atom.items.length} 条`);
check('Atom link[rel=alternate] 优先', atom.items[0].link === 'https://theverge.com/a1', atom.items[0].link);
check('Atom 链接做归一化（去 www 与跟踪参数）', !atom.items[0].link.includes('www.'), atom.items[0].link);
check('Atom published 时间解析', atom.items[0].publishedAt === '2026-09-30T04:26:57.000Z', String(atom.items[0].publishedAt));
check('Atom 作者解析', atom.items[0].author === 'Jane Doe', atom.items[0].author);
check('Atom 缺 published 时回退 updated', atom.items[1].publishedAt === '2026-09-29T22:00:00.000Z', String(atom.items[1].publishedAt));
check('Atom content 转纯文本', atom.items[1].description === '正文内容', atom.items[1].description);
check('Atom 频道 subtitle 解析', atom.description === '国际科技媒体', atom.description);

check('空输入不抛异常', parseFeed('').items.length === 0 && parseFeed(null).items.length === 0);
check('非 feed 文本不抛异常', parseFeed('<html><body>不是 feed</body></html>').items.length === 0);
check('残缺 XML 不抛异常', typeof parseFeed('<rss><channel><item><title>只有标题').items === 'object');
check('BOM 不影响解析', parseFeed(`\uFEFF${rssXml}`).items.length === 2);
check('无标题条目被跳过', parseFeed('<rss><channel><item><link>https://x.com/1</link></item></channel></rss>').items.length === 0);

// 回归：GSMArena 把整个 HTML 转义后塞进 <description>，配图必须能从转义标签里提取出来
const escapedImgXml = `<rss version="2.0"><channel><title>G</title>
<item>
  <title>Escaped image entry</title>
  <link>https://g.example.com/a1</link>
  <description>&lt;img src=&quot;https://g.example.com/img/a1.jpg&quot; width=&quot;184&quot; alt=&quot;&quot;&gt;</description>
  <pubDate>Wed, 30 Sep 2026 12:00:00 +0800</pubDate>
</item>
<item>
  <title>Raw image entry</title>
  <link>https://g.example.com/a2</link>
  <description><![CDATA[<img src="https://g.example.com/img/a2.jpg">]]></description>
  <pubDate>Wed, 30 Sep 2026 12:00:00 +0800</pubDate>
</item>
</channel></rss>`;
const escapedImg = parseFeed(escapedImgXml, { sourceId: 'g', sourceName: 'G' });
check('转义 HTML 里的配图能被提取', escapedImg.items[0].image === 'https://g.example.com/img/a1.jpg', String(escapedImg.items[0].image));
check('CDATA 里的配图能被提取', escapedImg.items[1].image === 'https://g.example.com/img/a2.jpg', String(escapedImg.items[1].image));
check('纯图片正文的文本摘要为空（交由构建层兜底）', escapedImg.items[0].description === '', JSON.stringify(escapedImg.items[0].description));

const rawImg = parseFeed(`<rss version="2.0"><channel><title>R</title><item>
  <title>Raw</title><link>https://r.example.com/a</link>
  <description><![CDATA[<img src="https://r.example.com/x.png">]]></description>
  <pubDate>Wed, 30 Sep 2026 12:00:00 +0800</pubDate>
</item></channel></rss>`, { sourceId: 'r', sourceName: 'R' });
check('CDATA 图片条目摘要同样为空', rawImg.items[0].description === '', JSON.stringify(rawImg.items[0].description));
check('CDATA 图片条目配图可提取', rawImg.items[0].image === 'https://r.example.com/x.png', String(rawImg.items[0].image));

/* ─────────────── 分类 ─────────────── */

console.log('\n— 分类判定 —');

const cls = (title, description = '', sourceName = '') => classify({ title, description, sourceName, categories: [] }).id;
check('芯片类命中', cls('台积电 2nm 制程良率提升') === 'chip', cls('台积电 2nm 制程良率提升'));
check('AI 类命中（中文）', cls('国产大模型发布新版本') === 'ai');
check('AI 类命中（英文，词边界）', cls('OpenAI launches a new LLM') === 'ai');
check('手机类命中', cls('小米发布新款折叠屏手机') === 'phone');
check('电脑类命中', cls('新款 MacBook Pro 评测') === 'pc');
check('游戏类命中', cls('任天堂 Switch 2 销量公布') === 'game');
check('汽车类命中', cls('比亚迪固态电池量产时间表') === 'auto');
check('安全类命中', cls('某平台被曝数据泄露漏洞') === 'security', cls('某平台被曝数据泄露漏洞'));
check('具体词优先于泛词（漏洞 > 平台）', classify({ title: '某平台被曝数据泄露漏洞', description: '', sourceName: '', categories: [] }).matched === '漏洞');
check('具体词优先于泛词（芯片 > 发布）', classify({ title: '某平台发布新款芯片', description: '', sourceName: '', categories: [] }).id === 'chip');
check('科学类命中', cls('SpaceX 星舰完成新一轮试飞') === 'science');
check('未命中归入 other', cls('今天天气不错') === 'other', cls('今天天气不错'));
check('词边界：warm 不命中 arm', cls('a warm afternoon story') === 'other', cls('a warm afternoon story'));
check('词边界：arm 单独出现才命中芯片', cls('Arm 发布新架构') === 'chip', cls('Arm 发布新架构'));
check('标题优先于摘要', cls('英伟达发布新显卡', '顺便聊聊手机') === 'chip');
check('摘要兜底分类', cls('一条没有关键词的标题', '这次更新涉及大模型的推理能力') === 'ai');
check('分类结果带展示信息', (() => {
  const c = classify({ title: '英伟达发布新显卡', description: '', sourceName: '', categories: [] });
  return Boolean(c.label && c.emoji && c.color);
})());

/* ─────────────── 文本工具 ─────────────── */

console.log('\n— 文本与日期工具 —');

check('标题归一化去标点', normalizeTitle('苹果：发布【新系统】！') === '苹果 发布 新系统', normalizeTitle('苹果：发布【新系统】！'));
check('标题归一化统一大小写', normalizeTitle('Apple WWDC') === normalizeTitle('apple wwdc'));
check('分词：中文二元组', [...tokenize('苹果手机')].includes('苹果') && [...tokenize('苹果手机')].includes('手机'));
check('分词：英文单词', [...tokenize('OpenAI GPT')].includes('openai') && [...tokenize('OpenAI GPT')].includes('gpt'));
check('相似度：相近标题接近 1', similarity(tokenize('苹果发布新款 MacBook Pro 搭载 M5 芯片'), tokenize('苹果发布新款 MacBook Pro，搭载 M5 芯片')) > 0.9);
check('相似度：同题异写超过去重阈值', similarity(tokenize('OpenAI 发布 GPT-6 模型 性能大幅提升'), tokenize('OpenAI 正式发布 GPT-6 模型，性能大幅提升')) >= 0.72);
check('相似度：连字符差异仍明显高于无关标题', similarity(tokenize('OpenAI 发布 GPT-6 模型'), tokenize('OpenAI 发布 GPT6 模型')) > 0.5);
check('相似度：多出的细节关键词会稀释分数', similarity(tokenize('英伟达 RTX 6090 显卡曝光'), tokenize('英伟达 RTX 6090 显卡曝光 性能提升 40%')) < 0.72);
check('相似度：无关标题接近 0', similarity(tokenize('苹果发布新手机'), tokenize('特斯拉降价促销')) < 0.1);
check('相似度：空集合返回 0', similarity(new Set(), tokenize('任意')) === 0);

check('UTC+8 切日：UTC 20:00 归入次日', dateKey(Date.parse('2026-09-30T20:00:00Z'), 480) === '2026-10-01', dateKey(Date.parse('2026-09-30T20:00:00Z'), 480));
check('UTC+8 切日：UTC 15:59 仍在当日', dateKey(Date.parse('2026-09-30T15:59:00Z'), 480) === '2026-09-30');
check('UTC 切日：偏移 0', dateKey(Date.parse('2026-09-30T20:00:00Z'), 0) === '2026-09-30');
check('中文日期标题含星期', /^9月30日 周三$/.test(humanDate('2026-09-30')), humanDate('2026-09-30'));
check('闰年日期正确', humanDate('2028-02-29') === '2月29日 周二', humanDate('2028-02-29'));

check('截断超长文本加省略号', truncate('一'.repeat(500), 100).length <= 101);
check('截断在标点处收尾', truncate('这是第一句话。这是第二句话。这是第三句话。', 12).endsWith('…'));
check('短文本不截断', truncate('短文本', 100) === '短文本');
check('空文本截断安全', truncate('', 10) === '' && truncate(null, 10) === '');
check('短哈希稳定且唯一', shortHash('a') === shortHash('a') && shortHash('a') !== shortHash('b'));

/* ─────────────── 汇总 ─────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(66)}`);
console.log(`解析层测试：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('✓ 全部通过');
