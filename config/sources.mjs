/**
 * tech-daily 数据源与分类配置
 *
 * 想增删信息源，只改下面的 sources 数组即可；抓取器不依赖第三方库。
 * 每个源可选字段：
 *   id        唯一标识（英文，会出现在筛选器里）
 *   name      展示名
 *   url       RSS / Atom 地址
 *   lang      'zh' | 'en'，用于前端分组
 *   group     'cn' | 'intl'，中文源 / 国际源
 *   category  固定分类（留空则由关键词自动判断），用于科技媒体之外的专业源
 *   enabled   设为 false 临时停用
 */

export const build = {
  /** 展示时区偏移（分钟），480 = UTC+8 北京 */
  timezoneOffsetMinutes: 480,
  /** 抓取窗口：只保留最近这么多小时的文章 */
  windowHours: 72,
  /** 每日快照保留天数（用于日历归档） */
  retentionDays: 180,
  /** 单次抓取并发数 */
  concurrency: 8,
  /** 单个源超时（毫秒） */
  timeoutMs: 20000,
  /** 同一分类下，每个源每天最多收录多少条 */
  perSourceLimit: 25,
  /** 搜索索引最多收录多少条 */
  searchIndexLimit: 6000,
  /** RSS 里没有时间信息时的回退（不参与「今日」判断，仅归档） */
  dropUndatedItems: true,
};

export const sources = [
  // ---------------- 中文科技数码 ----------------
  { id: 'ithome', name: 'IT之家', url: 'https://www.ithome.com/rss/', lang: 'zh', group: 'cn' },
  { id: 'cnbeta', name: 'cnBeta', url: 'https://www.cnbeta.com.tw/backend.php', lang: 'zh', group: 'cn' },
  { id: 'ifanr', name: '爱范儿', url: 'https://www.ifanr.com/feed', lang: 'zh', group: 'cn' },
  { id: 'sspai', name: '少数派', url: 'https://sspai.com/feed', lang: 'zh', group: 'cn' },
  { id: 'solidot', name: 'Solidot 奇客', url: 'https://www.solidot.org/index.rss', lang: 'zh', group: 'cn' },

  // ---------------- 国际综合科技 ----------------
  { id: 'theverge', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', lang: 'en', group: 'intl' },
  { id: 'engadget', name: 'Engadget', url: 'https://www.engadget.com/rss.xml', lang: 'en', group: 'intl' },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', lang: 'en', group: 'intl' },
  { id: 'arstechnica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', lang: 'en', group: 'intl' },
  { id: 'wired', name: 'WIRED', url: 'https://www.wired.com/feed/rss', lang: 'en', group: 'intl' },
  { id: 'hackernews', name: 'Hacker News', url: 'https://hnrss.org/frontpage', lang: 'en', group: 'intl' },

  // ---------------- 手机 / 消费电子 ----------------
  { id: 'gsmarena', name: 'GSMArena', url: 'https://www.gsmarena.com/rss-news-reviews.php3', lang: 'en', group: 'intl' },
  { id: 'androidauthority', name: 'Android Authority', url: 'https://www.androidauthority.com/feed/', lang: 'en', group: 'intl' },
  { id: '9to5mac', name: '9to5Mac', url: 'https://9to5mac.com/feed/', lang: 'en', group: 'intl' },
  { id: 'macrumors', name: 'MacRumors', url: 'https://feeds.macrumors.com/MacRumors-All', lang: 'en', group: 'intl' },
  { id: 'xda', name: 'XDA Developers', url: 'https://www.xda-developers.com/feed/', lang: 'en', group: 'intl' },

  // ---------------- 前沿 / 科学 ----------------
  { id: 'ieeespectrum', name: 'IEEE Spectrum', url: 'https://spectrum.ieee.org/feeds/feed.rss', lang: 'en', group: 'intl' },

  // ---------------- 备用：探测未通过，默认停用 ----------------
  { id: '36kr', name: '36氪', url: 'https://36kr.com/feed', lang: 'zh', group: 'cn', enabled: false, note: 'RSS 已失效，返回 HTML' },
  { id: 'pingwest', name: '品玩', url: 'https://www.pingwest.com/feed', lang: 'zh', group: 'cn', enabled: false, note: 'RSS 已失效' },
];

/**
 * 分类规则
 *
 * 匹配策略（见 scripts/util.mjs）：
 *   1. 先只试「具体词」（长度 ≥ 4 的长短语），无命中再试短词/泛词
 *   2. 同轮内先比关键词长度，再比 priority（数字小的优先），最后按配置顺序
 *
 * priority 用于解决长度相同的语义冲突，例如标题「某平台被曝数据泄露漏洞」中
 * 「平台」（互联网商业，泛词）与「漏洞」（安全隐私，具体）都是 2 字。
 * 数字越小越优先，不写默认按数组顺序。
 * keywords 支持中英文混排，匹配标题 + 摘要。
 */
export const categories = [
  {
    id: 'chip',
    label: '芯片硬件',
    emoji: '🔧',
    color: '#f59e0b',
    priority: 0,
    keywords: [
      '芯片', '半导体', '晶圆', '光刻', '制程', '代工', '台积电', '三星电子', '中芯国际',
      '处理器', '显卡', '内存', '闪存', '固态硬盘', '主板', '散热', '晶体管',
      'chip', 'semiconductor', 'wafer', 'lithograph', 'gpu', 'cpu', 'tsmc', 'nvidia',
      'amd', 'intel', 'qualcomm', 'arm ', 'risc-v', 'foundry', 'hbm', 'ddr',
    ],
  },
  {
    id: 'ai',
    label: 'AI 人工智能',
    emoji: '🤖',
    color: '#8b5cf6',
    priority: 1,
    keywords: [
      '人工智能', '大模型', '大语言模型', '生成式', '机器人', '深度学习', '机器学习',
      '神经网络', '智能体', '算力', '算法', '训练数据', '多模态', '语音识别', '计算机视觉',
      'ai', 'a.i.', 'llm', 'gpt', 'chatgpt', 'claude', 'gemini', 'deepseek', 'copilot',
      'openai', 'anthropic', 'midjourney', 'stable diffusion', 'agent', 'transformer',
      'machine learning', 'neural', 'inference',
    ],
  },
  {
    id: 'phone',
    label: '手机数码',
    emoji: '📱',
    color: '#3b82f6',
    priority: 3,
    keywords: [
      '手机', '智能手机', '折叠屏', '鸿蒙', '安卓', '苹果', '华为', '小米', 'redmi', '红米',
      'oppo', 'vivo', '荣耀', '一加', 'realme', '魅族', '努比亚', '中兴', '传音',
      'iphone', 'ipad', 'pixel', 'galaxy', 'android', 'ios', 'smartphone', 'foldable',
      'snapdragon', 'dimensity', '天玑', '骁龙', '灵动岛', '充电',
    ],
  },
  {
    id: 'pc',
    label: '电脑办公',
    emoji: '💻',
    color: '#06b6d4',
    priority: 4,
    keywords: [
      '笔记本', '电脑', '台式机', '一体机', '显示器', '键盘', '鼠标', '外设', '办公软件',
      'windows', 'macos', 'linux', 'macbook', 'thinkpad', 'rog', 'laptop', 'notebook',
      'desktop', 'monitor', 'ryzen', '酷睿', '锐龙', 'chromebook', 'surface',
    ],
  },
  {
    id: 'ai-hardware',
    label: '智能硬件',
    emoji: '⌚',
    color: '#14b8a6',
    priority: 5,
    keywords: [
      '耳机', '音箱', '手表', '手环', '眼镜', 'vr', 'ar', 'xr', '头显', '智能家居',
      '无人机', '扫地机器人', '相机', '镜头', '拍摄', '穿戴', 'vision pro', 'quest',
      'airpods', 'earbuds', 'smartwatch', 'wearable', 'drone', 'camera', 'gopro',
    ],
  },
  {
    id: 'game',
    label: '游戏娱乐',
    emoji: '🎮',
    color: '#ec4899',
    priority: 7,
    keywords: [
      '游戏', '主机', '手游', '电竞', 'switch', 'playstation', 'xbox', 'steam', '任天堂',
      '索尼', '育碧', '米哈游', '原神', '王者荣耀', 'nintendo', 'nintendo switch',
      'game pass', 'gameplay', 'esports', 'console', 'gta', 'minecraft',
    ],
  },
  {
    id: 'auto',
    label: '汽车出行',
    emoji: '🚗',
    color: '#22c55e',
    priority: 6,
    keywords: [
      '汽车', '新能源车', '电动车', '智能驾驶', '自动驾驶', '特斯拉', '比亚迪', '蔚来',
      '小鹏', '理想汽车', '问界', '充电桩', '电池', '固态电池', '续航',
      'tesla', 'ev ', 'electric vehicle', 'autonomous driving', 'battery', 'rivian',
      'lucid', 'waymo', 'robotaxi',
    ],
  },
  {
    id: 'web',
    label: '互联网商业',
    emoji: '🌐',
    color: '#f97316',
    priority: 9,
    keywords: [
      '互联网', '电商', '平台', '融资', '上市', '收购', '财报', '营收', '裁员', '反垄断',
      '字节', '腾讯', '阿里', '百度', '京东', '拼多多', '美团', '网易', '快手', '哔哩哔哩',
      'tiktok', 'bytedance', 'alibaba', 'tencent', 'startup', 'funding', 'ipo',
      'acquisition', 'layoff', 'antitrust', 'revenue', 'earnings', 'subscription',
    ],
  },
  {
    id: 'security',
    label: '安全隐私',
    emoji: '🛡️',
    color: '#ef4444',
    priority: 2,
    keywords: [
      '安全', '漏洞', '黑客', '攻击', '泄露', '隐私', '勒索', '木马', '钓鱼', '加密',
      'security', 'vulnerability', 'hack', 'breach', 'malware', 'ransomware', 'privacy',
      'encryption', 'zero-day', 'exploit', 'cve-',
    ],
  },
  {
    id: 'science',
    label: '前沿科学',
    emoji: '🔬',
    color: '#0ea5e9',
    priority: 8,
    keywords: [
      '航天', '火箭', '卫星', '空间站', '月球', '火星', '量子', '核聚变', '生物科技',
      '基因', '脑机接口', '材料', '电池技术', 'spacex', 'nasa', 'rocket', 'satellite',
      'quantum', 'fusion', 'biotech', 'gene', 'neuralink', 'physics', 'telescope',
    ],
  },
];

/** 未命中任何分类时的兜底 */
export const fallbackCategory = { id: 'other', label: '其他动态', emoji: '📰', color: '#64748b' };

/** 分类组合并的展示名（用于「按来源分组」之外的主题分组） */
export const categoryGroups = [
  { label: 'AI 与算力', ids: ['ai', 'chip'] },
  { label: '终端设备', ids: ['phone', 'pc', 'ai-hardware'] },
  { label: '互联网与安全', ids: ['web', 'security'] },
  { label: '出行与科学', ids: ['auto', 'science'] },
  { label: '游戏与其他', ids: ['game', 'other'] },
];
