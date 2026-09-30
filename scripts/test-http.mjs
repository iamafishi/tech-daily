/** 静态可达性检查：启动本地服务器，逐个请求页面引用的资源 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4399;
const node = process.execPath;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(node, [path.join(ROOT, 'scripts', 'serve.mjs'), String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 等服务器就绪
  let ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      ready = r.ok;
    } catch { /* 继续等 */ }
    if (!ready) await sleep(200);
  }
  check('本地服务器可启动', ready);
  if (!ready) throw new Error('服务器未就绪');

  const index = JSON.parse(await readFile(path.join(ROOT, 'data', 'index.json'), 'utf8'));

  const targets = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/app.js', 'javascript'],
    ['/styles.css', 'text/css'],
    ['/data/index.json', 'json'],
    ['/data/search.json', 'json'],
    ...index.days.map((d) => [`/data/days/${d.date}.json`, 'json']),
  ];

  for (const [url, expectType] of targets) {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`);
    const body = await res.text();
    const ctype = res.headers.get('content-type') || '';
    let ok = res.ok && ctype.includes(expectType) && body.length > 0;
    // JSON 还要能被解析
    if (ok && expectType === 'json') {
      try {
        JSON.parse(body);
      } catch {
        ok = false;
      }
    }
    check(`${url} 可访问且类型正确`, ok, `${res.status} ${ctype.split(';')[0]} ${body.length}B`);
  }

  // 校验 HTML 里引用的本地资源都真实存在
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    const res = await fetch(`http://127.0.0.1:${PORT}/${ref.replace(/^\.\//, '')}`);
    check(`页面引用的 ${ref} 存在`, res.ok, String(res.status));
  }

  // 校验每日文件内部引用的所有链接都是合法 http(s)
  let badLinks = 0;
  for (const d of index.days) {
    const day = JSON.parse(await readFile(path.join(ROOT, 'data', 'days', `${d.date}.json`), 'utf8'));
    badLinks += day.items.filter((i) => !/^https?:\/\//.test(i.link)).length;
  }
  check('所有条目链接均为 http(s)', badLinks === 0, `${badLinks} 个异常`);

  // 搜索索引里的链接同样要合法
  const search = JSON.parse(await readFile(path.join(ROOT, 'data', 'search.json'), 'utf8'));
  const badSearchLinks = search.items.filter((i) => !/^https?:\/\//.test(i.u)).length;
  check('搜索索引链接均为 http(s)', badSearchLinks === 0, `${badSearchLinks} 个异常`);

  const page = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  check('页面包含应用挂载点', page.includes('id="feed"') && page.includes('app.js'));
  check('页面标题正确', /<title>[^<]*科技数码日报[^<]*<\/title>/.test(page));
} catch (err) {
  check('可达性检查执行完成', false, err.message);
} finally {
  server.kill();
  await sleep(300);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(60)}`);
console.log(`可达性检查：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log('✓ 全部通过');
