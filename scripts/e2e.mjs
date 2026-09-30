/**
 * 端到端浏览器验证（通过 Chrome DevTools Protocol，仅用 node 内置能力）
 *
 *   node scripts/e2e.mjs [siteUrl] [outDir]
 *
 * 覆盖：首屏渲染、卡片数量、摘要卡片、分类分组、日历、来源筛选、
 *       关键词搜索、历史日期切换、控制台报错、截图。
 * 退出码非 0 表示存在失败项。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.argv[2] || 'http://127.0.0.1:4321/';
const OUT = path.resolve(process.argv[3] || path.join(ROOT, '.preview'));
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

async function waitForDevtools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error('DevTools 端口未就绪');
}

/* ── 极简 CDP 客户端 ── */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    this.failedRequests = [];
    ws.addEventListener('message', async (event) => {
      let raw = event.data;
      // node 内置 WebSocket 在未指定 binaryType 时会把文本帧给成 Blob
      if (raw && typeof raw !== 'string') {
        if (typeof raw.text === 'function') raw = await raw.text();
        else if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
        else raw = String(raw);
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
      }
      if (msg.method === 'Network.loadingFailed') {
        this.failedRequests.push(msg.params.errorText);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 60000);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`WebSocket 失败: ${e?.message || e?.type}`)), { once: true });
    });
    return new CDP(ws);
  }
}

/* ── 页面操作辅助 ── */
async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`求值异常: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

async function waitFor(cdp, expression, { timeout = 12000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return true;
    } catch { /* 重试 */ }
    await sleep(250);
  }
  throw new Error(`等待超时: ${label}`);
}

async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

/* ── 主流程 ── */
async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error('未找到 Chrome/Edge');
  await mkdir(OUT, { recursive: true });

  const profile = path.join(os.tmpdir(), `techdaily-e2e-${Date.now()}`);
  console.log(`浏览器: ${browser}`);
  console.log(`站点:   ${SITE}\n`);

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }
  );

  let cdp;
  try {
    await waitForDevtools(DEBUG_PORT);

    // 开新标签页
    const tabRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const tab = await tabRes.json();
    cdp = await CDP.connect(tab.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    console.log('— 首屏渲染 —');
    await cdp.send('Page.navigate', { url: SITE });
    await waitFor(cdp, "document.querySelectorAll('.card').length > 0", { label: '卡片出现' });
    await sleep(700);

    const stats = await evaluate(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('.card')];
        return {
          cards: cards.length,
          groups: document.querySelectorAll('.group-head').length,
          digestVisible: !document.getElementById('digest').hidden,
          digestText: (document.querySelector('.digest-overview')?.textContent || '').slice(0, 60),
          digestBlocks: document.querySelectorAll('.digest-block').length,
          dayTitle: document.getElementById('day-title').textContent,
          dayMeta: document.getElementById('day-meta').textContent,
          calCells: document.querySelectorAll('.cal-cell.has-data').length,
          calSelected: document.querySelectorAll('.cal-cell.is-selected').length,
          catChips: document.querySelectorAll('#filter-categories .chip').length,
          srcChips: document.querySelectorAll('#filter-sources .chip').length,
          healthRows: document.querySelectorAll('.health-row').length,
          healthBad: document.querySelectorAll('.health-dot.bad').length,
          loadMoreVisible: !document.getElementById('load-more').hidden,
          withImages: document.querySelectorAll('.card-thumb img').length,
          withDupes: document.querySelectorAll('.dupes').length,
          theme: document.documentElement.dataset.theme,
          hasBalance: cards.every(c => c.querySelector('.card-title')?.textContent.trim().length > 0),
          titles: cards.slice(0,3).map(c => c.querySelector('.card-title').textContent.slice(0,40)),
        };
      })()`
    );

    check('卡片渲染成功', stats.cards > 20, `${stats.cards} 张卡片`);
    check('分类分组标题存在', stats.groups > 3, `${stats.groups} 个分组`);
    check('摘要卡片可见', stats.digestVisible && stats.digestText.length > 10, stats.digestText + '…');
    check('摘要要点区块存在', stats.digestBlocks >= 1, `${stats.digestBlocks} 个区块`);
    check('日期标题与统计正确', /条/.test(stats.dayMeta), `${stats.dayTitle} / ${stats.dayMeta}`);
    check('日历标记有数据的日期', stats.calCells >= 1, `${stats.calCells} 天可选`);
    check('日历高亮当前日期', stats.calSelected === 1);
    check('分类筛选项渲染', stats.catChips >= 8, `${stats.catChips} 个分类`);
    check('来源筛选项渲染', stats.srcChips >= 10, `${stats.srcChips} 个来源`);
    check('数据源健康面板渲染', stats.healthRows >= 10, `${stats.healthRows} 行 / ${stats.healthBad} 个失败`);
    check('卡片标题非空', stats.hasBalance);
    check('配图渲染', stats.withImages > 0, `${stats.withImages} 张配图`);

    await shot(cdp, path.join(OUT, '01-home.png'));

    console.log('\n— 分类筛选 —');
    const firstCat = await evaluate(
      cdp,
      `(() => {
        const chip = document.querySelector('#filter-categories .chip');
        const label = chip.textContent;
        chip.click();
        return label;
      })()`
    );
    await sleep(500);
    const afterFilter = await evaluate(
      cdp,
      `({
        cards: document.querySelectorAll('.card').length,
        activeBar: !document.getElementById('active-filters').hidden,
        barText: document.getElementById('active-filters').textContent.slice(0, 50),
      })`
    );
    check('点击分类后条目减少', afterFilter.cards > 0, `筛选「${firstCat}」→ ${afterFilter.cards} 张卡片`);
    check('生效筛选提示出现', afterFilter.activeBar, afterFilter.barText);

    // 清除筛选
    await evaluate(cdp, `document.querySelector('#active-filters .clear-all').click()`);
    await sleep(400);
    const afterClear = await evaluate(cdp, `document.querySelectorAll('.card').length`);
    check('清除筛选后恢复', afterClear === stats.cards, `${afterClear} 张卡片`);

    console.log('\n— 来源筛选 —');
    const srcFilter = await evaluate(
      cdp,
      `(() => {
        const chips = [...document.querySelectorAll('#filter-sources .chip')];
        const chip = chips.find(c => c.querySelector('.n')?.textContent !== '0') || chips[0];
        const label = chip.textContent;
        chip.click();
        return label;
      })()`
    );
    await sleep(500);
    const srcCards = await evaluate(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('.card')];
        return { n: cards.length, sources: [...new Set(cards.map(c => c.querySelector('.src-tag').textContent))] };
      })()`
    );
    check(
      '来源筛选仅保留单一来源',
      srcCards.sources.length === 1,
      `筛选「${srcFilter}」→ ${srcCards.n} 张卡片，来源: ${srcCards.sources.join(',')}`
    );
    await evaluate(cdp, `document.querySelector('#active-filters .clear-all').click()`);
    await sleep(300);

    console.log('\n— 关键词搜索 —');
    const searchTerm = 'AI';
    await evaluate(
      cdp,
      `(() => {
        const input = document.getElementById('search');
        input.value = ${JSON.stringify(searchTerm)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
    await waitFor(cdp, `!!document.querySelector('.group-head h2')?.textContent.includes('搜索')`, {
      label: '搜索结果标题',
    });
    await sleep(500);
    const searchState = await evaluate(
      cdp,
      `(() => {
        const cards = [...document.querySelectorAll('.card')];
        return {
          n: cards.length,
          heading: document.querySelector('.group-head h2')?.textContent || '',
          marks: document.querySelectorAll('mark.hl').length,
          allMatch: cards.every(c => c.textContent.toLowerCase().includes(${JSON.stringify(searchTerm.toLowerCase())})),
          hasDayTag: cards.some(c => c.querySelectorAll('.src-tag').length >= 2),
          xss: document.querySelectorAll('script:not([src])').length,
        };
      })()`
    );
    check('搜索返回结果', searchState.n > 0, `关键词「${searchTerm}」→ ${searchState.n} 条`);
    check('搜索标题显示关键词', searchState.heading.includes(searchTerm), searchState.heading);
    check('命中关键词高亮', searchState.marks > 0, `${searchState.marks} 处高亮`);
    check('搜索结果全部匹配关键词', searchState.allMatch);
    check('搜索结果标注归档日期', searchState.hasDayTag);
    await shot(cdp, path.join(OUT, '02-search.png'));

    await evaluate(cdp, `document.getElementById('search-clear').click()`);
    await sleep(400);

    console.log('\n— 历史归档切换 —');
    const beforeDay = await evaluate(cdp, `document.getElementById('day-meta').textContent`);
    await evaluate(
      cdp,
      `[...document.querySelectorAll('.cal-cell.has-data')].find(c => !c.classList.contains('is-selected')).click()`
    );
    await sleep(1200);
    const afterDay = await evaluate(
      cdp,
      `({
        meta: document.getElementById('day-meta').textContent,
        cards: document.querySelectorAll('.card').length,
        archivedTab: !document.getElementById('tab-archived').hidden,
        digest: !document.getElementById('digest').hidden,
      })`
    );
    check('切换到历史日期', afterDay.meta !== beforeDay, `${beforeDay.split('·')[0].trim()} → ${afterDay.meta.split('·')[0].trim()}`);
    check('历史日期渲染条目', afterDay.cards > 0, `${afterDay.cards} 条`);
    check('历史日期有独立摘要', afterDay.digest);
    await shot(cdp, path.join(OUT, '03-archive.png'));

    console.log('\n— 回到最新 + 主题切换 —');
    await evaluate(cdp, `document.getElementById('btn-latest').click()`);
    await sleep(900);
    const backLatest = await evaluate(cdp, `document.getElementById('day-meta').textContent`);
    check('回到最新一天', /最新/.test(backLatest), backLatest);

    await evaluate(cdp, `document.getElementById('btn-theme').click()`);
    await sleep(300);
    const themeAfter = await evaluate(cdp, `document.documentElement.dataset.theme`);
    check('主题切换生效', themeAfter === 'light', `主题 = ${themeAfter}`);
    await shot(cdp, path.join(OUT, '04-light.png'));
    await evaluate(cdp, `document.getElementById('btn-theme').click()`);

    console.log('\n— 移动端布局 —');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(600);
    const mobile = await evaluate(
      cdp,
      `(() => {
        const sb = document.getElementById('sidebar');
        const openBefore = sb.classList.contains('open');
        document.getElementById('btn-sidebar').click();
        const openAfter = sb.classList.contains('open');
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 2;
        return { openBefore, openAfter, overflow, sidebarBtnVisible: getComputedStyle(document.getElementById('btn-sidebar')).display !== 'none' };
      })()`
    );
    check('移动端显示菜单按钮', mobile.sidebarBtnVisible);
    check('移动端侧栏抽屉可开合', mobile.openAfter && !mobile.openBefore);
    check('移动端无横向溢出', !mobile.overflow);
    await sleep(400);
    await shot(cdp, path.join(OUT, '05-mobile.png'));
    await evaluate(cdp, `document.getElementById('scrim').click()`);

    console.log('\n— 控制台与网络健康 —');
    check('无未捕获 JS 异常', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 2).join(' | '));
    check('无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 2).join(' | '));
    const realFailures = cdp.failedRequests.filter((t) => !/aborted|net::ERR_ABORTED/i.test(t));
    check('无资源加载失败', realFailures.length === 0, realFailures.slice(0, 3).join(' | '));
  } finally {
    try {
      cdp?.ws.close();
    } catch { /* 忽略 */ }
    child.kill();
    await sleep(600);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`端到端验证：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('✓ 全部通过');
  console.log(`截图输出目录：${OUT}`);
}

main().catch((err) => {
  console.error('\n端到端验证异常终止：', err.message);
  process.exit(1);
});
