/**
 * 零依赖本地静态服务器，用于预览站点。
 *   node scripts/serve.mjs [port]
 * 仅监听 127.0.0.1，只读地服务仓库根目录下的文件。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

    const abs = path.join(ROOT, rel);
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let target = abs;
    try {
      const st = await stat(target);
      if (st.isDirectory()) target = path.join(target, 'index.html');
    } catch {
      // 单页应用回退
      target = path.join(ROOT, 'index.html');
    }

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
    console.log(`200 ${rel}`);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 ${err.message}`);
    console.log(`404 ${req.url}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tech-daily 预览： http://127.0.0.1:${PORT}`);
  console.log(`根目录： ${ROOT}`);
  console.log('按 Ctrl+C 停止');
});
