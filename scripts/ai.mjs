/**
 * AI 每日摘要
 *
 * 设计原则：**绝不能因为摘要失败而让网站构建失败**。
 * - 有 API Key  → 调用 OpenAI 兼容接口，生成中文「今日综述 + 要点」
 * - 无 API Key  → 自动降级为规则式要点（挑重点标题），网站照常可用
 * - 调用报错    → 记录错误并降级，不影响其余流程
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY / OPENAI_API_KEY / AI_API_KEY   任一即可
 *   AI_BASE_URL   默认 https://api.deepseek.com/v1
 *   AI_MODEL      默认 deepseek-chat
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

export function resolveAiConfig(env = process.env) {
  const apiKey = env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || env.AI_API_KEY || '';
  const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  return { apiKey: apiKey.trim(), baseUrl, model, enabled: Boolean(apiKey.trim()) };
}

/** 规则式摘要：不依赖任何外部服务，作为默认与兜底 */
export function heuristicSummary({ dateLabel, items, categoryById }) {
  const groups = new Map();
  for (const item of items) {
    const id = item.category || 'other';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }

  const ranked = [...groups.entries()]
    .map(([id, list]) => ({
      id,
      label: categoryById.get(id)?.label || id,
      emoji: categoryById.get(id)?.emoji || '📰',
      list: list.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)),
    }))
    .sort((a, b) => b.list.length - a.list.length);

  const highlights = [];
  for (const g of ranked) {
    if (highlights.length >= 6) break;
    highlights.push({ label: g.label, emoji: g.emoji, texts: g.list.slice(0, 2).map((i) => i.title) });
  }

  const sources = new Set(items.map((i) => i.sourceName)).size;
  const overview =
    `${dateLabel}共聚合 ${items.length} 条科技数码动态，来自 ${sources} 个信息源，` +
    `主要集中在${ranked.slice(0, 3).map((g) => g.label).join('、') || '综合'}等方向。` +
    `（当前为规则式要点；在仓库中配置 AI_API_KEY 后将自动生成 AI 综述。）`;

  return { overview, highlights, mode: 'heuristic', generatedAt: new Date().toISOString() };
}

function buildPrompt({ dateLabel, items, categoryById }) {
  const lines = items.slice(0, 70).map((item, idx) => {
    const cat = categoryById.get(item.category)?.label || '其他';
    const desc = (item.description || '').replace(/\s+/g, ' ').slice(0, 140);
    return `${idx + 1}. [${cat}] ${item.title}${desc ? ` — ${desc}` : ''}（来源：${item.sourceName}）`;
  });

  return [
    {
      role: 'system',
      content:
        '你是一位资深科技媒体主编，负责把当天杂乱的科技资讯整理成简洁、克制、信息密度高的中文日报。' +
        '只输出严格合法的 JSON，不要输出 Markdown 代码块，不要输出任何解释性文字。',
    },
    {
      role: 'user',
      content:
        `以下是 ${dateLabel} 抓取到的科技数码资讯标题清单：\n\n${lines.join('\n')}\n\n` +
        '请输出如下 JSON 结构：\n' +
        '{\n' +
        '  "overview": "150-260字的中文综述，概括今天科技圈最值得关注的事，语气客观，不要罗列每条新闻",\n' +
        '  "highlights": [\n' +
        '    { "label": "分类名", "emoji": "单个emoji", "texts": ["要点1", "要点2"] }\n' +
        '  ]\n' +
        '}\n' +
        '要求：highlights 取 3-5 个最重要的分类；每个分类 1-3 条要点；要点必须是完整句子且包含具体的公司/产品/数字；' +
        '不要编造清单中没有的信息。',
    },
  ];
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sanitizeSummary(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object') return fallback;
  const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights
        .map((h) => ({
          label: String(h?.label || '要点').slice(0, 24),
          emoji: String(h?.emoji || '📌').slice(0, 4),
          texts: Array.isArray(h?.texts)
            ? h.texts.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
            : [],
        }))
        .filter((h) => h.texts.length)
        .slice(0, 6)
    : [];
  if (!overview && !highlights.length) return fallback;
  return {
    overview: overview || fallback.overview,
    highlights: highlights.length ? highlights : fallback.highlights,
    mode: 'ai',
    generatedAt: new Date().toISOString(),
  };
}

/** 调用 OpenAI 兼容接口生成摘要；失败时返回 null 交由调用方降级 */
export async function aiSummary({ dateLabel, items, categoryById, config, logger = console }) {
  if (!config.enabled || !items.length) return null;

  const body = {
    model: config.model,
    messages: buildPrompt({ dateLabel, items, categoryById }),
    temperature: 0.3,
    max_tokens: 1400,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn(`[ai] HTTP ${res.status}: ${text.slice(0, 300)}`);
      return null;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    if (!parsed) {
      logger.warn('[ai] 返回内容无法解析为 JSON，已降级');
      return null;
    }
    const usage = json?.usage
      ? `${json.usage.prompt_tokens}+${json.usage.completion_tokens} tokens`
      : '';
    logger.log(`[ai] ${dateLabel} 摘要生成成功 ${usage}`);
    return parsed;
  } catch (err) {
    logger.warn(`[ai] 调用失败：${err?.name === 'AbortError' ? '超时' : err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成某一天的摘要：优先 AI，失败/未配置则规则式
 * @returns {Promise<object>} 一定返回可用的摘要对象
 */
export async function buildDaySummary({ dateLabel, items, categoryById, config, logger = console }) {
  const fallback = heuristicSummary({ dateLabel, items, categoryById });
  const viaAi = await aiSummary({ dateLabel, items, categoryById, config, logger });
  return sanitizeSummary(viaAi, fallback);
}
