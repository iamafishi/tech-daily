# 📡 科技数码日报 · Tech Daily

每日自动抓取中英科技数码圈资讯，聚合成一个**纯静态网站**：分类聚合、关键词搜索、来源筛选、日历归档、每日 AI 摘要。

- **零依赖**：构建与前端都不需要任何第三方 npm 包，只用 Node 内置能力
- **零成本**：GitHub Actions 定时构建 + GitHub Pages 托管，不需要服务器和数据库
- **不丢数据**：每天的内容以 JSON 快照归档进仓库，可回看任意历史日期
- **优雅降级**：没有 AI API Key 时自动退化为规则式要点，站点照常更新

---

## 目录

- [快速开始](#快速开始)
- [部署到 GitHub Pages（实现每日自动更新）](#部署到-github-pages实现每日自动更新)
- [配置 AI 每日摘要](#配置-ai-每日摘要)
- [增删信息源 / 调整分类](#增删信息源--调整分类)
- [项目结构](#项目结构)
- [数据格式](#数据格式)
- [测试与质量校验](#测试与质量校验)
- [常见问题](#常见问题)

---

## 快速开始

需要 Node.js 20 或更高版本（无其他依赖，不需要 `npm install`）。

```bash
cd tech-daily

npm run build     # 抓取所有源并生成 data/
npm run serve     # 启动本地预览： http://127.0.0.1:4321
```

只跑了 `serve` 而没跑 `build` 的话，页面会提示找不到 `data/index.json`。

其他常用命令：

```bash
npm run check         # 校验生成的 JSON 是否自洽、数据是否新鲜
npm test              # 跑完四套测试（数据自检 + 解析层 + UI 逻辑 + 样式/部署配置）
npm run build:summary # 强制重算摘要（例如刚刚配好了 AI Key）
node scripts/build.mjs --only=ithome,sspai   # 只抓指定源，便于调试
```

---

## 部署到 GitHub Pages（实现每日自动更新）

### 1. 推送到 GitHub

```bash
cd tech-daily
git init
git add .
git commit -m "feat: 科技数码日报"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 开启 Pages

打开仓库 **Settings → Pages**，把 **Source** 设为 **GitHub Actions**。

> 工作流里 `configure-pages` 带了 `enablement: true`，通常会自动帮你开启；
> 如果仓库策略不允许自动开启，手动设一下即可。

### 3. 确认工作流权限

**Settings → Actions → General → Workflow permissions** 选择
**Read and write permissions**（工作流需要把每日数据提交回仓库）。

### 4. 完成

工作流（`.github/workflows/daily.yml`）会在以下时机运行：

| 触发 | 时机 |
| --- | --- |
| 定时 | 每天 `22:10 UTC`，即**北京时间次日 06:10** |
| 手动 | 仓库 **Actions → 每日构建并发布 → Run workflow** |
| 推送 | 改动了 `app.js` / `styles.css` / `config/` 等文件推送到 main 后 |

站点地址是 `https://<你的用户名>.github.io/<仓库名>/`。
首次运行约 1 分钟；之后每天早上内容自动更新。

> **想改时间**：编辑 `daily.yml` 里的 `cron: '10 22 * * *'`（cron 使用 UTC，北京时间 = UTC + 8）。
> 例如 `'0 1 * * *'` = 北京时间每天 09:00。

---

## 配置 AI 每日摘要

不配置也能用 —— 摘要会退化成「规则式要点」（按分类挑重点标题）。

要启用 AI 综述，任选一个变量名加到仓库密钥里：

**Settings → Secrets and variables → Actions → New repository secret**

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | ✅ | 任意 OpenAI 兼容接口的 Key（DeepSeek、OpenAI、通义、Kimi…） |
| `AI_BASE_URL` | ⬜ | 默认 `https://api.deepseek.com/v1`，换服务商时填（放在 **Variables** 里） |
| `AI_MODEL` | ⬜ | 默认 `deepseek-chat`（放在 **Variables** 里） |

`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 也会被识别，用哪个名字都行。

常见服务商配置：

```
DeepSeek   AI_BASE_URL=https://api.deepseek.com/v1      AI_MODEL=deepseek-chat
OpenAI     AI_BASE_URL=https://api.openai.com/v1        AI_MODEL=gpt-4o-mini
通义千问    AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1   AI_MODEL=qwen-plus
月之暗面    AI_BASE_URL=https://api.moonshot.cn/v1       AI_MODEL=moonshot-v1-8k
```

**摘要永不阻塞更新**：调用失败、超时、返回内容解析不了 —— 一律自动降级为规则式要点，
构建仍然成功，站点仍然更新。已经生成过的 AI 摘要会被缓存复用，不会重复花钱。

### 让已归档的日期也用上 AI 综述

摘要生成后会缓存进快照，所以**刚配好 Key 时历史日期仍显示旧的「规则式要点」**，
只有新的一天才会自动用 AI。要把历史日期一并升级，手动跑一次强制重算：

**Actions → 每日构建并发布 → Run workflow → 勾选 `force_summary` → Run**

本地等价命令：

```bash
npm run build:summary          # 等价于 node scripts/build.mjs --with-summary
```

构建日志会打印「摘要模式」一行，用来确认开关是否真的生效：

```
摘要模式：强制重算全部归档日期
摘要模式：仅新增内容生成，已有摘要复用缓存（加 --with-summary 可强制重算）
```

> ⚠️ `force_summary` 只在手动触发时可用，且每次都会对所有归档日期重新调用 API。
> 归档较长（例如接近 180 天）时会产生相应的 token 费用。

> 实现细节：`FORCE_SUMMARY` 用真值判断（`1`/`true`/`yes`/`on`）而不是「环境变量存在即真」——
> 未勾选时传入的字符串是 `"false"`，定时触发时是空字符串，按存在性判断会导致
> **每天重算全部摘要、白白烧 token**。这一点有测试守着。

---

## 增删信息源 / 调整分类

全部集中在 [`config/sources.mjs`](config/sources.mjs)，改完直接提交即可。

**加一个源**：在 `sources` 数组里加一行：

```js
{ id: 'mynews', name: '我的源', url: 'https://example.com/feed.xml', lang: 'zh', group: 'cn' },
```

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一英文标识，会出现在筛选器与 URL 里 |
| `name` | 展示名 |
| `url` | RSS / Atom 地址 |
| `lang` | `zh` 或 `en`（英文源会显示 `EN` 角标） |
| `group` | `cn` 中文源 / `intl` 国际源 |
| `enabled` | 设为 `false` 可临时停用（探测失败的源已经这样处理） |

**改抓取窗口**：`build.windowHours`（默认 72 小时）。
**改归档时长**：`build.retentionDays`（默认 180 天，超期快照会自动删除）。
**防单一源刷屏**：`build.perSourceLimit`（默认每源每分类每天 25 条）。

**调分类**：修改 `categories` 数组里的 `keywords`，以及可选的 `priority`。

分类判定不是「按分类顺序命中即停」，而是：

1. 先只试**具体词**（长度 ≥ 4 的长短语，如「数据泄露」「半导体」）
2. 没命中才试短词/泛词（如「平台」「芯片」）
3. 同一轮内依次比较：关键词长度 → `priority`（数字小的优先）→ 配置顺序

`priority` 用来解决长度相同的语义冲突。例如标题「某平台被曝数据泄露漏洞」里，
「平台」（互联网商业，泛词）和「漏洞」（安全隐私，具体）都是 2 字，
靠长度分不出胜负，于是由 priority 决定（安全隐私=2 胜 互联网商业=9）。

英文关键词按单词边界匹配，所以 `arm` 不会误命中 `warm`。

---

## 项目结构

```
tech-daily/
├── index.html                 站点外壳（纯静态，无框架）
├── app.js                     前端全部逻辑（原生 ES 模块，无构建步骤）
├── styles.css                 深浅双主题 + 响应式样式
├── package.json               只有 scripts，没有任何依赖
├── config/
│   └── sources.mjs            ⭐ 信息源清单 + 分类关键词（日常只需要改这个文件）
├── scripts/
│   ├── build.mjs              构建主流程：抓取 → 去重 → 归档 → 摘要 → 出数据
│   ├── rss.mjs                零依赖 RSS 2.0 / Atom / RDF 解析器
│   ├── dedupe.mjs             三级去重（URL / 标题指纹 / 相似度，均受时间窗约束）
│   ├── util.mjs               分类判定、分词、相似度、时区日期工具
│   ├── ai.mjs                 AI 摘要（OpenAI 兼容）+ 规则式降级
│   ├── check.mjs              数据自检（CI 会跑）
│   ├── test-parse.mjs         解析层测试（101 项，离线）
│   ├── test-ui.mjs            UI 逻辑测试（98 项，内置 DOM 仿真，无需浏览器）
│   ├── test-assets.mjs        样式与结构检查（32 项）
│   ├── test-deploy.mjs        部署配置校验（46 项）
│   ├── e2e.mjs                真实浏览器验证（可选，需要 Chrome/Edge）
│   └── serve.mjs              本地预览服务器
├── data/                      ⭐ 构建产物，由工作流自动提交
│   ├── index.json             站点索引：每天条目数、分类、源健康度
│   ├── search.json            全量搜索索引（精简字段）
│   └── days/YYYY-MM-DD.json   每日快照（含当日摘要与全部条目）
└── .github/workflows/daily.yml  定时构建 + Pages 部署
```

### 数据流

```
17 个 RSS 源
   │  并发抓取（8 路并发，20s 超时，失败重试 1 次）
   ▼
RSS/Atom 解析 → 时间归一化（UTC+8 切日）→ 窗口过滤
   │
   ▼
关键词分类 → 三级去重（时间窗 36h）→ 单源配额
   │
   ▼
与历史归档合并（历史优先，保留已生成的摘要）
   │
   ▼
AI 摘要（有 Key）/ 规则式要点（降级）
   │
   ▼
data/*.json  →  纯静态前端直接消费
```

---

## 数据格式

### `data/index.json`

```jsonc
{
  "generatedAt": "2026-09-30T04:39:53.094Z",
  "timezoneOffsetMinutes": 480,        // 展示时区（UTC+8）
  "buildMs": 5000,
  "site": { "title": "科技数码日报", "subtitle": "..." },
  "totals": { "items": 582, "days": 4, "sources": 17, "sourcesOk": 17, "freshItems": 580 },
  "categories": [{ "id": "ai", "label": "AI 人工智能", "emoji": "🤖", "color": "#8b5cf6" }],
  "sources": [
    { "id": "ithome", "name": "IT之家", "ok": true, "itemCount": 60, "ms": 4936, "error": null }
  ],
  "days": [
    { "date": "2026-09-30", "label": "9月30日 周三", "itemCount": 223, "aiSummary": false }
  ]
}
```

### `data/days/YYYY-MM-DD.json`

```jsonc
{
  "date": "2026-09-30",
  "label": "9月30日 周三",
  "itemCount": 223,
  "summary": {
    "mode": "ai",                    // "ai" 或 "heuristic"
    "overview": "150-260 字的中文综述…",
    "highlights": [{ "label": "AI 人工智能", "emoji": "🤖", "texts": ["要点一", "要点二"] }]
  },
  "categoryStats": [{ "id": "ai", "count": 72, "label": "AI 人工智能", "emoji": "🤖" }],
  "items": [
    {
      "id": "k3f9a2b1c4",
      "title": "英伟达发布新一代 AI 芯片",
      "link": "https://…",
      "sourceName": "IT之家",
      "sourceLang": "zh",
      "category": "chip",
      "description": "纯文本摘要（≤300 字）",
      "image": "https://… 或 null",
      "publishedAt": "2026-09-30T02:11:00.000Z",
      "day": "2026-09-30",
      "duplicates": [{ "sourceName": "The Verge", "link": "https://…" }],
      "sameSourceDupes": 2
    }
  ]
}
```

所有数据都是公开只读的 JSON，可以直接拿去二次开发（做机器人、周报、RSS 输出等）。

---

## 测试与质量校验

```bash
npm test            # 一次跑完下面五套（共约 300 项断言）
npm run check       # 数据自检：结构、链接、id 唯一性、条数一致性、新鲜度
npm run test:parse  # 解析层：101 项，纯函数、不联网
npm run test:ui     # UI 逻辑：98 项，内置 DOM 仿真、不需要浏览器
npm run test:assets # 样式与结构：32 项，括号配平、变量、类名、可访问性、安全
npm run test:deploy # 部署配置：46 项，工作流结构、权限、cron、打包目录
npm run test:http   # 可达性：18 项，真实起服后逐个请求所有资源
```

CI（GitHub Actions）在每次构建后会自动跑 `npm run check`；本地改动建议跑一次 `npm test`。

**`test:parse`** 覆盖抓取层最容易出错的地方，且全部离线：

- HTML 转纯文本：转义 HTML（`&lt;p&gt;`）必须剥净、双重转义、幂等性、script/style 丢弃
- 时间解析：RFC822 / ISO8601 / 带时区 / 无时区（强制按 UTC）/ 时间戳 / 两位年份
- 链接归一化：utm 等跟踪参数、www 前缀、尾斜杠、锚点，且不能误合并不同内容
- RSS 与 Atom 解析、CDATA、`media:content`、转义 HTML 里的配图提取
- 分类判定（含具体词优先、单词边界）、分词、相似度、UTC+8 切日

**`test:ui`** 不需要浏览器：它解析真实的 `index.html` 构建元素树、读取真实的 `data/*.json`，
然后**执行真实的 `app.js`**，逐项断言渲染结果与交互行为：

- 首屏渲染、卡片数 = 数据条数、分类分组、日历、筛选器、源健康面板
- 分类筛选（点击 → 仅看 → 再点变排除）、来源筛选、清除筛选
- 关键词搜索（中英文、无结果空状态、高亮转义、不误匹配来源名）、搜索与筛选叠加
- 历史归档切换、URL 参数同步、加载更早、随机翻页、回到最新
- 主题切换与持久化、移动端抽屉、已读状态持久化
- 去重算法回归（URL 变体、标点差异、相似标题、时间窗边界、误合并防护）

**`test:deploy`** 校验工作流本身：cron 合法性、权限声明、产物目录与打包目录一致、
归档只提交 `data/`、部署任务依赖与 environment 等。

**`test:http`** 真实启动本地服务器，逐个请求 `index.html`、`app.js`、`styles.css`、
`data/index.json`、`data/search.json` 与每个每日归档，校验状态码、Content-Type、JSON 可解析，
并确认所有条目链接都是合法的 http(s)。

如果本机装有 Chrome 或 Edge，还可以跑真实浏览器验证（会输出截图）：

```bash
npm run serve            # 另开一个终端
npm run test:browser     # 截图输出到 .preview/
```

> 注：在受限沙箱环境中浏览器渲染进程可能无法启动，此时 `test:browser` 会失败，
> 用 `npm run test:ui` 即可 —— 它不依赖渲染进程。

---

## 常见问题

**页面打开是空白 / 提示找不到 `data/index.json`**
先跑 `npm run build`。如果是从 GitHub 拉下来的仓库，`data/` 应该已经存在；
若为空，手动触发一次 Actions。

**某个源一直抓不到内容**
看侧栏「数据源状态」里的红点，或 `data/index.json` 的 `sources[].error`。
常见原因是站点下线了 RSS（例如 36氪、品玩已经失效，配置里已默认停用）。
直接在 `config/sources.mjs` 里加 `enabled: false` 停用即可。

**站点没有自动更新**
1. 检查 Actions 页面是否有失败记录（仓库超过 60 天无活动时 GitHub 会暂停定时任务）
2. 确认 **Settings → Actions → General** 的 Workflow permissions 是 Read and write
3. 确认 **Settings → Pages** 的 Source 是 GitHub Actions

**想发布到自己的服务器或 Cloudflare Pages**
整个站点是纯静态的：把 `index.html`、`app.js`、`styles.css`、`data/` 四个东西传上去就行。
也可以把 `npm run build` 加进任何 CI，或在本机用「任务计划程序」每天跑一次。

**归档数据会不会让仓库变得很大**
每天约 100–350 KB（含当天全部条目），180 天滚动保留后稳定在 20–60 MB 量级。
想减小可以把 `retentionDays` 调低（例如 60），或把 `data/` 改成发布到独立分支。

**抓取是否合法**
全部只读取各媒体公开的 RSS/Atom 输出，不抓正文、不绕过任何限制，
每条内容都保留原始链接并引导回原站。请遵守各来源的使用条款。

---

## 许可

本仓库代码可自由使用。聚合内容的版权归各原始媒体所有。
